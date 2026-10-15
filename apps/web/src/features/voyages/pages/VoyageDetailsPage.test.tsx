import type { TradeString, VoyageDetail } from '@tradeflow/contracts';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import {
  aTradeString,
  aVoyageDetail,
  anEmptyTradeString,
  tradeParties,
} from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';

const voyage = aVoyageDetail();

/**
 * Serves the voyage, its trade string and the notice panel's data, as the details page requests
 * all of them. Notices have their own tests (VoyageNotices.test.tsx); here there are none.
 */
function serveVoyage(
  detail: VoyageDetail = voyage,
  tradeString: TradeString | (() => Response) = aTradeString(),
) {
  server.use(
    http.get(`*/api/voyages/${detail.id}`, () => HttpResponse.json(detail)),
    http.get(`*/api/voyages/${detail.id}/trade-string`, () =>
      typeof tradeString === 'function' ? tradeString() : HttpResponse.json(tradeString),
    ),
    http.get(`*/api/voyages/${detail.id}/my-contracts`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${detail.id}/notices`, () => HttpResponse.json({ items: [] })),
  );
}

describe('VoyageDetailsPage', () => {
  it('shows the shipment facts', async () => {
    serveVoyage();
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
    serveVoyage();
    renderRoute(`/voyages/${voyage.id}`);

    const tradePartiesTable = await screen.findByRole('table', { name: 'Trade parties' });
    const rows = within(tradePartiesTable).getAllByRole('row').slice(1);
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
      http.get(`*/api/voyages/${voyage.id}/trade-string`, () =>
        problemResponse(404, 'Voyage was not found.'),
      ),
      http.get(`*/api/voyages/${voyage.id}/my-contracts`, () =>
        problemResponse(404, 'Voyage was not found.'),
      ),
      http.get(`*/api/voyages/${voyage.id}/notices`, () =>
        problemResponse(404, 'Voyage was not found.'),
      ),
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
    serveVoyage({ ...voyage, quantity: { amount: 50000, unit: 'MT' } } as unknown as VoyageDetail);
    renderRoute(`/voyages/${voyage.id}`);

    expect(await screen.findByRole('alert')).toHaveTextContent('Voyage could not be loaded');
  });

  describe('trade string', () => {
    const findChain = () =>
      screen.findByRole('list', { name: 'Trade string, from exporter to final buyer' });
    /** Each item's party (role, name, country), without the sale that follows it. */
    const partiesIn = (chain: HTMLElement) =>
      within(chain)
        .getAllByRole('listitem')
        .map((item) => item.textContent.split('Sells to')[0]);

    it('shows each party in contract order, with the sale to the next one', async () => {
      serveVoyage();
      renderRoute(`/voyages/${voyage.id}`);

      const chain = await findChain();
      const items = within(chain).getAllByRole('listitem');
      expect(items).toHaveLength(3);
      expect(items[0]).toHaveTextContent('Exporter');
      expect(items[0]).toHaveTextContent('Cerrado Grãos Exportadora S.A.');
      expect(items[0]).toHaveTextContent('Brazil');
      expect(items[0]).toHaveTextContent('Sells to Lacustra Commodities SA under Contract 1');
      expect(items[1]).toHaveTextContent('Trader');
      expect(items[1]).toHaveTextContent('Sells to Rhine Valley Crushers GmbH under Contract 2');
      expect(items[2]).toHaveTextContent('Final buyer');
      expect(items[2]).not.toHaveTextContent('Sells to');
    });

    it('orders several traders by contract position, not by name or response order', async () => {
      const { cerrado, nordlys, lacustra, meridian, rhine } = tradeParties;
      // Contract order N, L, M is neither alphabetical nor the order the API lists them in.
      const tradeString = aTradeString([cerrado, nordlys, lacustra, meridian, rhine]);
      serveVoyage(voyage, {
        parties: [meridian, rhine, lacustra, cerrado, nordlys],
        edges: tradeString.edges.toReversed(),
      });
      renderRoute(`/voyages/${voyage.id}`);

      const chain = await findChain();
      expect(partiesIn(chain)).toEqual([
        'ExporterCerrado Grãos Exportadora S.A.BrazilYour organization',
        'TraderNordlys Trading B.V.Netherlands',
        'TraderLacustra Commodities SASwitzerland',
        'TraderMeridian Agri Trading Pte. Ltd.Singapore',
        'Final buyerRhine Valley Crushers GmbHGermany',
      ]);
      const items = within(chain).getAllByRole('listitem');
      expect(items[1]).toHaveTextContent('Sells to Lacustra Commodities SA under Contract 2');
      expect(items[3]).toHaveTextContent('Sells to Rhine Valley Crushers GmbH under Contract 4');
    });

    it('keeps service providers in the participant directory, not in the string', async () => {
      serveVoyage();
      renderRoute(`/voyages/${voyage.id}`);

      const chain = await findChain();
      expect(within(chain).queryByText('Atlas Cargo Inspection B.V.')).not.toBeInTheDocument();
      expect(
        within(screen.getByRole('table', { name: 'Service providers' })).getByText(
          'Atlas Cargo Inspection B.V.',
        ),
      ).toBeInTheDocument();
    });

    it("marks the signed-in user's organization", async () => {
      serveVoyage();
      renderRoute(`/voyages/${voyage.id}`);

      const items = within(await findChain()).getAllByRole('listitem');
      expect(items[0]).toHaveTextContent('Your organization');
      expect(items[1]).not.toHaveTextContent('Your organization');
    });

    it('explains an empty string, and still lists the participants', async () => {
      serveVoyage(voyage, anEmptyTradeString());
      renderRoute(`/voyages/${voyage.id}`);

      expect(await screen.findByText('Trade string not configured')).toBeInTheDocument();
      expect(screen.getByText(/No sale contracts have been recorded/)).toBeInTheDocument();
      expect(
        screen.queryByRole('list', { name: 'Trade string, from exporter to final buyer' }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('table', { name: 'Trade parties' })).toBeInTheDocument();
    });

    it('reports a failure in its own card and keeps the rest of the page', async () => {
      let attempts = 0;
      serveVoyage(voyage, () => {
        attempts += 1;
        return attempts === 1
          ? problemResponse(500, 'Internal failure')
          : HttpResponse.json(aTradeString());
      });
      const { user } = renderRoute(`/voyages/${voyage.id}`);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Trade string could not be loaded');
      expect(alert).not.toHaveTextContent('Internal failure');
      expect(screen.getByRole('heading', { name: 'TF-2026-0001' })).toBeInTheDocument();
      expect(screen.getByText('50,000 MT')).toBeInTheDocument();

      await user.click(within(alert).getByRole('button', { name: 'Retry' }));

      expect(await findChain()).toBeInTheDocument();
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('refuses a response whose edges name parties it does not list', async () => {
      const { cerrado, rhine } = tradeParties;
      serveVoyage(voyage, { ...aTradeString([cerrado, rhine]), parties: [cerrado] });
      renderRoute(`/voyages/${voyage.id}`);

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'Trade string could not be loaded',
      );
      expect(
        screen.queryByRole('list', { name: 'Trade string, from exporter to final buyer' }),
      ).not.toBeInTheDocument();
    });
  });
});
