import type {
  CounterpartyContract,
  CurrentUser,
  DocumentaryInstruction,
  RequiredDocumentType,
} from '@tradeflow/contracts';

/*
 * Presentation rules for documentary instructions. The API decides who may do what (ADR 0012) and
 * checks again on every request; these only decide what to offer.
 */

export const DOCUMENT_LABELS: Record<RequiredDocumentType, string> = {
  BILL_OF_LADING: 'Bill of lading',
  COMMERCIAL_INVOICE: 'Commercial invoice',
  CERTIFICATE_OF_ORIGIN: 'Certificate of origin',
  PHYTOSANITARY_CERTIFICATE: 'Phytosanitary certificate',
  WEIGHT_CERTIFICATE: 'Weight certificate',
  QUALITY_CERTIFICATE: 'Quality certificate',
  FUMIGATION_CERTIFICATE: 'Fumigation certificate',
  INSURANCE_CERTIFICATE: 'Insurance certificate',
};

/** Whether to offer giving or revising: the organization buys under it, the user operates. */
export const canGiveInstructions = (identity: CurrentUser, contract: CounterpartyContract) =>
  identity.user.role === 'OPERATOR' && contract.side === 'BUYER';

/** Whether to offer acknowledging: the organization sells, the user operates, it waits. */
export const canAcknowledgeRevision = (
  identity: CurrentUser,
  instruction: DocumentaryInstruction,
): boolean =>
  identity.user.role === 'OPERATOR' &&
  instruction.contract.side === 'SELLER' &&
  instruction.currentRevision.acknowledgement === null;

const count = (n: number, one: string, many: string) => `${n} ${n === 1 ? one : many}`;

/** "3 originals, 1 copy"; a zero count is left out. */
export function describeCounts(originals: number, copies: number): string {
  return [
    originals > 0 && count(originals, 'original', 'originals'),
    copies > 0 && count(copies, 'copy', 'copies'),
  ]
    .filter(Boolean)
    .join(', ');
}
