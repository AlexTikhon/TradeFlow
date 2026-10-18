import { onlineManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import type {
  ConfigureTradeStringRequest,
  CurrentUser,
  OrganizationRef,
  ProblemDetails,
  TradeString,
  VoyageDetail,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../../test/fixtures/auth';
import { emptyTimeline } from '../../../test/fixtures/timeline';
import {
  aTradeString,
  aVoyageDetail,
  anEmptyTradeString,
  tradeParties,
} from '../../../test/fixtures/voyages';
import { server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { sessionChangedElsewhere } from '../../auth/session';

/** Ana operates for Cerrado, the exporter: she sets the string up. */
const ana = aCurrentUser();
const anaAsViewer: CurrentUser = { ...ana, user: { ...ana.user, role: 'VIEWER' } };
/** Claire operates for Lacustra. */
const claire = anotherUser();

const cerrado = tradeParties.cerrado.organization;
const lacustra = tradeParties.lacustra.organization;
const nordlys = tradeParties.nordlys.organization;
const rhine = tradeParties.rhine.organization;

/** A voyage Ana has just created: planned, Cerrado its only participant, no contracts. */
const newVoyage = aVoyageDetail({
  id: '01990000-0000-7000-8006-000000000042',
  reference: 'TF-2026-0042',
  status: 'PLANNED',
  participants: [{ role: 'EXPORTER', organization: cerrado }],
});
const page = `/voyages/${newVoyage.id}`;

/** Every organization the fake search knows, Cerrado included (the API leaves it out). */
const directory: OrganizationRef[] = [cerrado, lacustra, nordlys, rhine];

interface SentSetup {
  body: ConfigureTradeStringRequest;
  ifMatch: string | null;
  ifNoneMatch: string | null;
}

/** Holds a response until `release()`. */
function aGate() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  return { gate, received, arrived, release };
}

/**
 * Serves the voyage page from the fake server's state, which tests change: every request answers
 * what it holds at that moment. Setup requests are answered by `respond`.
 */
function servePage({
  voyage = newVoyage,
  tradeString = anEmptyTradeString(),
  organizations = directory,
}: { voyage?: VoyageDetail; tradeString?: TradeString; organizations?: OrganizationRef[] } = {}) {
  const state = {
    voyage,
    tradeString,
    detailRequests: 0,
    tradeStringRequests: 0,
    searches: [] as string[],
    setups: [] as SentSetup[],
  };
  server.use(
    http.get(`*/api/voyages/${voyage.id}`, () => {
      state.detailRequests += 1;
      return HttpResponse.json(state.voyage);
    }),
    http.get(`*/api/voyages/${voyage.id}/trade-string`, () => {
      state.tradeStringRequests += 1;
      return HttpResponse.json(state.tradeString);
    }),
    http.get(`*/api/voyages/${voyage.id}/my-contracts`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${voyage.id}/notices`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${voyage.id}/documentary-instructions`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`*/api/voyages/${voyage.id}/documents`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${voyage.id}/timeline`, () => HttpResponse.json(emptyTimeline)),
    http.get('*/api/organizations', ({ request }) => {
      const search = new URL(request.url).searchParams.get('search') ?? '';
      state.searches.push(search);
      const items = organizations
        .filter(({ name }) => name.toLowerCase().includes(search.toLowerCase()))
        .filter(({ id }) => id !== cerrado.id)
        .slice(0, 20);
      return HttpResponse.json({ items });
    }),
  );
  return state;
}
type State = ReturnType<typeof servePage>;

/** Answers setups with `respond`; with `hold`, each answer waits for `release()`. */
function serveSetup(state: State, respond: (sent: SentSetup) => Response, { hold = false } = {}) {
  const { gate, received, arrived, release } = aGate();
  server.use(
    http.post(`*/api/voyages/${state.voyage.id}/trade-string`, async ({ request }) => {
      const sent: SentSetup = {
        body: (await request.json()) as ConfigureTradeStringRequest,
        ifMatch: request.headers.get('if-match'),
        ifNoneMatch: request.headers.get('if-none-match'),
      };
      state.setups.push(sent);
      arrived();
      if (hold) await gate;
      return respond(sent);
    }),
  );
  return { received, release };
}

/** What the real API does on success: records the chain, and the parties join the voyage. */
const recordChain = (state: State, chain: OrganizationRef[]) => () => {
  const parties = chain.map((organization, index) => ({
    organization,
    role:
      index === 0
        ? ('EXPORTER' as const)
        : index === chain.length - 1
          ? ('FINAL_BUYER' as const)
          : ('TRADER' as const),
  }));
  state.tradeString = aTradeString(parties);
  state.voyage = { ...state.voyage, participants: parties };
  return HttpResponse.json(state.tradeString);
};

const problem = (
  status: number,
  title: string,
  detail: string,
  errors?: ProblemDetails['errors'],
) =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title,
      status,
      detail,
      ...(errors && { errors }),
    } satisfies ProblemDetails,
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );

const ALREADY_SET_UP =
  "This voyage's trade string is already set up. It cannot be set up again or changed here.";

type Rendered = ReturnType<typeof renderRoute>;
type User = Rendered['user'];

const setupForm = () => screen.getByRole('form', { name: 'Set up the trade string' });
const chainRows = () =>
  within(
    screen.getByRole('list', { name: 'Organizations in the trade string, in order' }),
  ).getAllByRole('listitem');
const rowLabels = () => chainRows().map((row) => row.getAttribute('aria-label'));

async function openSetup(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Set up trade string' }));
  return setupForm();
}

/** Types `search` into the search field and adds the organization called `name`. */
async function addOrganization(user: User, search: string, name: string) {
  const field = screen.getByRole('textbox', { name: 'Find an organization' });
  await user.clear(field);
  await user.type(field, search);
  // The earlier search's results stay until this one answers: wait for the organization itself.
  await user.click(await screen.findByRole('button', { name: `Add ${name}` }));
}

/** Builds Cerrado → Lacustra → Rhine Valley and opens the review. */
async function reviewLacustraThenRhine(user: User) {
  await openSetup(user);
  await addOrganization(user, 'lac', lacustra.name);
  await addOrganization(user, 'rhine', rhine.name);
  await user.click(screen.getByRole('button', { name: 'Review the trade string' }));
  return screen.getByRole('region', { name: 'Review the trade string' });
}

const pendingMutations = (queryClient: Rendered['queryClient']) =>
  queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status === 'pending');

async function allAnswered(queryClient: Rendered['queryClient']) {
  await waitFor(() => {
    expect(pendingMutations(queryClient)).toEqual([]);
  });
}

const scopeOf = (identity: CurrentUser) => `${identity.user.id}:${identity.organization.id}`;

/** A voyage list in `identity`'s cache, as if the list page had been visited. */
const aCachedList = (queryClient: Rendered['queryClient'], identity: CurrentUser) => {
  const queryKey = ['protected', scopeOf(identity), 'voyages', 'list', {}];
  queryClient.setQueryData(queryKey, { items: [] });
  return () => queryClient.getQueryCache().find({ queryKey, exact: true });
};

async function signOut(user: User) {
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
}

async function signIn({ user, router }: Pick<Rendered, 'user' | 'router'>, identity: CurrentUser) {
  await user.type(await screen.findByLabelText(/Email/), identity.user.email);
  await user.type(screen.getByLabelText(/Password/), TEST_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText(identity.user.fullName)).toBeInTheDocument();
  await act(() => router.navigate(page));
}

async function aSessionCheckFinds(
  { session, queryClient }: Pick<Rendered, 'session' | 'queryClient'>,
  identity: CurrentUser,
) {
  session.current = identity;
  await act(() => queryClient.refetchQueries({ queryKey: ['session'] }));
  expect(queryClient.getQueryData(['session'])).toEqual(identity);
}

describe('Setting up the trade string on the voyage page', () => {
  describe('who is offered it', () => {
    it('offers it to an operator of the exporter on a new, empty, planned voyage', async () => {
      servePage();
      renderRoute(page, { signedInAs: ana });

      expect(await screen.findByText('Trade string not configured')).toBeVisible();
      expect(screen.getByRole('button', { name: 'Set up trade string' })).toBeVisible();
    });

    it.each<[string, { voyage?: VoyageDetail; tradeString?: TradeString }, CurrentUser, string]>([
      ['a viewer of the exporter', {}, anaAsViewer, 'Only an operator of your organization'],
      [
        'a voyage that is not planned',
        { voyage: { ...newVoyage, status: 'LOADING' } },
        ana,
        'Only a planned voyage',
      ],
      [
        'a voyage with other participants',
        {
          voyage: {
            ...newVoyage,
            participants: [...newVoyage.participants, tradeParties.lacustra],
          },
        },
        ana,
        'Other organizations already take part',
      ],
    ])('explains why it is not offered to %s', async (_case, data, identity, reason) => {
      servePage(data);
      renderRoute(page, { signedInAs: identity });

      expect(await screen.findByText(new RegExp(reason))).toBeVisible();
      expect(screen.queryByRole('button', { name: 'Set up trade string' })).toBeNull();
    });

    it.each<[string, { voyage?: VoyageDetail; tradeString?: TradeString }, CurrentUser]>([
      [
        'once the string is set up',
        {
          voyage: { ...newVoyage, participants: aVoyageDetail().participants },
          tradeString: aTradeString(),
        },
        ana,
      ],
      [
        'to a participant that is not the exporter',
        { voyage: { ...newVoyage, participants: [tradeParties.cerrado, tradeParties.lacustra] } },
        claire,
      ],
    ])('says nothing about it %s', async (_case, data, identity) => {
      servePage(data);
      renderRoute(page, { signedInAs: identity });

      expect(await screen.findByRole('heading', { name: 'Trade string' })).toBeVisible();
      await screen.findByText(/Trade string not configured|Contract 1/);
      expect(screen.queryByRole('button', { name: 'Set up trade string' })).toBeNull();
      expect(screen.queryByText(/can be set up|cannot be set up|Only an operator/)).toBeNull();
    });
  });

  describe('building the chain', () => {
    it('fixes the exporter first, and orders, moves and removes the others with roles to match', async () => {
      const state = servePage();
      const { user } = renderRoute(page, { signedInAs: ana });
      await openSetup(user);

      expect(rowLabels()).toEqual([`1. ${cerrado.name}, Exporter`]);
      expect(within(chainRows()[0] as HTMLElement).queryByRole('button')).toBeNull();

      await addOrganization(user, 'lac', lacustra.name);
      expect(rowLabels()).toEqual([
        `1. ${cerrado.name}, Exporter`,
        `2. ${lacustra.name}, Final buyer`,
      ]);
      await addOrganization(user, 'rhine', rhine.name);
      await addOrganization(user, 'nord', nordlys.name);
      expect(rowLabels()).toEqual([
        `1. ${cerrado.name}, Exporter`,
        `2. ${lacustra.name}, Trader`,
        `3. ${rhine.name}, Trader`,
        `4. ${nordlys.name}, Final buyer`,
      ]);

      const moveUp = screen.getByRole('button', { name: `Move ${nordlys.name} up` });
      await user.click(moveUp);
      expect(rowLabels()).toEqual([
        `1. ${cerrado.name}, Exporter`,
        `2. ${lacustra.name}, Trader`,
        `3. ${nordlys.name}, Trader`,
        `4. ${rhine.name}, Final buyer`,
      ]);
      // Focus follows the row it moved, and the change is announced.
      expect(screen.getByRole('button', { name: `Move ${nordlys.name} up` })).toHaveFocus();
      expect(within(setupForm()).getByRole('status')).toHaveTextContent(
        `${nordlys.name} moved to position 3 of 4, as trader.`,
      );
      // The first and last movable rows cannot move past the ends.
      expect(screen.getByRole('button', { name: `Move ${lacustra.name} up` })).toBeDisabled();
      expect(screen.getByRole('button', { name: `Move ${rhine.name} down` })).toBeDisabled();

      await user.click(screen.getByRole('button', { name: `Remove ${lacustra.name}` }));
      expect(rowLabels()).toEqual([
        `1. ${cerrado.name}, Exporter`,
        `2. ${nordlys.name}, Trader`,
        `3. ${rhine.name}, Final buyer`,
      ]);
      expect(state.setups).toEqual([]);
    });

    it('moves focus to the other move button when a row reaches an end', async () => {
      servePage();
      const { user } = renderRoute(page, { signedInAs: ana });
      await openSetup(user);
      await addOrganization(user, 'lac', lacustra.name);
      await addOrganization(user, 'rhine', rhine.name);

      await user.click(screen.getByRole('button', { name: `Move ${rhine.name} up` }));

      expect(screen.getByRole('button', { name: `Move ${rhine.name} up` })).toBeDisabled();
      expect(screen.getByRole('button', { name: `Move ${rhine.name} down` })).toHaveFocus();
    });

    it('searches only from two characters, never offers the exporter, and adds each organization once', async () => {
      const state = servePage();
      const { user } = renderRoute(page, { signedInAs: ana });
      await openSetup(user);

      const field = screen.getByRole('textbox', { name: 'Find an organization' });
      await user.type(field, 'r');
      await new Promise((resolve) => setTimeout(resolve, 400));
      expect(state.searches).toEqual([]);

      await user.type(field, 'a');
      const results = await screen.findByRole('list', { name: 'Organizations found' });
      expect(state.searches).toEqual(['ra']);
      // "ra" matches Cerrado Grãos, Lacustra, Nordlys Trading: the exporter is never offered.
      expect(within(results).queryByText(cerrado.name)).toBeNull();
      await user.click(within(results).getByRole('button', { name: `Add ${lacustra.name}` }));
      expect(
        within(results).getByRole('button', { name: `${lacustra.name} added` }),
      ).toBeDisabled();
      expect(rowLabels()).toHaveLength(2);
    });

    it('says when nothing matches', async () => {
      servePage();
      const { user } = renderRoute(page, { signedInAs: ana });
      await openSetup(user);

      await user.type(screen.getByRole('textbox', { name: 'Find an organization' }), 'zz');

      expect(await screen.findByText('No organization matches “zz”.')).toBeVisible();
    });

    it('stops at ten organizations in all, the exporter included', async () => {
      const traders = Array.from({ length: 10 }, (_, index) => ({
        id: `01990000-0000-7000-8001-0000000001${String(index).padStart(2, '0')}`,
        name: `Trader ${String(index + 1).padStart(2, '0')}`,
        countryCode: 'NL',
      }));
      servePage({ organizations: [cerrado, ...traders] });
      const { user } = renderRoute(page, { signedInAs: ana });
      await openSetup(user);
      await user.type(screen.getByRole('textbox', { name: 'Find an organization' }), 'trader');
      const results = await screen.findByRole('list', { name: 'Organizations found' });

      for (const trader of traders.slice(0, 9)) {
        await user.click(within(results).getByRole('button', { name: `Add ${trader.name}` }));
      }

      expect(rowLabels()).toHaveLength(10);
      expect(within(results).getByRole('button', { name: 'Add Trader 10' })).toBeDisabled();
      expect(
        screen.getByText('A trade string names at most 10 organizations, yours included.'),
      ).toBeVisible();
    });

    it('asks for at least one organization before reviewing, and sends nothing', async () => {
      const state = servePage();
      const { user } = renderRoute(page, { signedInAs: ana });
      await openSetup(user);

      await user.click(screen.getByRole('button', { name: 'Review the trade string' }));

      expect(
        screen.getByText('Add at least one organization: the buyer your organization sells to.'),
      ).toBeVisible();
      expect(screen.queryByRole('region', { name: 'Review the trade string' })).toBeNull();
      expect(state.setups).toEqual([]);
    });

    it('closes on cancel without sending anything', async () => {
      const state = servePage();
      const { user } = renderRoute(page, { signedInAs: ana });
      await openSetup(user);
      await addOrganization(user, 'lac', lacustra.name);

      await user.click(screen.getByRole('button', { name: 'Cancel' }));

      expect(screen.queryByRole('form', { name: 'Set up the trade string' })).toBeNull();
      expect(screen.getByRole('button', { name: 'Set up trade string' })).toBeVisible();
      expect(state.setups).toEqual([]);
    });
  });

  describe('reviewing and sending', () => {
    it('shows the roles, contracts and what setup means, then sends one plain POST', async () => {
      const state = servePage();
      serveSetup(state, recordChain(state, [cerrado, lacustra, rhine]));
      const { user, queryClient } = renderRoute(page, { signedInAs: ana });
      const review = await reviewLacustraThenRhine(user);

      expect(
        within(review)
          .getAllByRole('listitem')
          .map((item) => item.textContent),
      ).toEqual([
        `${cerrado.name} (Brazil) — Exporter`,
        `${lacustra.name} (Switzerland) — Trader`,
        `${rhine.name} (Germany) — Final buyer`,
        `Contract 1: ${cerrado.name} sells to ${lacustra.name}`,
        `Contract 2: ${lacustra.name} sells to ${rhine.name}`,
      ]);
      const explanation = screen.getByText('What setting it up does').closest('[role="alert"]');
      expect(explanation).toHaveTextContent(
        `${lacustra.name} and ${rhine.name} take part in this voyage at once`,
      );
      expect(explanation).toHaveTextContent('It does not record that any of them agreed to it.');
      expect(explanation).toHaveTextContent('cannot be changed or undone here');
      expect(state.setups).toEqual([]);

      const list = aCachedList(queryClient, ana);
      const detailRequests = state.detailRequests;
      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));

      expect(await screen.findByText('Trade string set up')).toBeVisible();
      expect(
        screen.getByText(`${lacustra.name} and ${rhine.name} now take part in this voyage.`),
      ).toBeVisible();
      expect(state.setups).toEqual([
        {
          body: {
            parties: [
              { organizationId: cerrado.id },
              { organizationId: lacustra.id },
              { organizationId: rhine.id },
            ],
          },
          ifMatch: null,
          ifNoneMatch: null,
        },
      ]);
      const chain = await screen.findByRole('list', {
        name: 'Trade string, from exporter to final buyer',
      });
      expect(within(chain).getAllByRole('listitem')).toHaveLength(3);
      // The participants and the lists follow from the voyage's detail prefix and the lists.
      await waitFor(() => {
        expect(state.detailRequests).toBeGreaterThan(detailRequests);
      });
      expect(list()?.state.isInvalidated).toBe(true);
      expect(screen.queryByRole('button', { name: 'Set up trade string' })).toBeNull();
    });

    it('goes back to editing with nothing sent', async () => {
      const state = servePage();
      const { user } = renderRoute(page, { signedInAs: ana });
      await reviewLacustraThenRhine(user);

      await user.click(screen.getByRole('button', { name: 'Back to editing' }));

      expect(rowLabels()).toHaveLength(3);
      expect(state.setups).toEqual([]);
    });
  });

  describe('when the setup is refused or fails', () => {
    it('shows field errors on their organizations and goes back to editing, sending nothing again', async () => {
      const state = servePage();
      serveSetup(state, () =>
        problem(400, 'Request validation failed', 'The request is invalid.', [
          { path: 'body.parties.2.organizationId', message: 'No organization has this id' },
        ]),
      );
      const { user } = renderRoute(page, { signedInAs: ana });
      await reviewLacustraThenRhine(user);

      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));

      expect(
        await screen.findByText(
          'Some organizations could not be accepted. Change them, then review again.',
        ),
      ).toBeVisible();
      const rhineRow = chainRows()[2] as HTMLElement;
      expect(rhineRow).toHaveAccessibleDescription('No organization has this id');
      expect(within(chainRows()[1] as HTMLElement).queryByText(/No organization/)).toBeNull();
      expect(state.setups).toHaveLength(1);

      // A change clears refusals that may now name the wrong positions.
      await user.click(screen.getByRole('button', { name: `Remove ${rhine.name}` }));
      expect(screen.queryByText(/could not be accepted/)).toBeNull();
      expect(state.setups).toHaveLength(1);
    });

    it('reports a failure, keeps the review, and sends again only when asked', async () => {
      const state = servePage();
      serveSetup(state, () => problem(500, 'Internal Server Error', 'Boom'));
      const { user } = renderRoute(page, { signedInAs: ana });
      await reviewLacustraThenRhine(user);

      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));

      expect(
        await screen.findByText('The trade string could not be set up. Please try again.'),
      ).toBeVisible();
      expect(screen.getByRole('region', { name: 'Review the trade string' })).toBeVisible();
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(state.setups).toHaveLength(1);

      serveSetup(state, recordChain(state, [cerrado, lacustra, rhine]));
      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));
      expect(await screen.findByText('Trade string set up')).toBeVisible();
      expect(state.setups).toHaveLength(2);
    });

    it('shows the string someone else recorded meanwhile on a 409, and sends nothing again', async () => {
      const state = servePage();
      serveSetup(state, () => {
        // A colleague's setup won: the server now holds their chain.
        recordChain(state, [cerrado, nordlys])();
        return problem(409, 'Conflict', ALREADY_SET_UP);
      });
      const { user, queryClient } = renderRoute(page, { signedInAs: ana });
      await reviewLacustraThenRhine(user);
      // Unobserved protected queries are dropped as abandoned: add it just before it matters.
      const list = aCachedList(queryClient, ana);

      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));

      expect(await screen.findByText('Already set up')).toBeVisible();
      const chain = await screen.findByRole('list', {
        name: 'Trade string, from exporter to final buyer',
      });
      expect(within(chain).getByText(nordlys.name)).toBeVisible();
      expect(screen.queryByRole('form', { name: 'Set up the trade string' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Set up trade string' })).toBeNull();
      expect(list()?.state.isInvalidated).toBe(true);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(state.setups).toHaveLength(1);
    });

    it('explains why the voyage cannot be set up on a 409 that left it empty', async () => {
      const state = servePage();
      const detail = 'Only a PLANNED voyage can have its trade string set up; this one is LOADING.';
      serveSetup(state, () => {
        state.voyage = { ...state.voyage, status: 'LOADING' };
        return problem(409, 'Conflict', detail);
      });
      const { user } = renderRoute(page, { signedInAs: ana });
      await reviewLacustraThenRhine(user);

      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));

      const alert = (await screen.findByText('Not set up')).closest('[role="alert"]');
      expect(alert).toHaveTextContent(detail);
      await waitFor(() => {
        expect(alert).toHaveTextContent(
          'Only a planned voyage can have its trade string set up here.',
        );
      });
      expect(screen.getByText('Trade string not configured')).toBeVisible();
      expect(screen.queryByRole('form', { name: 'Set up the trade string' })).toBeNull();
      expect(state.setups).toHaveLength(1);
    });

    it('stops offering the open form once a refresh shows the string was set up meanwhile', async () => {
      const state = servePage();
      const { user, queryClient } = renderRoute(page, { signedInAs: ana });
      await openSetup(user);
      await addOrganization(user, 'lac', lacustra.name);

      recordChain(state, [cerrado, nordlys])();
      await act(() => queryClient.refetchQueries({ queryKey: ['protected'] }));

      expect(
        await screen.findByText('The trade string can no longer be set up here'),
      ).toBeVisible();
      expect(screen.getByText('It has been set up meanwhile, as shown above.')).toBeVisible();
      expect(screen.queryByRole('form', { name: 'Set up the trade string' })).toBeNull();
      expect(state.setups).toEqual([]);
    });
  });

  describe('when the session is replaced while a setup is on its way', () => {
    it.each<[string, (state: State) => Response]>([
      ['succeeds', (state) => recordChain(state, [cerrado, lacustra, rhine])()],
      ['answers 409', () => problem(409, 'Conflict', ALREADY_SET_UP)],
      [
        'answers 400',
        () =>
          problem(400, 'Request validation failed', 'The request is invalid.', [
            { path: 'body.parties.1.organizationId', message: 'No organization has this id' },
          ]),
      ],
    ])(
      'lets a setup sent before Ana signed out and back in, which %s, touch nothing of her new session',
      async (_case, respond) => {
        const state = servePage();
        const setup = serveSetup(state, () => respond(state), { hold: true });
        const rendered = renderRoute(page, { signedInAs: ana });
        const { user, queryClient } = rendered;
        await reviewLacustraThenRhine(user);
        await user.click(screen.getByRole('button', { name: 'Set up trade string' }));
        await setup.received;

        await signOut(user);
        await signIn(rendered, ana);
        expect(await screen.findByRole('button', { name: 'Set up trade string' })).toBeVisible();
        const list = aCachedList(queryClient, ana);
        const detailRequests = state.detailRequests;
        const tradeStringRequests = state.tradeStringRequests;
        setup.release();
        await allAnswered(queryClient);

        expect(screen.queryByText('Trade string set up')).toBeNull();
        expect(screen.queryByText('Already set up')).toBeNull();
        expect(screen.queryByText(/could not be accepted/)).toBeNull();
        expect(screen.getByText('Trade string not configured')).toBeVisible();
        expect(state.detailRequests).toBe(detailRequests);
        expect(state.tradeStringRequests).toBe(tradeStringRequests);
        expect(list()?.state.isInvalidated).toBe(false);
        expect(
          queryClient.getQueryData([
            'protected',
            scopeOf(ana),
            'voyages',
            'detail',
            newVoyage.id,
            'trade-string',
          ]),
        ).toEqual(anEmptyTradeString());
        expect(state.setups).toHaveLength(1);
      },
    );

    it('lets a setup sent before session checks went to Claire and back refresh nothing', async () => {
      const state = servePage();
      const setup = serveSetup(state, () => problem(409, 'Conflict', ALREADY_SET_UP), {
        hold: true,
      });
      const rendered = renderRoute(page, { signedInAs: ana, accounts: [ana, claire] });
      const { user, queryClient } = rendered;
      await reviewLacustraThenRhine(user);
      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));
      await setup.received;

      await aSessionCheckFinds(rendered, claire);
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      await aSessionCheckFinds(rendered, ana);
      expect(await screen.findByText('Ana Souza')).toBeInTheDocument();
      expect(await screen.findByRole('button', { name: 'Set up trade string' })).toBeVisible();
      const detailRequests = state.detailRequests;
      setup.release();
      await allAnswered(queryClient);

      expect(screen.queryByText('Already set up')).toBeNull();
      expect(state.detailRequests).toBe(detailRequests);
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ['protected'] })) {
        expect(query.state.isInvalidated).toBe(false);
      }
    });

    it('ends the session the setup was sent under when it answers 401', async () => {
      const state = servePage();
      serveSetup(state, () => problem(401, 'Unauthorized', 'Authentication is required.'));
      const { router, user, session } = renderRoute(page, { signedInAs: ana });
      await reviewLacustraThenRhine(user);
      session.current = null;

      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));

      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
      expect(state.setups).toHaveLength(1);
    });

    it('records the setup when a session check only confirmed that Ana is still signed in', async () => {
      const state = servePage();
      const setup = serveSetup(state, () => recordChain(state, [cerrado, lacustra, rhine])(), {
        hold: true,
      });
      const rendered = renderRoute(page, { signedInAs: ana });
      await reviewLacustraThenRhine(rendered.user);
      await rendered.user.click(screen.getByRole('button', { name: 'Set up trade string' }));
      await setup.received;

      await aSessionCheckFinds(rendered, ana);
      setup.release();

      expect(await screen.findByText('Trade string set up')).toBeVisible();
    });
  });

  describe('when the session is replaced while a setup waits for the network', () => {
    afterEach(() => {
      onlineManager.setOnline(true);
    });

    /** Ana sends the setup while offline: the request waits, unsent. */
    async function setUpOffline({ user, queryClient }: Rendered) {
      await reviewLacustraThenRhine(user);
      act(() => {
        onlineManager.setOnline(false);
      });
      await user.click(screen.getByRole('button', { name: 'Set up trade string' }));
      await waitFor(() => {
        expect(queryClient.getMutationCache().getAll()[0]?.state.isPaused).toBe(true);
      });
    }

    it('sends no setup for Ana once another tab has signed in as Claire', async () => {
      const state = servePage();
      serveSetup(state, () => recordChain(state, [cerrado, lacustra, rhine])());
      const rendered = renderRoute(page, { signedInAs: ana, accounts: [ana, claire] });
      const { session, queryClient } = rendered;
      await setUpOffline(rendered);

      session.current = claire;
      await act(() => sessionChangedElsewhere(queryClient));
      act(() => {
        onlineManager.setOnline(true);
      });
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      await allAnswered(queryClient);

      expect(state.setups).toEqual([]);
      expect(queryClient.getQueryData(['session'])).toEqual(claire);
      expect(screen.queryByText('Trade string set up')).toBeNull();
      expect(session.signOutRequests).toBe(0);
    });

    it('records the setup once back online, when nothing changed', async () => {
      const state = servePage();
      serveSetup(state, () => recordChain(state, [cerrado, lacustra, rhine])());
      const rendered = renderRoute(page, { signedInAs: ana });
      await setUpOffline(rendered);
      expect(state.setups).toEqual([]);

      act(() => {
        onlineManager.setOnline(true);
      });

      expect(await screen.findByText('Trade string set up')).toBeVisible();
      expect(state.setups).toHaveLength(1);
    });
  });
});
