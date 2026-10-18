import type { ProblemFieldError, TradeRole } from '@tradeflow/contracts';
import type { EntityTagCondition } from '../../common/http/preconditions.js';
import type {
  TradeStringContract,
  TradeStringParticipant,
  TradeStringViolation,
} from './trade-string.js';

/*
 * The trade string a setup would record (ADR 0016), built before anything is written so that
 * `validateTradeString` checks the complete chain, as it checks every stored one. The request
 * names organizations only; their roles and the contracts' positions follow from the order.
 */

/** A party of the chain being set up: the exporter's participation, or one still to be created. */
export interface CandidateParty extends TradeStringParticipant {
  role: TradeRole;
}

export interface CandidateTradeString {
  /** In chain order: the exporter, each trader in turn, the final buyer. */
  parties: CandidateParty[];
  /** Contract `n` is party `n - 1`'s sale to party `n`. */
  contracts: TradeStringContract<CandidateParty>[];
}

/** Stands in for the id of a participant that does not exist yet. */
const provisionalParticipantId = (index: number) => `provisional-${index}`;

/**
 * The chain from the exporter's existing participation through `downstream`, the organizations
 * it sells through in order: every one but the last a trader, the last the final buyer. New
 * participants carry provisional ids until they are inserted.
 */
export function candidateTradeString(
  exporter: TradeStringParticipant,
  downstream: readonly string[],
): CandidateTradeString {
  const last = downstream.length - 1;
  const parties: CandidateParty[] = [
    // Whatever role the participation really has: the validation reports anything but EXPORTER.
    { ...exporter, role: exporter.role as TradeRole },
    ...downstream.map((organizationId, index) => ({
      participantId: provisionalParticipantId(index + 1),
      organizationId,
      role: index === last ? ('FINAL_BUYER' as const) : ('TRADER' as const),
    })),
  ];
  const contracts = parties.slice(1).map((buyer, index) => ({
    position: index + 1,
    // `parties[index]` exists: `buyer` is `parties[index + 1]`.
    seller: parties[index] as CandidateParty,
    buyer,
  }));
  return { parties, contracts };
}

/** A broken chain as a request validation error: the parties, as named, are the problem. */
export const tradeStringFieldErrors = (
  violations: readonly TradeStringViolation[],
): ProblemFieldError[] => violations.map(({ message }) => ({ path: 'body.parties', message }));

/** The conditional headers a setup request carried, parsed. Neither is required. */
export interface SetupPreconditions {
  ifMatch?: EntityTagCondition | undefined;
  ifNoneMatch?: EntityTagCondition | undefined;
}

/**
 * Evaluates the request's preconditions (RFC 9110, section 13.2.2: If-Match first, then
 * If-None-Match) against the trade string, and returns why one failed, or null. The trade string
 * always has a current representation (an empty one before setup) and never an entity tag, so:
 *
 * - `If-Match: *` holds, and a list of entity tags never does: none can match;
 * - `If-None-Match: *` never holds, and a list of entity tags always does.
 *
 * If-Unmodified-Since is not evaluated: the trade string has no modification date, and a
 * recipient must then ignore it (section 13.1.4). If-Modified-Since and If-Range apply to GET
 * and HEAD only.
 */
export function failedSetupPrecondition({
  ifMatch,
  ifNoneMatch,
}: SetupPreconditions): string | null {
  if (ifMatch?.kind === 'tags') {
    return 'If-Match names an entity tag, but the trade string has none. Send the request without If-Match.';
  }
  if (ifNoneMatch?.kind === 'any') {
    return (
      'If-None-Match: * cannot hold: the trade string always exists, empty until it is set up. ' +
      'Send the request without If-None-Match; a voyage that is already set up answers 409.'
    );
  }
  return null;
}
