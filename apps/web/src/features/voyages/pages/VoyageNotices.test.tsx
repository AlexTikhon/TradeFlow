import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import type {
  CounterpartyContractListResponse,
  IssueNoticeRequest,
  Notice,
  ProblemDetails,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser } from '../../../test/fixtures/auth';
import {
  aCounterpartyContract,
  acknowledged,
  aNotice,
  claire as claireActor,
  contractList,
} from '../../../test/fixtures/notices';
import { aTradeString, aVoyageDetail, tradeParties } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from '../../auth/session-sync';

const voyage = aVoyageDetail();
const page = `/voyages/${voyage.id}`;

/** Ana operates for Cerrado, the seller under contract 1. */
const ana = aCurrentUser();
const anaAsViewer = aCurrentUser({ user: { ...ana.user, role: 'VIEWER' } });
/** Claire operates for Lacustra, the buyer under contract 1. */
const claire = anotherUser();
const claireAsViewer = anotherUser();
claireAsViewer.user = { ...claire.user, role: 'VIEWER' };

/** Contract 1 as Lacustra sees it. */
const asBuyer = aCounterpartyContract({ side: 'BUYER' });
const awaitingForBuyer = aNotice({ contract: asBuyer });

/**
 * Serves the details page. `notices` is the fake server's state: tests and command handlers
 * change it, and every list request answers what it holds at that moment.
 */
function servePage({
  contracts = contractList(aCounterpartyContract()),
  notices = [] as Notice[],
  listResponse,
}: {
  contracts?: CounterpartyContractListResponse;
  notices?: Notice[];
  listResponse?: () => Response;
} = {}) {
  const state = { notices, listRequests: 0 };
  server.use(
    http.get(`*/api/voyages/${voyage.id}`, () => HttpResponse.json(voyage)),
    http.get(`*/api/voyages/${voyage.id}/trade-string`, () => HttpResponse.json(aTradeString())),
    http.get(`*/api/voyages/${voyage.id}/my-contracts`, () => HttpResponse.json(contracts)),
    http.get(`*/api/voyages/${voyage.id}/notices`, () => {
      state.listRequests += 1;
      return listResponse ? listResponse() : HttpResponse.json({ items: state.notices });
    }),
  );
  return state;
}

/**
 * Serves one POST command with `respond`, recording each body. With `hold`, responses wait for
 * `release()`, so a test can change who is signed in while the request is in flight.
 */
