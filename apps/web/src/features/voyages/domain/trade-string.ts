import type { TradeString, TradeStringParty } from '@tradeflow/contracts';

export interface TradeStringStep {
  party: TradeStringParty;
  /** This party's sale to the next one; absent for the final buyer. */
  sale?: { position: number; buyer: TradeStringParty };
}

/**
 * The trade string in the order the cargo is sold, built from the contracts' explicit positions,
 * never from party names or roles: each contract's seller in turn, then the last buyer. Empty
 * while no contracts are recorded.
 */
export function tradeStringSteps({ parties, edges }: TradeString): TradeStringStep[] {
  const byOrganization = new Map(parties.map((party) => [party.organization.id, party]));
  const party = (organizationId: string): TradeStringParty => {
    const found = byOrganization.get(organizationId);
    if (!found) {
      // The API layer refuses such responses (see fetchTradeString); this is a programming error.
      throw new Error(`Trade string edge names unlisted organization ${organizationId}`);
    }
    return found;
  };

  const sorted = edges.toSorted((a, b) => a.position - b.position);
  const last = sorted.at(-1);
  if (!last) {
    return [];
  }
  return [
    ...sorted.map((edge) => ({
      party: party(edge.sellerOrganizationId),
      sale: { position: edge.position, buyer: party(edge.buyerOrganizationId) },
    })),
    { party: party(last.buyerOrganizationId) },
  ];
}
