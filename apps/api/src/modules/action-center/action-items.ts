import type {
  ActionItem,
  ActionItemContract,
  ActionItemVoyage,
  DocumentReviewDecision,
  DocumentVersionTarget,
  NoticeStatus,
  OrganizationRef,
  RequiredDocumentType,
} from '@tradeflow/contracts';
import { isOverdue } from '../notices/notice-rules.js';

/*
 * The Action Center's rules (ADR 0017): which records ask something of an organization, as pure
 * functions over facts the caller loaded, the organization's id and the caller's clock. Nothing
 * is stored; an action exists exactly while its facts say so.
 *
 * - ACKNOWLEDGE_NOTICE: the organization is the contract's buyer and the notice is still ISSUED.
 *   Overdue exactly as the notice itself is (`isOverdue`: past the deadline, not at it).
 * - ACKNOWLEDGE_INSTRUCTIONS: the organization is the seller and the instruction's current
 *   revision has no acknowledgement.
 * - REVIEW_DOCUMENT: the organization is the buyer, the document answers the current revision,
 *   and its latest file has no decision.
 * - REPLACE_REJECTED_DOCUMENT: the organization is the seller, the document answers the current
 *   revision, and its latest file was rejected.
 *
 * Only the current revision and each document's latest file count. Earlier revisions, earlier
 * files and the decisions on them are history. No action waits on another: a document can be
 * reviewed before its revision is acknowledged, as the commands allow.
 *
 * The side of the contract decides, never the participant role: a trader is the buyer under one
 * contract and the seller under the next. A contract the organization is not a party to yields
 * nothing, whatever facts come with it; the caller must still scope what it loads (ADR 0017).
 */

/** A sale contract with the records under it that can ask for an action. */
export interface ContractFacts {
  id: string;
  position: number;
  voyage: ActionItemVoyage;
  seller: OrganizationRef;
  buyer: OrganizationRef;
  notices: readonly NoticeFacts[];
  /** Null until the buyer gives instructions. */
  instruction: InstructionFacts | null;
  /** The contract's documents, of any revision. */
  documents: readonly DocumentFacts[];
}

export interface NoticeFacts {
  id: string;
  status: NoticeStatus;
  issuedAt: Date;
  acknowledgementDueAt: Date;
}

export interface InstructionFacts {
  id: string;
  currentRevisionNumber: number;
  /** Must include the current revision; earlier ones change nothing. */
  revisions: readonly RevisionFacts[];
}

export interface RevisionFacts {
  number: number;
  createdAt: Date;
  /** Null until the seller acknowledges this revision. */
  acknowledgedAt: Date | null;
}

export interface DocumentFacts {
  id: string;
  /** The instruction revision the document answers. */
  revisionNumber: number;
  documentType: RequiredDocumentType;
  currentVersionNumber: number;
  /** Must include the current (latest) file version; earlier ones change nothing. */
  versions: readonly DocumentVersionFacts[];
}

export interface DocumentVersionFacts {
  number: number;
  uploadedAt: Date;
  review: DocumentReviewFacts | null;
}

export interface DocumentReviewFacts {
  decision: DocumentReviewDecision;
  /** Present exactly for a rejection (a CHECK constraint pairs them). */
  reason: string | null;
  reviewedAt: Date;
}

/**
 * The open actions of `organizationId` under `contracts`, as of `now`, in page order
 * (`compareActionItems`).
 */
export function projectActionItems(
  contracts: readonly ContractFacts[],
  organizationId: string,
  now: Date,
): ActionItem[] {
  return contracts
    .flatMap((contract) => contractActions(contract, organizationId, now))
    .sort(compareActionItems);
}

