import type { TradeString } from '@tradeflow/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import { toLinearTradeString } from './trade-string.js';

/*
 * Read model for the trade string. Every participant of a voyage may see its topology
 * (ADR 0010), so this select is the allowlist of what they see: each contract's position and
 * its two counterparties' organizations and roles. Anything added to `trade_contracts` later
 * (terms, references) stays out of this response unless it is selected here on purpose.
 */

const counterpartySelect = {
  id: true,
  role: true,
  organization: { select: { id: true, name: true, countryCode: true } },
} satisfies Prisma.VoyageParticipantSelect;

export const tradeStringSelect = {
  tradeContracts: {
    select: {
      position: true,
      seller: { select: counterpartySelect },
      buyer: { select: counterpartySelect },
    },
    orderBy: { position: 'asc' },
  },
} satisfies Prisma.VoyageSelect;

export type TradeStringRow = Prisma.VoyageGetPayload<{ select: typeof tradeStringSelect }>;

type CounterpartyRow = TradeStringRow['tradeContracts'][number]['seller'];

const toParticipant = (row: CounterpartyRow) => ({
  participantId: row.id,
  organizationId: row.organization.id,
  role: row.role,
  organization: row.organization,
});

/**
 * Maps stored contracts to the shared topology. The stored chain is validated first: a chain
 * that breaks the domain rules is a data error, never something to show as if it were valid,
 * so this throws `InvalidTradeStringError`.
 */
export function toTradeString(row: TradeStringRow): TradeString {
  const { contracts, parties } = toLinearTradeString(
    row.tradeContracts.map(({ position, seller, buyer }) => ({
      position,
      seller: toParticipant(seller),
      buyer: toParticipant(buyer),
    })),
  );
  return {
    parties: parties.map(({ organization, role }) => ({ organization, role })),
    edges: contracts.map(({ position, seller, buyer }) => ({
      position,
      sellerOrganizationId: seller.organizationId,
      buyerOrganizationId: buyer.organizationId,
    })),
  };
}
