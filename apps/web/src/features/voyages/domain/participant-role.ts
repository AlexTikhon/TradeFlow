import type { ParticipantRole, VoyageParticipant } from '@tradeflow/contracts';

type ParticipantCategory = 'TRADE_PARTY' | 'SERVICE_PROVIDER';

const ROLES: Record<ParticipantRole, { label: string; category: ParticipantCategory }> = {
  EXPORTER: { label: 'Exporter', category: 'TRADE_PARTY' },
  TRADER: { label: 'Trader', category: 'TRADE_PARTY' },
  FINAL_BUYER: { label: 'Final buyer', category: 'TRADE_PARTY' },
  SURVEYOR: { label: 'Surveyor', category: 'SERVICE_PROVIDER' },
  SHIPPING_AGENT: { label: 'Shipping agent', category: 'SERVICE_PROVIDER' },
};

export const participantRoleLabel = (role: ParticipantRole) => ROLES[role].label;

/**
 * Trade parties hold commercial positions in the cargo (and will form the trade string);
 * service providers act on the cargo for one of them. Order from the API is preserved.
 */
export function groupParticipants(participants: VoyageParticipant[]) {
  return {
    tradeParties: participants.filter((p) => ROLES[p.role].category === 'TRADE_PARTY'),
    serviceProviders: participants.filter((p) => ROLES[p.role].category === 'SERVICE_PROVIDER'),
  };
}