function serveCommand(path: string, respond: () => Response, { hold = false } = {}) {
  const bodies: unknown[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  server.use(
    http.post(`*/api/voyages/${voyage.id}${path}`, async ({ request }) => {
      bodies.push(await request.json());
      arrived();
      if (hold) await gate;
      return respond();
    }),
  );
  return { bodies, received, release };
}

const serveIssue = (respond: () => Response, options?: { hold?: boolean }) =>
  serveCommand('/notices', respond, options);
const serveAcknowledgement = (respond: () => Response, options?: { hold?: boolean }) =>
  serveCommand(`/notices/${awaitingForBuyer.id}/acknowledgement`, respond, options);

function validationProblem(errors: ProblemDetails['errors']) {
  const problem: ProblemDetails = {
    type: '/problems/validation-failed',
    title: 'Request validation failed',
    status: 400,
    detail: 'The request is invalid.',
    errors,
  };
  return HttpResponse.json(problem, {
    status: 400,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

type Rendered = ReturnType<typeof renderRoute>;
type User = Rendered['user'];

const noticeItems = async () =>
  within(await screen.findByRole('list', { name: 'Notices' })).getAllByRole('listitem');

async function openIssueForm(user: User) {
  await user.click(await screen.findByRole('button', { name: 'Issue ETA notice' }));
  return within(screen.getByRole('form', { name: 'Issue ETA notice' }));
}

type Form = Awaited<ReturnType<typeof openIssueForm>>;

/**
 * Fills the form. Wall-clock times in the viewer's zone (the suite runs in America/Sao_Paulo,
 * UTC-3). user-event cannot type into `datetime-local` inputs, so their values are set directly.
 */
async function fillIssueForm(
  user: User,
  form: Form,
  {
    arrival = '2030-10-25T14:00',
    due = '2030-10-20T12:00',
    message = 'Vessel sailed Santos; ETA firm.',
  } = {},
) {
  fireEvent.change(form.getByLabelText(/Estimated arrival/), { target: { value: arrival } });
  fireEvent.change(form.getByLabelText(/Acknowledge by/), { target: { value: due } });
  if (message) await user.type(form.getByLabelText(/Message/), message);
}

/** What `fillIssueForm` sends by default: the same instants, in UTC. */
const expectedRequest: IssueNoticeRequest = {
  contractId: aCounterpartyContract().id,
  estimatedArrivalAt: '2030-10-25T17:00:00.000Z',
  acknowledgementDueAt: '2030-10-20T15:00:00.000Z',
  message: 'Vessel sailed Santos; ETA firm.',
};

const issuedNotice = aNotice({
  id: '01990000-0000-7000-8009-000000000077',
  estimatedArrivalAt: expectedRequest.estimatedArrivalAt,
  acknowledgementDueAt: expectedRequest.acknowledgementDueAt,
  message: expectedRequest.message ?? null,
});

const protectedQueries = (queryClient: Rendered['queryClient']) =>
  queryClient.getQueryCache().findAll({ queryKey: ['protected'] });

const settledMutations = (queryClient: Rendered['queryClient']) =>
  queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status !== 'pending');

/** Starts cross-tab sync and returns the channel another tab would post on. */
function anotherTab(queryClient: Rendered['queryClient']) {
  const stopSync = startSessionSync(queryClient);
  const channel = new BroadcastChannel(SESSION_CHANNEL_NAME);
  watchers.push(() => {
    channel.close();
    stopSync();
  });
  return channel;
}

const watchers: (() => void)[] = [];
afterEach(() => {
  watchers.splice(0).forEach((stop) => {
    stop();
  });
});

describe('ETA notices on the voyage page', () => {
  describe('the list', () => {
    it("shows each notice's state, times in the viewer's zone, parties and message", async () => {
      servePage({
        notices: [
          aNotice(),
          aNotice({
            id: '01990000-0000-7000-8009-000000000002',
            acknowledgementDueAt: '2026-10-01T15:00:00.000Z',
            issuedAt: '2026-09-30T12:00:00.000Z',
            overdue: true,
            message: null,
          }),
          acknowledged(
            aNotice({ id: '01990000-0000-7000-8009-000000000003' }),
            claireActor,
            '2030-10-16T13:30:00.000Z',
          ),
          acknowledged(
            aNotice({ id: '01990000-0000-7000-8009-000000000004' }),
            claireActor,
            '2030-10-21T13:30:00.000Z',
          ),
        ],
      });
      renderRoute(page);

      const [awaiting, overdue, onTime, late] = await noticeItems();
      expect(awaiting).toHaveTextContent('Awaiting acknowledgement');
      expect(awaiting).toHaveTextContent('Sent by you');
      expect(awaiting).toHaveTextContent(
        'Contract 1 · Cerrado Grãos Exportadora S.A. → Lacustra Commodities SA',
      );
      expect(awaiting).toHaveTextContent('Estimated arrival25 Oct 2030, 14:00 GMT-3');
      expect(awaiting).toHaveTextContent('Acknowledge by20 Oct 2030, 12:00 GMT-3');
      expect(awaiting).toHaveTextContent(
        'Issued15 Oct 2030, 09:00 GMT-3 by Ana Souza (Cerrado Grãos Exportadora S.A.)',
      );
      expect(awaiting).toHaveTextContent('AcknowledgedNot yet');
      expect(awaiting).toHaveTextContent('MV Horizon sailed Santos fully loaded.');
      expect(overdue).toHaveTextContent('Overdue');
      expect(onTime).toHaveTextContent('Acknowledged');
      expect(onTime).toHaveTextContent(
        'Acknowledged16 Oct 2030, 10:30 GMT-3 by Claire Morel (Lacustra Commodities SA)',
      );
      expect(late).toHaveTextContent('Acknowledged late');
      // Ana's organization sells: nothing here is hers to acknowledge.
      expect(screen.queryByRole('button', { name: 'Acknowledge receipt' })).not.toBeInTheDocument();
    });

    it('says when there are no notices yet', async () => {
      servePage();
      renderRoute(page);

      expect(await screen.findByText('No notices under your contracts yet.')).toBeInTheDocument();
    });

    it('explains itself to a participant that is a party to no contract', async () => {
      servePage({ contracts: contractList() });
      renderRoute(page);

      expect(
        await screen.findByText(/Your organization is not a party to a sale contract/),
      ).toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Issue ETA notice' })).not.toBeInTheDocument();
    });

    it('reports a failure in its own card, keeps the page, and retries on request', async () => {
      let fail = true;
      const state = servePage({
        listResponse: () =>
          fail ? problemResponse(500, 'database down') : HttpResponse.json({ items: [aNotice()] }),
      });
      const { user } = renderRoute(page);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Notices could not be loaded');
      expect(alert).not.toHaveTextContent('database down');
      expect(screen.getByRole('heading', { name: 'TF-2026-0001' })).toBeInTheDocument();
      expect(
        screen.getByRole('list', { name: 'Trade string, from exporter to final buyer' }),
      ).toBeInTheDocument();

      fail = false;
      await user.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(await noticeItems()).toHaveLength(1);
      expect(state.listRequests).toBe(2);
    });
  });

  describe('issuing', () => {
    it("issues a notice as the seller's operator, sending instants, and lists it", async () => {
      const state = servePage();
      const issue = serveIssue(() => {
        state.notices.unshift(issuedNotice);
        return HttpResponse.json(issuedNotice, { status: 201 });
      });
      const { user } = renderRoute(page);

      const form = await openIssueForm(user);
      // Ana's organization sells under one contract here: it is already chosen.
      expect(form.getByLabelText(/Contract/)).toHaveValue(aCounterpartyContract().id);
      expect(form.getByText(/Times are in your time zone \(America\/Sao_Paulo\)/)).toBeVisible();
      await fillIssueForm(user, form);
      await user.click(form.getByRole('button', { name: 'Issue notice' }));

      expect(
        await screen.findByText('Your ETA notice to Lacustra Commodities SA has been issued.'),
      ).toBeVisible();
      expect(issue.bodies).toEqual([expectedRequest]);
      expect(screen.queryByRole('form', { name: 'Issue ETA notice' })).not.toBeInTheDocument();
      const [item] = await noticeItems();
      expect(item).toHaveTextContent('Estimated arrival25 Oct 2030, 14:00 GMT-3');
      expect(state.listRequests).toBe(2);
    });

    it('leaves the message out when none is written', async () => {
      servePage();
      const issue = serveIssue(() => HttpResponse.json(issuedNotice, { status: 201 }));
      const { user } = renderRoute(page);

      const form = await openIssueForm(user);
      await fillIssueForm(user, form, { message: '' });
      await user.click(form.getByRole('button', { name: 'Issue notice' }));

      await screen.findByText('Your ETA notice to Lacustra Commodities SA has been issued.');
      const { message: _message, ...withoutMessage } = expectedRequest;
      expect(issue.bodies).toEqual([withoutMessage]);
    });

    it('offers a trader only the contract it sells under, not the one it buys under', async () => {
      const sale = aCounterpartyContract({
        id: '01990000-0000-7000-8008-000000000102',
        position: 2,
        seller: tradeParties.lacustra.organization,
        buyer: tradeParties.nordlys.organization,
      });
      const toNordlys = aNotice({ ...issuedNotice, contract: sale, issuedBy: claireActor });
      servePage({ contracts: contractList(asBuyer, sale) });
      const issue = serveIssue(() => HttpResponse.json(toNordlys, { status: 201 }));
      const { user } = renderRoute(page, { signedInAs: claire });

      const form = await openIssueForm(user);
      const select = form.getByLabelText(/Contract/);
      // Lacustra buys under contract 1 and sells under contract 2. (In a valid trade string an
      // organization sells at most once per voyage, so there is never more than one to choose.)
      expect(
        within(select)
          .getAllByRole('option')
          .map((option) => option.textContent),
      ).toEqual(['Select…', 'Contract 2 · Lacustra Commodities SA → Nordlys Trading B.V.']);
      expect(select).toHaveValue(sale.id);

      await fillIssueForm(user, form);
      await user.click(form.getByRole('button', { name: 'Issue notice' }));
      expect(
        await screen.findByText('Your ETA notice to Nordlys Trading B.V. has been issued.'),
      ).toBeVisible();
      expect(issue.bodies).toEqual([{ ...expectedRequest, contractId: sale.id }]);
    });

    it('asks for a contract when none is chosen', async () => {
      servePage();
      const issue = serveIssue(() => HttpResponse.json(issuedNotice, { status: 201 }));
      const { user } = renderRoute(page);
      const form = await openIssueForm(user);
      await fillIssueForm(user, form);

      // As if the only option had been deselected (a stale page, or a scripted form).
      fireEvent.change(form.getByLabelText(/Contract/), { target: { value: '' } });
      await user.click(form.getByRole('button', { name: 'Issue notice' }));

      expect(await form.findByText('Select the contract.')).toBeInTheDocument();
      expect(issue.bodies).toEqual([]);
    });

    it('checks the times before sending anything', async () => {
      servePage();
      const issue = serveIssue(() => HttpResponse.json(issuedNotice, { status: 201 }));
      const { user } = renderRoute(page);
      const form = await openIssueForm(user);
      const submit = () => user.click(form.getByRole('button', { name: 'Issue notice' }));

      await submit();
      expect(await form.findByText('Enter the estimated arrival.')).toBeInTheDocument();
      expect(form.getByText('Enter the acknowledgement deadline.')).toBeInTheDocument();

      await fillIssueForm(user, form, { arrival: '2030-10-20T12:00', due: '2030-10-20T12:01' });
      await submit();
      expect(
        await form.findByText(
          'The acknowledgement deadline must not be after the estimated arrival',
        ),
      ).toBeInTheDocument();

      fireEvent.change(form.getByLabelText(/Acknowledge by/), {
        target: { value: '2020-01-01T12:00' },
      });
      await submit();
      expect(
        await form.findByText('The acknowledgement deadline must be in the future'),
      ).toBeInTheDocument();

      fireEvent.change(form.getByLabelText(/Acknowledge by/), {
        target: { value: '2030-10-20T12:00' },
      });
      await user.clear(form.getByLabelText(/Message/));
      // Pasted: typing a thousand keystrokes one by one would outlast the test's time limit.
      await user.paste('x'.repeat(1001));
      await submit();
      expect(await form.findByText('Use at most 1000 characters')).toBeInTheDocument();

      expect(issue.bodies).toEqual([]);
    });

    it("shows the server's validation errors on the fields they concern", async () => {
      servePage();
      serveIssue(() =>
        validationProblem([
          {
            path: 'body.acknowledgementDueAt',
            message: 'The acknowledgement deadline must be in the future',
          },
        ]),
      );
      const { user } = renderRoute(page);
      const form = await openIssueForm(user);
      await fillIssueForm(user, form);

      await user.click(form.getByRole('button', { name: 'Issue notice' }));

      expect(
        await form.findByText('The acknowledgement deadline must be in the future'),
      ).toBeInTheDocument();
      expect(form.getByLabelText(/Acknowledge by/)).toHaveAttribute('aria-invalid', 'true');
    });

    it.each([
      [
        'a refusal',
        () => problemResponse(403, 'Only the seller under a contract may issue its notices.'),
        'Only the seller under a contract may issue its notices.',
      ],
      [
        'a contract that is no longer yours',
        () => problemResponse(404, 'Contract was not found.'),
        'Contract was not found.',
      ],
      ['a network failure', () => HttpResponse.error(), 'The notice could not be issued.'],
      [
        'a server failure',
        () => problemResponse(500, 'audit store unavailable'),
        'The notice could not be issued.',
      ],
    ])('reports %s, keeps the form and the session, and sends once', async (_, respond, text) => {
      const state = servePage();
      const issue = serveIssue(respond);
      const { user, session, queryClient } = renderRoute(page);
      const form = await openIssueForm(user);
      await fillIssueForm(user, form);

      await user.click(form.getByRole('button', { name: 'Issue notice' }));

      expect(await form.findByRole('alert')).toHaveTextContent(text);
      expect(screen.queryByText(/audit store/)).not.toBeInTheDocument();
      expect(form.getByLabelText(/Estimated arrival/)).toHaveValue('2030-10-25T14:00');
      expect(form.getByLabelText(/Message/)).toHaveValue('Vessel sailed Santos; ETA firm.');
      expect(queryClient.getQueryData(['session'])).toEqual(ana);
      expect(issue.bodies).toHaveLength(1);
      expect(state.listRequests).toBe(1);
      expect(session.signOutRequests).toBe(0);
    });

    it('is offered only to operators, and only under contracts the organization sells', async () => {
      servePage({ notices: [aNotice()] });
      renderRoute(page, { signedInAs: anaAsViewer });
      await noticeItems();
      expect(screen.queryByRole('button', { name: 'Issue ETA notice' })).not.toBeInTheDocument();
    });

    it('is not offered to an operator whose organization only buys here', async () => {
      servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      renderRoute(page, { signedInAs: claire });
      await noticeItems();
      expect(screen.queryByRole('button', { name: 'Issue ETA notice' })).not.toBeInTheDocument();
    });
  });

  describe('acknowledging', () => {
    it("records receipt as the buyer's operator and shows who acknowledged", async () => {
      const state = servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      const done = acknowledged(awaitingForBuyer, claireActor, '2030-10-16T13:30:00.000Z');
      const acknowledgement = serveAcknowledgement(() => {
        state.notices = [done];
        return HttpResponse.json(done);
      });
      const { user } = renderRoute(page, { signedInAs: claire });

      const [item] = await noticeItems();
      expect(item).toHaveTextContent('Sent to you');
      await user.click(
        within(item as HTMLElement).getByRole('button', { name: 'Acknowledge receipt' }),
      );

      await waitFor(() => {
        expect(item).toHaveTextContent(
          'Acknowledged16 Oct 2030, 10:30 GMT-3 by Claire Morel (Lacustra Commodities SA)',
        );
      });
      expect(
        within(item as HTMLElement).queryByRole('button', { name: 'Acknowledge receipt' }),
      ).not.toBeInTheDocument();
      expect(acknowledgement.bodies).toEqual([{}]);
    });

    it('accepts a late acknowledgement of an overdue notice', async () => {
      const overdue = { ...awaitingForBuyer, overdue: true };
      const state = servePage({ contracts: contractList(asBuyer), notices: [overdue] });
      const done = acknowledged(overdue, claireActor, '2030-10-21T13:30:00.000Z');
      serveAcknowledgement(() => {
        state.notices = [done];
        return HttpResponse.json(done);
      });
      const { user } = renderRoute(page, { signedInAs: claire });

      const [item] = await noticeItems();
      expect(item).toHaveTextContent('Overdue');
      await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));

      await waitFor(() => {
        expect(item).toHaveTextContent('Acknowledged late');
      });
    });

    it('reports a notice someone else acknowledged first, shows who, and does not retry', async () => {
      const colleague = { name: 'Lea Brunner', organization: claireActor.organization };
      const state = servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      const acknowledgement = serveAcknowledgement(() => {
        state.notices = [acknowledged(awaitingForBuyer, colleague, '2030-10-16T12:00:00.000Z')];
        return problemResponse(409, 'This notice has already been acknowledged.');
      });
      const { user } = renderRoute(page, { signedInAs: claire });

      const [item] = await noticeItems();
      await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));

      expect(await within(item as HTMLElement).findByRole('alert')).toHaveTextContent(
        'This notice has already been acknowledged.',
      );
      await waitFor(() => {
        expect(item).toHaveTextContent('by Lea Brunner (Lacustra Commodities SA)');
      });
      expect(screen.queryByRole('button', { name: 'Acknowledge receipt' })).not.toBeInTheDocument();
      expect(acknowledgement.bodies).toHaveLength(1);
    });

    it('reports a failure and leaves trying again to the user', async () => {
      servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      const acknowledgement = serveAcknowledgement(() => problemResponse(500, 'db down'));
      const { user, session } = renderRoute(page, { signedInAs: claire });

      await noticeItems();
      await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Receipt could not be acknowledged. Please try again.',
      );
      expect(screen.getByRole('button', { name: 'Acknowledge receipt' })).toBeEnabled();
      expect(acknowledgement.bodies).toHaveLength(1);
      expect(session.signOutRequests).toBe(0);
    });

    it("reports the server's refusal", async () => {
      servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      serveAcknowledgement(() =>
        problemResponse(403, 'Your role does not allow you to acknowledge notices.'),
      );
      const { user } = renderRoute(page, { signedInAs: claire });

      await noticeItems();
      await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Your role does not allow you to acknowledge notices.',
      );
    });

    it('is not offered to a viewer of the buyer, who is told who can', async () => {
      servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      renderRoute(page, { signedInAs: claireAsViewer });

      const [item] = await noticeItems();
      expect(item).toHaveTextContent('An operator in your organization can acknowledge receipt.');
      expect(screen.queryByRole('button', { name: 'Acknowledge receipt' })).not.toBeInTheDocument();
    });
  });

  describe('when the server answers 401', () => {
    const unauthenticated = () => problemResponse(401, 'Authentication is required.');

    it('ends the session an issue was sent under and asks to sign in again', async () => {
      servePage();
      const issue = serveIssue(unauthenticated);
      const { router, user, session, queryClient } = renderRoute(page);
      const form = await openIssueForm(user);
      await fillIssueForm(user, form);
      session.current = null;

      await user.click(form.getByRole('button', { name: 'Issue notice' }));

      expect(
        await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/sign-in');
      await waitFor(() => {
        expect(protectedQueries(queryClient)).toEqual([]);
      });
      expect(issue.bodies).toHaveLength(1);
      expect(session.signOutRequests).toBe(0);
    });

    it('ends the session an acknowledgement was sent under', async () => {
      servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      const acknowledgement = serveAcknowledgement(unauthenticated);
      const { router, user, session, queryClient } = renderRoute(page, { signedInAs: claire });
      await noticeItems();
      session.current = null;

      await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));

      expect(
        await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/sign-in');
      await waitFor(() => {
        expect(protectedQueries(queryClient)).toEqual([]);
      });
      expect(acknowledgement.bodies).toHaveLength(1);
      expect(session.signOutRequests).toBe(0);
    });

    it('does not sign out another user who signed in while it was on its way', async () => {
      servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      const acknowledgement = serveAcknowledgement(unauthenticated, { hold: true });
      const { router, user, session, queryClient } = renderRoute(page, {
        signedInAs: claire,
        accounts: [claire, ana],
      });
      const otherTab = anotherTab(queryClient);
      await noticeItems();
      await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));
      await acknowledgement.received;

      // Another tab signs in as Ana, which ends Claire's session: her request will be refused.
      session.current = ana;
      otherTab.postMessage(SESSION_CHANGED);
      expect(await screen.findByText('Ana Souza')).toBeInTheDocument();
      await noticeItems();

      acknowledgement.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(queryClient.getQueryData(['session'])).toEqual(ana);
      expect(router.state.location.pathname).toBe(page);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(session.signOutRequests).toBe(0);
    });
  });

  describe('when the identity changes while a command is in flight', () => {
    it("lets an issue response touch neither the next identity's cache nor its screen", async () => {
      const state = servePage();
      const issue = serveIssue(() => HttpResponse.json(issuedNotice, { status: 201 }), {
        hold: true,
      });
      const { user, session, queryClient } = renderRoute(page, { accounts: [ana, claire] });
      const otherTab = anotherTab(queryClient);
      const form = await openIssueForm(user);
      await fillIssueForm(user, form);
      await user.click(form.getByRole('button', { name: 'Issue notice' }));
      await issue.received;

      // Another tab signs in as Claire; this tab now shows her the same voyage.
      session.current = claire;
      otherTab.postMessage(SESSION_CHANGED);
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      await screen.findByText('No notices under your contracts yet.');
      const listRequestsBefore = state.listRequests;

      issue.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(screen.queryByText(/Your ETA notice to/)).not.toBeInTheDocument();
      expect(screen.queryByRole('form', { name: 'Issue ETA notice' })).not.toBeInTheDocument();
      expect(state.listRequests).toBe(listRequestsBefore);
      const claireScope = `${claire.user.id}:${claire.organization.id}`;
      for (const query of protectedQueries(queryClient)) {
        expect(query.queryKey[1]).toBe(claireScope);
        expect(query.state.isInvalidated).toBe(false);
      }
    });

    it('lets an acknowledgement response write nothing after a sign-out', async () => {
      servePage({ contracts: contractList(asBuyer), notices: [awaitingForBuyer] });
      const acknowledgement = serveAcknowledgement(
        () =>
          HttpResponse.json(
            acknowledged(awaitingForBuyer, claireActor, '2030-10-16T13:30:00.000Z'),
          ),
        { hold: true },
      );
      const { router, user, queryClient } = renderRoute(page, { signedInAs: claire });
      await noticeItems();
      await user.click(screen.getByRole('button', { name: 'Acknowledge receipt' }));
      await acknowledgement.received;

      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(
        await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
      ).toBeInTheDocument();

      acknowledgement.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(router.state.location.pathname).toBe('/sign-in');
      expect(protectedQueries(queryClient)).toEqual([]);
    });
  });
});
