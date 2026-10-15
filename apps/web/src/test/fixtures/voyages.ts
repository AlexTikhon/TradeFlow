import type {
  TradeString,
  TradeStringParty,
  VoyageDetail,
  VoyageSummary,
} from '@tradeflow/contracts';

/** Typed against the shared contract, so fixtures cannot drift from what the API returns. */
export function aVoyageDetail(overrides: Partial<VoyageDetail> = {}): VoyageDetail {
  return {
    id: '01990000-0000-7000-8006-000000000001',
    reference: 'TF-2026-0001',
    status: 'IN_TRANSIT',
    vessel: {
      id: '01990000-0000-7000-8003-000000000001',
      name: 'MV Horizon',
      imoNumber: '9341237',
    },
    commodity: { id: '01990000-0000-7000-8004-000000000001', code: 'SOYBEANS', name: 'Soybeans' },
    quantity: { amount: '50000.000', unit: 'MT' },
    loadPort: {
      id: '01990000-0000-7000-8005-000000000001',
      unLocode: 'BRSSZ',
      name: 'Santos',
      countryCode: 'BR',
    },
    dischargePort: {
      id: '01990000-0000-7000-8005-000000000005',
      unLocode: 'NLRTM',
      name: 'Rotterdam',
      countryCode: 'NL',
    },
    laycan: { start: '2026-09-25', end: '2026-10-04' },
    createdAt: '2026-09-01T08:30:00.000Z',
    updatedAt: '2026-10-01T12:00:00.000Z',
    participants: [
      {
        role: 'EXPORTER',
        organization: {
          id: '01990000-0000-7000-8001-000000000001',
          name: 'Cerrado Grãos Exportadora S.A.',
          countryCode: 'BR',
        },
      },
      {
        role: 'TRADER',
        organization: {
          id: '01990000-0000-7000-8001-000000000004',
          name: 'Lacustra Commodities SA',
          countryCode: 'CH',
        },
      },
      {
        role: 'FINAL_BUYER',
        organization: {
          id: '01990000-0000-7000-8001-000000000007',
          name: 'Rhine Valley Crushers GmbH',
          countryCode: 'DE',
        },
      },
      {
        role: 'SURVEYOR',
        organization: {
          id: '01990000-0000-7000-8001-000000000011',
          name: 'Atlas Cargo Inspection B.V.',
          countryCode: 'NL',
        },
      },
    ],
    ...overrides,
  };
}

/** Trade parties from the demo data, by short name. */
export const tradeParties = {
  cerrado: {
    role: 'EXPORTER',
    organization: {
      id: '01990000-0000-7000-8001-000000000001',
      name: 'Cerrado Grãos Exportadora S.A.',
      countryCode: 'BR',
    },
  },
  lacustra: {
    role: 'TRADER',
    organization: {
      id: '01990000-0000-7000-8001-000000000004',
      name: 'Lacustra Commodities SA',
      countryCode: 'CH',
    },
  },
  nordlys: {
    role: 'TRADER',
    organization: {
      id: '01990000-0000-7000-8001-000000000005',
      name: 'Nordlys Trading B.V.',
      countryCode: 'NL',
    },
  },
  meridian: {
    role: 'TRADER',
    organization: {
      id: '01990000-0000-7000-8001-000000000006',
      name: 'Meridian Agri Trading Pte. Ltd.',
      countryCode: 'SG',
    },
  },
  rhine: {
    role: 'FINAL_BUYER',
    organization: {
      id: '01990000-0000-7000-8001-000000000007',
      name: 'Rhine Valley Crushers GmbH',
      countryCode: 'DE',
    },
  },
} satisfies Record<string, TradeStringParty>;

/**
 * The trade string through `chain`, in order: contract 1 from the first party to the second, and
 * so on. Defaults to the string of `aVoyageDetail()`: Cerrado → Lacustra → Rhine Valley.
 */
export function aTradeString(
  chain: TradeStringParty[] = [tradeParties.cerrado, tradeParties.lacustra, tradeParties.rhine],
): TradeString {
  return {
    parties: chain,
    edges: chain.slice(1).map((buyer, index) => ({
      position: index + 1,
      sellerOrganizationId: chain[index]?.organization.id ?? '',
      buyerOrganizationId: buyer.organization.id,
    })),
  };
}

export const anEmptyTradeString = (): TradeString => ({ parties: [], edges: [] });

export function aVoyageSummary(overrides: Partial<VoyageSummary> = {}): VoyageSummary {
  const { participants: _participants, createdAt: _createdAt, ...summary } = aVoyageDetail();
  return { ...summary, ...overrides };
}
