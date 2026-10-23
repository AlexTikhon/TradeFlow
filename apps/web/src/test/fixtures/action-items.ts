import type { ActionItem, ActionItemPage } from '@tradeflow/contracts';
import { aDocument } from './documents';
import { aCounterpartyContract, aNotice, lacustraSellsToNordlys } from './notices';
import { aVoyageDetail, tradeParties } from './voyages';

/*
 * The Action Center as Lacustra sees it on TF-2026-0001: it buys under contract 1 (from Cerrado)
 * and sells under contract 2 (to Nordlys), so it owes actions of all four kinds.
 */

type ItemOf<T extends ActionItem['type']> = Extract<ActionItem, { type: T }>;

const voyage = aVoyageDetail();
const onVoyage = { voyage: { id: voyage.id, reference: voyage.reference } };
const contract1 = { id: aCounterpartyContract().id, position: 1 };
const contract2 = { id: lacustraSellsToNordlys().id, position: 2 };
const { cerrado, nordlys } = tradeParties;

/** An id numbered `n` in the series `series`, so tests can make as many distinct ones as needed. */
const numbered = (series: string, n: number) =>
  `01990000-0000-7000-${series}-${String(n).padStart(12, '0')}`;

/** Typed against the shared contract, so fixtures cannot drift from what the API returns. */
export function aNoticeAction(
  overrides: Partial<ItemOf<'ACKNOWLEDGE_NOTICE'>> = {},
): ItemOf<'ACKNOWLEDGE_NOTICE'> {
  const noticeId = overrides.target?.noticeId ?? aNotice().id;
  return {
    key: `ACKNOWLEDGE_NOTICE:${noticeId}`,
    type: 'ACKNOWLEDGE_NOTICE',
    ...onVoyage,
    contract: contract1,
    counterparty: cerrado.organization,
    issuedAt: '2030-10-15T12:00:00.000Z',
    acknowledgementDueAt: '2030-10-20T15:00:00.000Z',
    overdue: false,
    target: { kind: 'NOTICE', voyageId: voyage.id, contractId: contract1.id, noticeId },
    ...overrides,
  };
}

/** The `n`th of as many distinct notice actions as a test needs. */
export const noticeAction = (n: number): ItemOf<'ACKNOWLEDGE_NOTICE'> =>
  aNoticeAction({
    target: {
      kind: 'NOTICE',
      voyageId: voyage.id,
      contractId: contract1.id,
      noticeId: numbered('8009', n),
    },
  });

/** Revision 2 of the instructions Nordlys gave Lacustra under contract 2, unacknowledged. */
export function anInstructionsAction(
  overrides: Partial<ItemOf<'ACKNOWLEDGE_INSTRUCTIONS'>> = {},
): ItemOf<'ACKNOWLEDGE_INSTRUCTIONS'> {
  const instructionId = numbered('800a', 2);
  return {
    key: `ACKNOWLEDGE_INSTRUCTIONS:${instructionId}:2`,
    type: 'ACKNOWLEDGE_INSTRUCTIONS',
    ...onVoyage,
    contract: contract2,
    counterparty: nordlys.organization,
    revisionCreatedAt: '2030-10-16T08:00:00.000Z',
    target: {
      kind: 'INSTRUCTION_REVISION',
      voyageId: voyage.id,
      contractId: contract2.id,
      instructionId,
      revisionNumber: 2,
    },
    ...overrides,
  };
}

/** Version 2 of the bill of lading Cerrado presented under contract 1, awaiting a decision. */
export function aReviewAction(
  overrides: Partial<ItemOf<'REVIEW_DOCUMENT'>> = {},
): ItemOf<'REVIEW_DOCUMENT'> {
  const documentId = aDocument().id;
  return {
    key: `REVIEW_DOCUMENT:${documentId}:2`,
    type: 'REVIEW_DOCUMENT',
    ...onVoyage,
    contract: contract1,
    counterparty: cerrado.organization,
    uploadedAt: '2030-10-17T10:30:00.000Z',
    target: {
      kind: 'DOCUMENT_VERSION',
      voyageId: voyage.id,
      contractId: contract1.id,
      revisionNumber: 1,
      documentType: 'BILL_OF_LADING',
      documentId,
      versionNumber: 2,
    },
    ...overrides,
  };
}

export const REJECTION_REASON = 'The invoice total does not match the contract price.';

/** Version 1 of the commercial invoice Lacustra presented to Nordlys, rejected by Nordlys. */
export function aReplacementAction(
  overrides: Partial<ItemOf<'REPLACE_REJECTED_DOCUMENT'>> = {},
): ItemOf<'REPLACE_REJECTED_DOCUMENT'> {
  const documentId = numbered('800b', 2);
  return {
    key: `REPLACE_REJECTED_DOCUMENT:${documentId}:1`,
    type: 'REPLACE_REJECTED_DOCUMENT',
    ...onVoyage,
    contract: contract2,
    counterparty: nordlys.organization,
    uploadedAt: '2030-10-16T09:00:00.000Z',
    rejectedAt: '2030-10-16T15:00:00.000Z',
    rejectionReason: REJECTION_REASON,
    target: {
      kind: 'DOCUMENT_VERSION',
      voyageId: voyage.id,
      contractId: contract2.id,
      revisionNumber: 1,
      documentType: 'COMMERCIAL_INVOICE',
      documentId,
      versionNumber: 1,
    },
    ...overrides,
  };
}

export const actionPage = (
  items: ActionItem[],
  nextCursor: string | null = null,
  generatedAt = '2030-10-18T12:00:00.000Z',
): ActionItemPage => ({ items, generatedAt, nextCursor });

export const emptyActionPage = (): ActionItemPage => actionPage([]);
