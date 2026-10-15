import type { ParticipantRole, TradeRole } from '@tradeflow/contracts';

/*
 * Domain rules for a voyage's trade string: the sale contracts that carry the cargo from the
 * exporter to the final buyer. The database guarantees each contract row on its own (positive,
 * unique positions; two distinct participants of the same voyage; nobody selling or buying twice).
 * This module checks the chain as a whole, which no single row can see.
 *
 * A valid trade string is linear:
 *
 *   position 1            position 2            position n
 *   EXPORTER ──sells to──▶ TRADER ──sells to──▶ … ──sells to──▶ FINAL_BUYER
 *
 * - positions are exactly 1..n, without gaps or repeats;
 * - each contract's buyer is the next contract's seller (the same participant);
 * - no organization sells twice, buys twice (a branch) or appears twice in the chain (a cycle);
 * - the exporter sells first, the final buyer buys last, and everyone between is a trader;
 * - service providers (surveyors, shipping agents) are never counterparties.
 *
 * No contracts at all is valid: a newly created voyage has no trade string yet.
 */

/** A voyage participant as the trade string sees it. */
export interface TradeStringParticipant {
  participantId: string;
  organizationId: string;
  role: ParticipantRole;
}

export interface TradeStringContract<P extends TradeStringParticipant = TradeStringParticipant> {
  position: number;
  seller: P;
  buyer: P;
}

export type TradeStringViolationCode =
  | 'POSITIONS_NOT_CONTIGUOUS'
  | 'SAME_COUNTERPARTY'
  | 'SERVICE_PROVIDER_COUNTERPARTY'
  | 'DISCONNECTED'
  | 'BRANCH'
  | 'CYCLE'
  | 'MUST_START_WITH_EXPORTER'
  | 'MUST_END_WITH_FINAL_BUYER'
  | 'INTERMEDIARY_MUST_BE_TRADER';

export interface TradeStringViolation {
  code: TradeStringViolationCode;
  /** The contract the violation was found at, when it concerns one contract. */
  position?: number;
  message: string;
}

/** A trade string that passed validation: contracts in position order, parties in chain order. */
export interface LinearTradeString<P extends TradeStringParticipant> {
  contracts: TradeStringContract<P>[];
  parties: (P & { role: TradeRole })[];
}

export class InvalidTradeStringError extends Error {
  constructor(readonly violations: TradeStringViolation[]) {
    super(`Invalid trade string: ${violations.map((v) => v.message).join('; ')}`);
    this.name = 'InvalidTradeStringError';
  }
}

const SERVICE_PROVIDER_ROLES: ReadonlySet<ParticipantRole> = new Set([
  'SURVEYOR',
  'SHIPPING_AGENT',
]);

const ROLE_LABELS: Record<ParticipantRole, string> = {
  EXPORTER: 'the exporter',
  TRADER: 'a trader',
  FINAL_BUYER: 'the final buyer',
  SURVEYOR: 'a surveyor',
  SHIPPING_AGENT: 'a shipping agent',
};

const byPosition = (a: TradeStringContract, b: TradeStringContract) => a.position - b.position;

/** Organizations that occur more than once in `parties`. */
function repeatedOrganizations(parties: readonly TradeStringParticipant[]): Set<string> {
  const seen = new Set<string>();
  const repeated = new Set<string>();
  for (const { organizationId } of parties) {
    if (seen.has(organizationId)) repeated.add(organizationId);
    seen.add(organizationId);
  }
  return repeated;
}

