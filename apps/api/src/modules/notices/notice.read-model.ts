import type { CounterpartyContract, Notice } from '@tradeflow/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import { isOverdue } from './notice-rules.js';

/*
 * Read model for notices: exactly which columns are loaded, and how a row becomes the API
 * contract. The contract the notice belongs to is not joined here: the voyages module resolves
 * it, for the reader, through `CounterpartyContracts`. Actor names and organizations are read
 * through the actor relations, as the voyage read model reads its participants' organizations.
 */

const organizationSelect = { select: { id: true, name: true, countryCode: true } } as const;

export const noticeSelect = {
  id: true,
  voyageId: true,
  tradeContractId: true,
  type: true,
  status: true,
  estimatedArrivalAt: true,
  acknowledgementDueAt: true,
  message: true,
  issuedAt: true,
  issuedByUser: { select: { fullName: true } },
  issuedByOrganization: organizationSelect,
  acknowledgedAt: true,
  acknowledgedByUser: { select: { fullName: true } },
  acknowledgedByOrganization: organizationSelect,
} satisfies Prisma.NoticeSelect;

export type NoticeRow = Prisma.NoticeGetPayload<{ select: typeof noticeSelect }>;

/** Most recently issued first; the id (UUIDv7) breaks ties deterministically. */
export const noticeOrder = [
  { issuedAt: 'desc' },
  { id: 'desc' },
] satisfies Prisma.NoticeOrderByWithRelationInput[];

/**
 * Maps a notice, read as of `now`, for a reader who is a party to `contract`. Overdue is derived
 * here, never stored.
 */
export function toNotice(row: NoticeRow, contract: CounterpartyContract, now: Date): Notice {
  const acknowledged =
    row.acknowledgedAt && row.acknowledgedByUser && row.acknowledgedByOrganization
      ? {
          acknowledgedAt: row.acknowledgedAt.toISOString(),
          acknowledgedBy: {
            name: row.acknowledgedByUser.fullName,
            organization: row.acknowledgedByOrganization,
          },
        }
      : { acknowledgedAt: null, acknowledgedBy: null };
  return {
    id: row.id,
    voyageId: row.voyageId,
    type: row.type,
    status: row.status,
    contract,
    estimatedArrivalAt: row.estimatedArrivalAt.toISOString(),
    acknowledgementDueAt: row.acknowledgementDueAt.toISOString(),
    message: row.message,
    issuedAt: row.issuedAt.toISOString(),
    issuedBy: { name: row.issuedByUser.fullName, organization: row.issuedByOrganization },
    ...acknowledged,
    overdue: isOverdue(row, now),
  };
}
