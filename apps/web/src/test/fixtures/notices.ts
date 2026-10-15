import type {
  CounterpartyContract,
  CounterpartyContractListResponse,
  Notice,
  NoticeActor,
} from '@tradeflow/contracts';
import { aVoyageDetail, tradeParties } from './voyages';

const { cerrado, lacustra, nordlys } = tradeParties;

/** Typed against the shared contract, so fixtures cannot drift from what the API returns. */
export function aCounterpartyContract(
  overrides: Partial<CounterpartyContract> = {},
): CounterpartyContract {
  // Contract 1 of TF-2026-0001: Cerrado sells to Lacustra. Seen by Cerrado, the seller.
  return {
    id: '01990000-0000-7000-8008-000000000101',
    position: 1,
    side: 'SELLER',
    seller: cerrado.organization,
    buyer: lacustra.organization,
    ...overrides,
  };
}

/** Contract 2 of TF-2026-0001, Lacustra → Nordlys, seen by Lacustra (the seller). */
export const lacustraSellsToNordlys = (): CounterpartyContract =>
  aCounterpartyContract({
    id: '01990000-0000-7000-8008-000000000102',
    position: 2,
    side: 'SELLER',
    seller: lacustra.organization,
    buyer: nordlys.organization,
  });

export const contractList = (
  ...items: CounterpartyContract[]
): CounterpartyContractListResponse => ({ items });

export const ana: NoticeActor = { name: 'Ana Souza', organization: cerrado.organization };
export const claire: NoticeActor = { name: 'Claire Morel', organization: lacustra.organization };

/** An ETA notice under contract 1, issued by Ana, awaiting acknowledgement. */
export function aNotice(overrides: Partial<Notice> = {}): Notice {
  return {
    id: '01990000-0000-7000-8009-000000000001',
    voyageId: aVoyageDetail().id,
    type: 'ETA',
    status: 'ISSUED',
    contract: aCounterpartyContract(),
    estimatedArrivalAt: '2030-10-25T17:00:00.000Z',
    acknowledgementDueAt: '2030-10-20T15:00:00.000Z',
    message: 'MV Horizon sailed Santos fully loaded.',
    issuedAt: '2030-10-15T12:00:00.000Z',
    issuedBy: ana,
    acknowledgedAt: null,
    acknowledgedBy: null,
    overdue: false,
    ...overrides,
  };
}

/** `notice` as acknowledged by `by` at `at`. */
export const acknowledged = (notice: Notice, by: NoticeActor, at: string): Notice => ({
  ...notice,
  status: 'ACKNOWLEDGED',
  acknowledgedAt: at,
  acknowledgedBy: by,
  overdue: false,
});