/** Every rule the chain breaks, in a stable order. An empty result means the chain is valid. */
export function validateTradeString(
  contracts: readonly TradeStringContract[],
): TradeStringViolation[] {
  const violations: TradeStringViolation[] = [];
  const sorted = contracts.toSorted(byPosition);
  const last = sorted.length - 1;

  const positions = sorted.map((contract) => contract.position);
  if (positions.some((position, index) => position !== index + 1)) {
    violations.push({
      code: 'POSITIONS_NOT_CONTIGUOUS',
      message: `Contract positions must run 1 to ${sorted.length} without gaps or repeats, found ${positions.join(', ')}`,
    });
  }

  sorted.forEach((contract, index) => {
    const { position, seller, buyer } = contract;
    if (
      seller.participantId === buyer.participantId ||
      seller.organizationId === buyer.organizationId
    ) {
      violations.push({
        code: 'SAME_COUNTERPARTY',
        position,
        message: `Contract ${position}: an organization cannot sell to itself`,
      });
    }

    for (const [side, party] of [
      ['seller', seller],
      ['buyer', buyer],
    ] as const) {
      if (SERVICE_PROVIDER_ROLES.has(party.role)) {
        violations.push({
          code: 'SERVICE_PROVIDER_COUNTERPARTY',
          position,
          message: `Contract ${position}: the ${side} is ${ROLE_LABELS[party.role]}, and service providers cannot buy or sell the cargo`,
        });
      }
    }

    const previous = sorted[index - 1];
    if (previous && previous.buyer.participantId !== seller.participantId) {
      violations.push({
        code: 'DISCONNECTED',
        position,
        message: `Contract ${position}: the seller must be the buyer under contract ${previous.position}`,
      });
    }

    // Service providers are already reported above; do not report them twice.
    const expectedSeller: ParticipantRole = index === 0 ? 'EXPORTER' : 'TRADER';
    if (seller.role !== expectedSeller && !SERVICE_PROVIDER_ROLES.has(seller.role)) {
      violations.push({
        code: index === 0 ? 'MUST_START_WITH_EXPORTER' : 'INTERMEDIARY_MUST_BE_TRADER',
        position,
        message: `Contract ${position}: the seller must be ${ROLE_LABELS[expectedSeller]}, not ${ROLE_LABELS[seller.role]}`,
      });
    }
    const expectedBuyer: ParticipantRole = index === last ? 'FINAL_BUYER' : 'TRADER';
    if (buyer.role !== expectedBuyer && !SERVICE_PROVIDER_ROLES.has(buyer.role)) {
      violations.push({
        code: index === last ? 'MUST_END_WITH_FINAL_BUYER' : 'INTERMEDIARY_MUST_BE_TRADER',
        position,
        message: `Contract ${position}: the buyer must be ${ROLE_LABELS[expectedBuyer]}, not ${ROLE_LABELS[buyer.role]}`,
      });
    }
  });

  // An organization selling (or buying) under two contracts splits the string.
  const branching = new Set([
    ...repeatedOrganizations(sorted.map((contract) => contract.seller)),
    ...repeatedOrganizations(sorted.map((contract) => contract.buyer)),
  ]);
  if (branching.size > 0) {
    violations.push({
      code: 'BRANCH',
      message:
        'The trade string branches: an organization sells or buys under more than one contract',
    });
  }

  // Walking a connected chain, an organization met again means the cargo loops back to it.
  // (A disconnected chain has no single walk; it is reported as such above.)
  const first = sorted[0];
  if (first && !violations.some((violation) => violation.code === 'DISCONNECTED')) {
    const chain = [first.seller, ...sorted.map((contract) => contract.buyer)];
    if (repeatedOrganizations(chain).size > 0) {
      violations.push({
        code: 'CYCLE',
        message: 'The trade string loops: an organization appears in it more than once',
      });
    }
  }

  return violations;
}

/**
 * Validates `contracts` and returns them in position order, with the parties in chain order
 * (the exporter, each trader in turn, the final buyer). Throws `InvalidTradeStringError` when
 * any rule is broken.
 */
export function toLinearTradeString<P extends TradeStringParticipant>(
  contracts: readonly TradeStringContract<P>[],
): LinearTradeString<P> {
  const violations = validateTradeString(contracts);
  if (violations.length > 0) {
    throw new InvalidTradeStringError(violations);
  }
  const sorted = contracts.toSorted(byPosition);
  const first = sorted[0];
  const parties = first ? [first.seller, ...sorted.map((contract) => contract.buyer)] : [];
  // Validation has established every party's role: exporter, traders, final buyer.
  return { contracts: sorted, parties: parties as (P & { role: TradeRole })[] };
}
