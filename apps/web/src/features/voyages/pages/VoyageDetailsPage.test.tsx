import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { aVoyageDetail } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';

const voyage = aVoyageDetail();

describe('VoyageDetailsPage', () => {
  it('shows the shipment facts', async () => {
    server.use(http.get(`*/api/voyages/${voyage.id}`, () => HttpResponse.json(voyage)));
    renderRoute(`/voyages/${voyage.id}`);

    expect(await screen.findByRole('heading', { name: 'TF-2026-0001' })).toBeInTheDocument();
    expect(screen.getByText('In transit')).toBeInTheDocument();
    expect(screen.getByText('Soybeans')).toBeInTheDocument();
    expect(screen.getByText('50,000 MT')).toBeInTheDocument();
    expect(screen.getByText('Santos, Brazil (BRSSZ)')).toBeInTheDocument();
    expect(screen.getByText('Rotterdam, Netherlands (NLRTM)')).toBeInTheDocument();
    expect(screen.getByText('IMO 9341237')).toBeInTheDocument();
  });

  it('separates trade parties from service providers, preserving trade-flow order', async () => {
    server.use(http.get(`*/api/voyages/${voyage.id}`, () => HttpResponse.json(voyage)));
    renderRoute(`/voyages/${voyage.id}`);

    const tradeParties = await screen.findByRole('table', { name: 'Trade parties' });
    const rows = within(tradeParties).getAllByRole('row').slice(1);
    expect(rows.map((row) => row.textContent)).toEqual([
      'ExporterCerrado Grãos Exportadora S.A.Brazil',
      'TraderLacustra Commodities SASwitzerland',
      'Final buyerRhine Valley Crushers GmbHGermany',
    ]);

    const providers = screen.getByRole('table', { name: 'Service providers' });
    expect(within(providers).getByText('Atlas Cargo Inspection B.V.')).toBeInTheDocument();
  });

  it('shows "not found" when the API returns 404', async () => {
    server.use(
      http.get(`*/api/voyages/${voyage.id}`, () => problemResponse(404, 'Voyage was not found.')),
    );
    renderRoute(`/voyages/${voyage.id}`);

    expect(await screen.findByRole('heading', { name: 'Voyage not found' })).toBeInTheDocument();
  });

  it('answers "not found" for a malformed id without calling the API', async () => {
    // No handler is registered: any request would fail the test (onUnhandledRequest: 'error').
    renderRoute('/voyages/not-a-voyage-id');

    expect(await screen.findByRole('heading', { name: 'Voyage not found' })).toBeInTheDocument();
  });

  it('reports a response that violates the API contract instead of rendering garbage', async () => {
    server.use(
      http.get(`*/api/voyages/${voyage.id}`, () =>
        HttpResponse.json({ ...voyage, quantity: { amount: 50000, unit: 'MT' } }),
      ),
    );
    renderRoute(`/voyages/${voyage.id}`);

    expect(await screen.findByRole('alert')).toHaveTextContent('Voyage could not be loaded');
  });
});
