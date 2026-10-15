import { screen, waitFor, within } from '@testing-library/react';
import type {
  CreateVoyageRequest,
  ProblemDetails,
  VoyageDetail,
  VoyageListResponse,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser } from '../../../test/fixtures/auth';
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
