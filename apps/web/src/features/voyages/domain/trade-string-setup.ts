import {
  type CurrentUser,
  type OrganizationRef,
  TRADE_STRING_MAX_PARTIES,
  type TradeRole,
  type TradeString,
  type VoyageDetail,
} from '@tradeflow/contracts';

/*
 * Setting up a new voyage's trade string (ADR 0016), as the page decides what to offer. Only a
 * convenience: the API checks everything again, under the voyage's lock, and answers 403, 404 or
 * 409 to anyone the page should not have offered it to.
 */

/** Organizations after the exporter: the setup names at most ten in all, the exporter included. */
export const MAX_DOWNSTREAM_PARTIES = TRADE_STRING_MAX_PARTIES - 1;

export type SetupUnavailableReason = 'VIEWER' | 'NOT_PLANNED' | 'OTHER_PARTICIPANTS';

export type SetupAvailability =
  /** Not this user's to set up, or nothing left to set up: the page shows nothing about it. */
  | { kind: 'hidden' }
  | { kind: 'available' }
  /** The exporter's, still empty, but not something this user can set up here: say why. */
  | { kind: 'unavailable'; reason: SetupUnavailableReason };

export const SETUP_UNAVAILABLE: Record<SetupUnavailableReason, string> = {
  VIEWER: 'Only an operator of your organization can set up the trade string.',
  NOT_PLANNED: 'Only a planned voyage can have its trade string set up here.',
  OTHER_PARTICIPANTS:
    'Other organizations already take part in this voyage, so its trade string cannot be set up here.',
};

const isExporterOf = (identity: CurrentUser, voyage: VoyageDetail) =>
  voyage.participants.some(
    ({ role, organization }) => role === 'EXPORTER' && organization.id === identity.organization.id,
  );

/**
 * Whether `identity` may set up the voyage's trade string: an operator of its exporter, on a
 * PLANNED voyage with no contracts and no participant but the exporter. The same conditions, in
 * the same spirit, as the API's; once the string exists there is nothing to offer.
 */
export function tradeStringSetupAvailability(
  identity: CurrentUser,
  voyage: VoyageDetail,
  tradeString: TradeString,
): SetupAvailability {
  if (!isExporterOf(identity, voyage) || tradeString.edges.length > 0) {
    return { kind: 'hidden' };
  }
  if (identity.user.role !== 'OPERATOR') return { kind: 'unavailable', reason: 'VIEWER' };
  if (voyage.status !== 'PLANNED') return { kind: 'unavailable', reason: 'NOT_PLANNED' };
  if (voyage.participants.length > 1) {
    return { kind: 'unavailable', reason: 'OTHER_PARTICIPANTS' };
  }
  return { kind: 'available' };
}

export interface PlannedParty {
  organization: OrganizationRef;
  role: TradeRole;
}

export interface PlannedSale {
  position: number;
  seller: OrganizationRef;
  buyer: OrganizationRef;
}

/**
 * The chain the setup would record, as the server will derive it: the exporter first, the last
 * organization the final buyer, every one between a trader, and a contract between each two.
 */
export function plannedChain(exporter: OrganizationRef, downstream: readonly OrganizationRef[]) {
  const organizations = [exporter, ...downstream];
  const last = organizations.length - 1;
  const parties: PlannedParty[] = organizations.map((organization, index) => ({
    organization,
    role: index === 0 ? 'EXPORTER' : index === last ? 'FINAL_BUYER' : 'TRADER',
  }));
  const sales: PlannedSale[] = downstream.map((buyer, index) => ({
    position: index + 1,
    seller: organizations[index] ?? exporter,
    buyer,
  }));
  return { parties, sales };
}