function contractActions(contract: ContractFacts, organizationId: string, now: Date): ActionItem[] {
  const isBuyer = contract.buyer.id === organizationId;
  const isSeller = contract.seller.id === organizationId;
  if (!isBuyer && !isSeller) {
    return [];
  }

  const base = {
    voyage: { id: contract.voyage.id, reference: contract.voyage.reference },
    contract: { id: contract.id, position: contract.position } satisfies ActionItemContract,
  };
  const targetBase = { voyageId: contract.voyage.id, contractId: contract.id };
  const instruction = contract.instruction;
  const revision = instruction && currentRevision(instruction);
  // Documents answer exactly one revision; only the current one's can still ask for anything.
  const currentDocuments = revision
    ? contract.documents
        .filter((document) => document.revisionNumber === revision.number)
        .map((document) => ({ document, latest: latestVersion(document) }))
    : [];
  const documentTarget = (
    document: DocumentFacts,
    latest: DocumentVersionFacts,
  ): DocumentVersionTarget => ({
    kind: 'DOCUMENT_VERSION',
    ...targetBase,
    revisionNumber: document.revisionNumber,
    documentType: document.documentType,
    documentId: document.id,
    versionNumber: latest.number,
  });

  const items: ActionItem[] = [];

  if (isBuyer) {
    const counterparty = organizationRef(contract.seller);
    for (const notice of contract.notices) {
      if (notice.status !== 'ISSUED') continue;
      items.push({
        ...base,
        counterparty,
        key: actionItemKeys.acknowledgeNotice(notice.id),
        type: 'ACKNOWLEDGE_NOTICE',
        issuedAt: notice.issuedAt.toISOString(),
        acknowledgementDueAt: notice.acknowledgementDueAt.toISOString(),
        overdue: isOverdue(notice, now),
        target: { kind: 'NOTICE', ...targetBase, noticeId: notice.id },
      });
    }
    for (const { document, latest } of currentDocuments) {
      if (latest.review !== null) continue;
      items.push({
        ...base,
        counterparty,
        key: actionItemKeys.reviewDocument(document.id, latest.number),
        type: 'REVIEW_DOCUMENT',
        uploadedAt: latest.uploadedAt.toISOString(),
        target: documentTarget(document, latest),
      });
    }
  }

  if (isSeller) {
    const counterparty = organizationRef(contract.buyer);
    if (instruction && revision && revision.acknowledgedAt === null) {
      items.push({
        ...base,
        counterparty,
        key: actionItemKeys.acknowledgeInstructions(instruction.id, revision.number),
        type: 'ACKNOWLEDGE_INSTRUCTIONS',
        revisionCreatedAt: revision.createdAt.toISOString(),
        target: {
          kind: 'INSTRUCTION_REVISION',
          ...targetBase,
          instructionId: instruction.id,
          revisionNumber: revision.number,
        },
      });
    }
    for (const { document, latest } of currentDocuments) {
      if (latest.review?.decision !== 'REJECTED') continue;
      if (latest.review.reason === null) {
        throw new Error(`Rejection of document ${document.id} v${latest.number} has no reason`);
      }
      items.push({
        ...base,
        counterparty,
        key: actionItemKeys.replaceRejectedDocument(document.id, latest.number),
        type: 'REPLACE_REJECTED_DOCUMENT',
        uploadedAt: latest.uploadedAt.toISOString(),
        rejectedAt: latest.review.reviewedAt.toISOString(),
        rejectionReason: latest.review.reason,
        target: documentTarget(document, latest),
      });
    }
  }

  return items;
}

const organizationRef = ({ id, name, countryCode }: OrganizationRef): OrganizationRef => ({
  id,
  name,
  countryCode,
});

function currentRevision(instruction: InstructionFacts): RevisionFacts {
  const revision = instruction.revisions.find(
    ({ number }) => number === instruction.currentRevisionNumber,
  );
  if (!revision) {
    // A deferred constraint trigger requires the current revision to exist at commit.
    throw new Error(
      `Instruction ${instruction.id} lacks its current revision ${instruction.currentRevisionNumber}`,
    );
  }
  return revision;
}

function latestVersion(document: DocumentFacts): DocumentVersionFacts {
  const version = document.versions.find(({ number }) => number === document.currentVersionNumber);
  if (!version) {
    // A deferred constraint trigger requires the current version to exist at commit.
    throw new Error(
      `Document ${document.id} lacks its current version ${document.currentVersionNumber}`,
    );
  }
  return version;
}

/*
 * Action keys name the action's type and the exact record it concerns, so they are unique across
 * an organization's queue, the same on every read, and new for a new revision or file. ASCII only,
 * so that comparing them by code unit (here) and with `COLLATE "C"` (in SQL) agree.
 */
export const actionItemKeys = {
  acknowledgeNotice: (noticeId: string) => `ACKNOWLEDGE_NOTICE:${noticeId}`,
  acknowledgeInstructions: (instructionId: string, revisionNumber: number) =>
    `ACKNOWLEDGE_INSTRUCTIONS:${instructionId}:${revisionNumber}`,
  reviewDocument: (documentId: string, versionNumber: number) =>
    `REVIEW_DOCUMENT:${documentId}:${versionNumber}`,
  replaceRejectedDocument: (documentId: string, versionNumber: number) =>
    `REPLACE_REJECTED_DOCUMENT:${documentId}:${versionNumber}`,
};

/**
 * Where an action sits in page order. Every part comes from facts that never change while the
 * action is open (deadlines, upload, revision and rejection times are immutable), so an action
 * never moves between pages; `key` makes the order total.
 */
export interface ActionItemPosition {
  /** True for actions with a deadline (notices), which come first. */
  dated: boolean;
  /** The deadline of a dated action; otherwise when the action became due. */
  at: Date;
  key: string;
}

export function positionOf(item: ActionItem): ActionItemPosition {
  switch (item.type) {
    case 'ACKNOWLEDGE_NOTICE':
      return { dated: true, at: new Date(item.acknowledgementDueAt), key: item.key };
    case 'ACKNOWLEDGE_INSTRUCTIONS':
      return { dated: false, at: new Date(item.revisionCreatedAt), key: item.key };
    case 'REVIEW_DOCUMENT':
      return { dated: false, at: new Date(item.uploadedAt), key: item.key };
    case 'REPLACE_REJECTED_DOCUMENT':
      return { dated: false, at: new Date(item.rejectedAt), key: item.key };
  }
}

/**
 * Page order: actions with a deadline first, earliest deadline first, which puts overdue ones
 * ahead without depending on the clock; then the others, longest waiting first; ties by key.
 */
export function comparePositions(a: ActionItemPosition, b: ActionItemPosition): number {
  if (a.dated !== b.dated) {
    return a.dated ? -1 : 1;
  }
  const byTime = a.at.getTime() - b.at.getTime();
  if (byTime !== 0) {
    return byTime;
  }
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}

export const compareActionItems = (a: ActionItem, b: ActionItem): number =>
  comparePositions(positionOf(a), positionOf(b));
