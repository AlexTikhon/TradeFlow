import { screen, waitFor, within } from '@testing-library/react';
import type {
  CreateVoyageRequest,
  ProblemDetails,
  VoyageDetail,
  VoyageListResponse,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../../test/fixtures/auth';
import {
  horizon,
  nordicHarvest,
  rotterdam,
  santos,
  soybeans,
} from '../../../test/fixtures/reference-data';
import { aVoyageDetail } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from '../../auth/session-sync';

const ana = aCurrentUser();
const claire = anotherUser();
const anaAsViewer = aCurrentUser({ user: { ...ana.user, role: 'VIEWER' } });

const created: VoyageDetail = aVoyageDetail({
  id: '01990000-0000-7000-8006-000000000042',
  reference: 'TF-2026-0042',
  status: 'PLANNED',
  quantity: { amount: '50000.125', unit: 'MT' },
  laycan: { start: '2026-11-01', end: '2026-11-10' },
  participants: [{ role: 'EXPORTER', organization: ana.organization }],
});

const expectedRequest: CreateVoyageRequest = {
  vesselId: horizon.id,
  commodityId: soybeans.id,
  quantity: { amount: '50000.125', unit: 'MT' },
  loadPortId: santos.id,
  dischargePortId: rotterdam.id,
  laycan: { start: '2026-11-01', end: '2026-11-10' },
};

function serveReferenceData() {
  const requests: string[] = [];
  const list = (path: string, items: readonly object[]) => () => {
    requests.push(path);
    return HttpResponse.json({ items });
  };
  server.use(
    http.get('*/api/vessels', list('vessels', [horizon, nordicHarvest])),
    http.get('*/api/commodities', list('commodities', [soybeans])),
    http.get('*/api/ports', list('ports', [rotterdam, santos])),
  );
  return requests;
}

function serveVoyageList(items = [created]) {
  const requests: Request[] = [];
  server.use(
    http.get('*/api/voyages', ({ request }) => {
      requests.push(request);
      const body: VoyageListResponse = { items };
      return HttpResponse.json(body);
    }),
    http.get(`*/api/voyages/${created.id}`, () => HttpResponse.json(created)),
  );
  return requests;
}

/**
 * Serves `POST /api/voyages` with `respond`, recording each body. With `hold`, responses wait
 * for `release()`, so a test can change who is signed in while the request is in flight.
 */
function serveCreation({
  respond = () => HttpResponse.json(created, { status: 201 }),
  hold = false,
}: { respond?: () => Response; hold?: boolean } = {}) {
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
    http.post('*/api/voyages', async ({ request }) => {
      bodies.push(await request.json());
      arrived();
      if (hold) await gate;
      return respond();
    }),
  );
  return { bodies, received, release };
}

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

type User = ReturnType<typeof renderRoute>['user'];

async function fillForm(user: User, values: Partial<Record<string, string>> = {}) {
  const v = {
    vessel: 'MV Horizon (IMO 9341237)',
    commodity: 'Soybeans',
    quantity: '50000.125',
    loadPort: 'Santos (BRSSZ)',
    dischargePort: 'Rotterdam (NLRTM)',
    start: '2026-11-01',
    end: '2026-11-10',
    ...values,
  };
  // The selects are enabled once the reference data has arrived.
  await screen.findAllByRole('option', { name: v.loadPort });
  const form = within(screen.getByRole('form', { name: 'New voyage' }));
  if (v.vessel) await user.selectOptions(form.getByLabelText(/Vessel/), v.vessel);
  if (v.commodity) await user.selectOptions(form.getByLabelText(/Commodity/), v.commodity);
  if (v.quantity) await user.type(form.getByLabelText(/Quantity/), v.quantity);
  if (v.loadPort) await user.selectOptions(form.getByLabelText(/Load port/), v.loadPort);
  if (v.dischargePort) {
    await user.selectOptions(form.getByLabelText(/Discharge port/), v.dischargePort);
  }
  if (v.start) await user.type(form.getByLabelText(/Laycan start/), v.start);
  if (v.end) await user.type(form.getByLabelText(/Laycan end/), v.end);
}

const submit = (user: User) => user.click(screen.getByRole('button', { name: 'Create voyage' }));

