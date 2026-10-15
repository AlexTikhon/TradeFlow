import { screen, within } from '@testing-library/react';
import type { VoyageListResponse } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { aVoyageSummary } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';

const horizon = aVoyageSummary();
const harvest = aVoyageSummary({
  id: '01990000-0000-7000-8006-000000000002',
  reference: 'TF-2026-0002',
  status: 'LOADING',
  vessel: {
    id: '01990000-0000-7000-8003-000000000002',
    name: 'MV Nordic Harvest',
    imoNumber: '9572812',
  },
});

/** Serves the list and filters by status like the real API, recording each request URL. */
function serveVoyages(items = [horizon, harvest]) {
  const requests: URL[] = [];
  server.use(
    http.get('*/api/voyages', ({ request }) => {
      const url = new URL(request.url);
      requests.push(url);
      const status = url.searchParams.get('status');
      const body: VoyageListResponse = {
        items: status ? items.filter((v) => v.status === status) : items,
      };
      return HttpResponse.json(body);
    }),
  );
  return requests;
}

describe('VoyageListPage', () => {
  it('lists voyages with formatted quantity, route and laycan', async () => {
    serveVoyages();
    renderRoute('/voyages');

    const row = (await screen.findByRole('link', { name: 'TF-2026-0001' })).closest('tr');
    expect(row).not.toBeNull();
    const cells = within(row as HTMLElement);
    expect(cells.getByText('MV Horizon')).toBeInTheDocument();
    expect(cells.getByText('50,000 MT')).toBeInTheDocument();
    expect(cells.getByText('Santos → Rotterdam')).toBeInTheDocument();
    expect(cells.getByText('25 Sept – 4 Oct 2026')).toBeInTheDocument();
    expect(cells.getByText('In transit')).toBeInTheDocument();
    expect(screen.getByText('2 voyages')).toBeInTheDocument();
  });

  it('links each voyage to its details page', async () => {
    serveVoyages();
    const { router } = renderRoute('/voyages');

    expect(await screen.findByRole('link', { name: 'TF-2026-0002' })).toHaveAttribute(
      'href',
      `/voyages/${harvest.id}`,
    );
    expect(router.state.location.pathname).toBe('/voyages');
  });

  it('filters by status through the URL and the API', async () => {
    const requests = serveVoyages();
    const { router, user } = renderRoute('/voyages');
    await screen.findByRole('link', { name: 'TF-2026-0001' });

    await user.selectOptions(screen.getByLabelText('Status'), 'LOADING');

    expect(await screen.findByText('1 voyage')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'TF-2026-0001' })).not.toBeInTheDocument();
    expect(router.state.location.search).toBe('?status=LOADING');
    expect(requests.at(-1)?.searchParams.get('status')).toBe('LOADING');
  });

  it('restores the filter from the URL and ignores unknown statuses', async () => {
    const requests = serveVoyages();
    renderRoute('/voyages?status=BOGUS');

    await screen.findByRole('link', { name: 'TF-2026-0001' });
    expect(screen.getByLabelText('Status')).toHaveValue('');
    expect(requests[0]?.searchParams.has('status')).toBe(false);
  });

  it('shows an empty state when nothing matches', async () => {
    serveVoyages([]);
    renderRoute('/voyages');

    expect(await screen.findByText('No voyages match this filter.')).toBeInTheDocument();
  });

  it('shows a safe error message and recovers on retry', async () => {
    serveVoyages();
    // Registered last so it takes precedence, and only for the first request.
    server.use(
      http.get('*/api/voyages', () => problemResponse(500, 'db exploded'), { once: true }),
    );
    const { user } = renderRoute('/voyages');

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Voyages could not be loaded');
    expect(alert).not.toHaveTextContent('db exploded');

    await user.click(within(alert).getByRole('button', { name: 'Retry' }));
    expect(await screen.findByRole('link', { name: 'TF-2026-0001' })).toBeInTheDocument();
  });
});