type Client = ReturnType<typeof renderRoute>['queryClient'];

const protectedQueries = (queryClient: Client) =>
  queryClient.getQueryCache().findAll({ queryKey: ['protected'] });

const failedMutations = (queryClient: Client) =>
  queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status === 'error');

/** The form as the user left it: what they typed and selected is still there. */
function expectFormKept() {
  expect(screen.getByLabelText(/Vessel/)).toHaveValue(horizon.id);
  expect(screen.getByLabelText(/Commodity/)).toHaveValue(soybeans.id);
  expect(screen.getByLabelText(/Quantity/)).toHaveValue('50000.125');
  expect(screen.getByLabelText(/Load port/)).toHaveValue(santos.id);
  expect(screen.getByLabelText(/Discharge port/)).toHaveValue(rotterdam.id);
  expect(screen.getByLabelText(/Laycan start/)).toHaveValue('2026-11-01');
  expect(screen.getByLabelText(/Laycan end/)).toHaveValue('2026-11-10');
}

async function signInAs(user: User, email: string) {
  await user.type(await screen.findByLabelText(/Email/), email);
  await user.type(screen.getByLabelText(/Password/), TEST_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const watchers: (() => void)[] = [];
afterEach(() => {
  watchers.splice(0).forEach((stop) => {
    stop();
  });
});

describe('NewVoyagePage', () => {
  it('creates the voyage, opens it, and refreshes the voyage list', async () => {
    // Like the real API: the list includes the voyage once it has been created.
    const listed: VoyageDetail[] = [];
    const listRequests = serveVoyageList(listed);
    serveReferenceData();
    const creation = serveCreation({
      respond: () => {
        listed.push(created);
        return HttpResponse.json(created, { status: 201 });
      },
    });
    const { router, user } = renderRoute('/voyages');
    await user.click(await screen.findByRole('link', { name: 'New voyage' }));
    expect(listRequests).toHaveLength(1);

    expect(
      await screen.findByText(/Cerrado Grãos Exportadora S\.A\. will be the exporter/),
    ).toBeInTheDocument();
    await fillForm(user);
    await submit(user);

    expect(await screen.findByRole('heading', { name: 'TF-2026-0042' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe(`/voyages/${created.id}`);
    expect(screen.getByText('Planned')).toBeInTheDocument();
    // Sent exactly as typed: the quantity is the same decimal string, never a number.
    expect(creation.bodies).toEqual([expectedRequest]);

    const breadcrumb = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    await user.click(breadcrumb.getByRole('link', { name: 'Voyages' }));
    expect(await screen.findByRole('link', { name: 'TF-2026-0042' })).toBeInTheDocument();
    expect(listRequests).toHaveLength(2);
  });

  it('checks the form before sending anything', async () => {
    serveReferenceData();
    const creation = serveCreation();
    const { user } = renderRoute('/voyages/new');
    await screen.findAllByRole('option', { name: 'Santos (BRSSZ)' });

    await submit(user);

    expect(await screen.findByText('Select a vessel.')).toBeInTheDocument();
    expect(screen.getByText('Select a commodity.')).toBeInTheDocument();
    expect(screen.getByText('Enter the quantity.')).toBeInTheDocument();
    expect(screen.getByText('Select the load port.')).toBeInTheDocument();
    expect(screen.getByText('Enter the first laycan day.')).toBeInTheDocument();
    expect(creation.bodies).toHaveLength(0);
  });

  it('rejects excess precision, a reversed laycan and a repeated port', async () => {
    serveReferenceData();
    const creation = serveCreation();
    const { user } = renderRoute('/voyages/new');

    await fillForm(user, {
      quantity: '50000.1255',
      dischargePort: 'Santos (BRSSZ)',
      start: '2026-11-10',
      end: '2026-11-01',
    });
    await submit(user);

    expect(await screen.findByText('Use at most 3 decimal places')).toBeInTheDocument();
    expect(screen.getByText('Laycan end must not be before laycan start')).toBeInTheDocument();
    expect(screen.getByText('Discharge port must differ from the load port')).toBeInTheDocument();
    expect(creation.bodies).toHaveLength(0);
  });

  it("shows the server's validation errors on the fields they concern", async () => {
    serveReferenceData();
    serveCreation({
      respond: () =>
        validationProblem([{ path: 'body.vesselId', message: 'No vessel has this id' }]),
    });
    const { router, user } = renderRoute('/voyages/new');

    await fillForm(user);
    await submit(user);

    const vessel = screen.getByLabelText(/Vessel/);
    expect(await screen.findByText('No vessel has this id')).toBeInTheDocument();
    expect(vessel).toHaveAttribute('aria-invalid', 'true');
    expect(router.state.location.pathname).toBe('/voyages/new');
  });

  it('reports a failure, keeps what was typed, and lets the user try again', async () => {
    serveReferenceData();
    serveCreation({ respond: () => problemResponse(500, 'database unavailable') });
    const { router, user } = renderRoute('/voyages/new');
    await fillForm(user);

    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The voyage could not be created. Please try again.',
    );
    expect(screen.queryByText(/database unavailable/)).not.toBeInTheDocument();
    expect(screen.getByLabelText(/Quantity/)).toHaveValue('50000.125');
    expect(router.state.location.pathname).toBe('/voyages/new');

    serveVoyageList();
    serveCreation();
    await submit(user);
    expect(await screen.findByRole('heading', { name: 'TF-2026-0042' })).toBeInTheDocument();
  });

  it("reports the server's refusal when the role no longer allows creating voyages", async () => {
    serveReferenceData();
    serveCreation({
      respond: () => problemResponse(403, 'Your role does not allow you to create voyages.'),
    });
    const { user } = renderRoute('/voyages/new');
    await fillForm(user);

    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(
      'Your role does not allow you to create voyages.',
    );
  });

  it.each([
    [
      'permission',
      () => problemResponse(403, 'Your role does not allow you to create voyages.'),
      'Your role does not allow you to create voyages.',
    ],
    [
      'validation',
      () => validationProblem([{ path: 'body', message: 'Laycan is too far ahead.' }]),
      'Laycan is too far ahead.',
    ],
    ['network', () => HttpResponse.error(), 'The voyage could not be created. Please try again.'],
    [
      'server',
      () => problemResponse(500, 'database unavailable'),
      'The voyage could not be created. Please try again.',
    ],
  ])('keeps the session and what was typed after a %s failure', async (_, respond, message) => {
    serveReferenceData();
    const creation = serveCreation({ respond });
    const { router, user, session, queryClient } = renderRoute('/voyages/new');
    await fillForm(user);

    await submit(user);

    expect(await screen.findByRole('alert')).toHaveTextContent(message);
    expectFormKept();
    expect(router.state.location.pathname).toBe('/voyages/new');
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
    expect(queryClient.getQueryData(['session'])).toEqual(ana);
    expect(protectedQueries(queryClient)).not.toEqual([]);
    // Sent once, never retried, and the session is left alone.
    expect(creation.bodies).toHaveLength(1);
    expect(session.signOutRequests).toBe(0);
  });

  describe('when the server answers 401', () => {
    const unauthenticated = () => problemResponse(401, 'Authentication is required.');

    it('ends the session it was sent under and asks to sign in again', async () => {
      serveReferenceData();
      const creation = serveCreation({ respond: unauthenticated });
      const { router, user, session, queryClient } = renderRoute('/voyages/new');
      await fillForm(user);
      // Something protected is still loading when the session turns out to have ended.
      let inFlightAborted = false;
      void queryClient
        .query({
          queryKey: ['protected', `${ana.user.id}:${ana.organization.id}`, 'in-flight'],
          queryFn: ({ signal }) =>
            new Promise((_, reject) => {
              signal.addEventListener('abort', () => {
                inFlightAborted = true;
                reject(new Error('aborted'));
              });
            }),
        })
        .catch(() => undefined);
      // The session expires on the server while the user is filling the form.
      session.current = null;

      await submit(user);

      expect(
        await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/sign-in');
      expect(queryClient.getQueryData(['session'])).toBeNull();
      expect(inFlightAborted).toBe(true);
      await waitFor(() => {
        expect(protectedQueries(queryClient)).toEqual([]);
      });
      // The write is not retried, and the server, which ended the session, is not asked to.
      expect(creation.bodies).toHaveLength(1);
      expect(session.signOutRequests).toBe(0);
      expect(session.log).not.toContain('sign-out received');
    });

    it('does not sign out another user who signed in while it was on its way', async () => {
      serveReferenceData();
      const creation = serveCreation({ hold: true, respond: unauthenticated });
      const { router, user, session, queryClient } = renderRoute('/voyages/new', {
        accounts: [ana, claire],
      });
      const stopSync = startSessionSync(queryClient);
      const otherTab = new BroadcastChannel(SESSION_CHANNEL_NAME);
      watchers.push(() => {
        otherTab.close();
        stopSync();
      });
      await fillForm(user);
      await submit(user);
      await creation.received;

      // Another tab signs in as Claire, which ends Ana's session: her request will be refused.
      session.current = claire;
      otherTab.postMessage(SESSION_CHANGED);
      expect(
        await screen.findByText(/Lacustra Commodities SA will be the exporter/),
      ).toBeInTheDocument();

      creation.release();
      await waitFor(() => {
        expect(failedMutations(queryClient)).toHaveLength(1);
      });

      expect(queryClient.getQueryData(['session'])).toEqual(claire);
      expect(router.state.location.pathname).toBe('/voyages/new');
      expect(screen.getByText('Claire Morel')).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(protectedQueries(queryClient)).not.toEqual([]);
      expect(session.signOutRequests).toBe(0);
    });

    it('does not sign out the same user after they signed out and back in', async () => {
      serveReferenceData();
      const creation = serveCreation({ hold: true, respond: unauthenticated });
      const { router, user, session, queryClient } = renderRoute('/voyages/new');
      await fillForm(user);
      await submit(user);
      await creation.received;

      // Ana signs out, which ends the session her request was sent under, and signs in again.
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      await signInAs(user, ana.user.email);
      // Back on a fresh form. Same user, same organization: only the session itself is new.
      await screen.findAllByRole('option', { name: 'Santos (BRSSZ)' });
      expect(screen.getByLabelText(/Quantity/)).toHaveValue('');
      expect(queryClient.getQueryData(['session'])).toEqual(ana);

      creation.release();
      await waitFor(() => {
        expect(failedMutations(queryClient)).toHaveLength(1);
      });

      expect(queryClient.getQueryData(['session'])).toEqual(ana);
      expect(router.state.location.pathname).toBe('/voyages/new');
      expect(screen.getByRole('form', { name: 'New voyage' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(protectedQueries(queryClient)).not.toEqual([]);
      // Only the sign-out Ana asked for reached the server.
      expect(session.signOutRequests).toBe(1);
    });

    it('does not sign out another user a session check adopted without any notification', async () => {
      serveReferenceData();
      const creation = serveCreation({ hold: true, respond: unauthenticated });
      const { router, user, session, queryClient } = renderRoute('/voyages/new', {
        accounts: [ana, claire],
      });
      await fillForm(user);
      await submit(user);
      await creation.received;

      // The cookie now belongs to Claire, and no other tab says so: only a session check finds out.
      session.current = claire;
      await queryClient.refetchQueries({ queryKey: ['session'] });
      expect(
        await screen.findByText(/Lacustra Commodities SA will be the exporter/),
      ).toBeInTheDocument();
      await screen.findAllByRole('option', { name: 'Santos (BRSSZ)' });
      const claireScope = `${claire.user.id}:${claire.organization.id}`;
      const claireQueries = protectedQueries(queryClient).map((query) => query.queryHash);
      expect(claireQueries).not.toEqual([]);
      for (const query of protectedQueries(queryClient)) {
        expect(query.queryKey[1]).toBe(claireScope);
      }

      creation.release();
      await waitFor(() => {
        expect(failedMutations(queryClient)).toHaveLength(1);
      });

      expect(queryClient.getQueryData(['session'])).toEqual(claire);
      expect(router.state.location.pathname).toBe('/voyages/new');
      expect(screen.getByText('Claire Morel')).toBeInTheDocument();
      expect(screen.getByRole('form', { name: 'New voyage' })).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(protectedQueries(queryClient).map((query) => query.queryHash)).toEqual(claireQueries);
      for (const query of protectedQueries(queryClient)) {
        expect(query.state.isInvalidated).toBe(false);
      }
      expect(session.signOutRequests).toBe(0);
    });

    it('still ends the session after a session check confirmed the same user', async () => {
      serveReferenceData();
      const creation = serveCreation({ hold: true, respond: unauthenticated });
      const { router, user, session, queryClient } = renderRoute('/voyages/new');
      await fillForm(user);
      await submit(user);
      await creation.received;

      // The tab checks the session while the request is in flight: still Ana.
      const checksBefore = session.meRequests;
      await queryClient.refetchQueries({ queryKey: ['session'] });
      expect(session.meRequests).toBe(checksBefore + 1);
      expect(queryClient.getQueryData(['session'])).toEqual(ana);
      // Then her session expires on the server, and her request is refused.
      session.current = null;
      creation.release();

      expect(
        await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
      ).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/sign-in');
      expect(queryClient.getQueryData(['session'])).toBeNull();
      await waitFor(() => {
        expect(protectedQueries(queryClient)).toEqual([]);
      });
      expect(session.signOutRequests).toBe(0);
    });
  });

  it('does not offer creation to a viewer', async () => {
    serveVoyageList();
    renderRoute('/voyages', { signedInAs: anaAsViewer });

    expect(await screen.findByRole('link', { name: 'TF-2026-0042' })).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New voyage' })).not.toBeInTheDocument();
  });

  it('explains to a viewer who opens the form directly, without loading anything', async () => {
    const lookups = serveReferenceData();
    renderRoute('/voyages/new', { signedInAs: anaAsViewer });

    expect(
      await screen.findByRole('heading', { name: 'You cannot create voyages' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New voyage' })).not.toBeInTheDocument();
    expect(lookups).toEqual([]);
  });

  describe('when the identity changes while the request is in flight', () => {
    const settledMutations = (queryClient: ReturnType<typeof renderRoute>['queryClient']) =>
      queryClient
        .getMutationCache()
        .getAll()
        .filter((mutation) => mutation.state.status === 'success');
    const voyageKeys = (queryClient: ReturnType<typeof renderRoute>['queryClient']) =>
      queryClient
        .getQueryCache()
        .getAll()
        .filter((query) => query.queryKey.includes(created.id));

    it("neither navigates nor touches the next identity's cache", async () => {
      serveReferenceData();
      const creation = serveCreation({ hold: true });
      const { router, user, session, queryClient } = renderRoute('/voyages/new', {
        accounts: [ana, claire],
      });
      const stopSync = startSessionSync(queryClient);
      const otherTab = new BroadcastChannel(SESSION_CHANNEL_NAME);
      watchers.push(() => {
        otherTab.close();
        stopSync();
      });
      await fillForm(user);
      await submit(user);
      await creation.received;

      // Another tab signs in as Claire, an operator too: she gets her own empty form here.
      session.current = claire;
      otherTab.postMessage(SESSION_CHANGED);
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      expect(
        await screen.findByText(/Lacustra Commodities SA will be the exporter/),
      ).toBeInTheDocument();

      creation.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(router.state.location.pathname).toBe('/voyages/new');
      expect(screen.getByLabelText(/Quantity/)).toHaveValue('');
      expect(voyageKeys(queryClient)).toEqual([]);
      expect(queryClient.getQueryCache().findAll({ queryKey: ['protected'] })).not.toEqual([]);
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ['protected'] })) {
        expect(query.queryKey[1]).toBe(`${claire.user.id}:${claire.organization.id}`);
        expect(query.state.isInvalidated).toBe(false);
      }
    });

    it('does not navigate away from the sign-in page after a sign-out', async () => {
      serveReferenceData();
      const creation = serveCreation({ hold: true });
      const { router, user, queryClient } = renderRoute('/voyages/new');
      await fillForm(user);
      await submit(user);
      await creation.received;

      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(
        await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
      ).toBeInTheDocument();

      creation.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(router.state.location.pathname).toBe('/sign-in');
      expect(voyageKeys(queryClient)).toEqual([]);
    });
  });
});
