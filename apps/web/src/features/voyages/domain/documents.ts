import type {
  ContractDocument,
  CounterpartyContract,
  CurrentUser,
  DocumentReview,
  DocumentVersion,
  RequiredDocumentType,
} from '@tradeflow/contracts';

/*
 * Presentation rules for documents. The API decides who may do what (ADR 0013, ADR 0014) and
 * checks again on every request, the file included; these only decide what to offer.
 */

/** Whether to offer uploads: the organization sells under the contract and the user operates. */
export const canUploadDocuments = (identity: CurrentUser, contract: CounterpartyContract) =>
  identity.user.role === 'OPERATOR' && contract.side === 'SELLER';

/** Whether to offer reviews: the organization buys under the contract and the user operates. */
export const canReviewDocuments = (identity: CurrentUser, contract: CounterpartyContract) =>
  identity.user.role === 'OPERATOR' && contract.side === 'BUYER';

/**
 * Where a file version stands. Pending only while it can still be decided on: the latest file of
 * a document under the current revision. Any other version without a decision never got one.
 */
export type ReviewStatus = 'PENDING' | 'APPROVED' | 'REJECTED' | 'NOT_REVIEWED';

export const reviewStatusOf = (version: DocumentVersion, reviewable: boolean): ReviewStatus =>
  version.review?.decision ?? (reviewable ? 'PENDING' : 'NOT_REVIEWED');

export const REVIEW_STATUS_LABELS: Record<ReviewStatus, string> = {
  PENDING: 'Pending review',
  APPROVED: 'Approved',
  REJECTED: 'Rejected',
  NOT_REVIEWED: 'Not reviewed',
};

/** "approved", "rejected": a decision in a sentence. */
export const decisionVerb = (review: DocumentReview) =>
  review.decision === 'APPROVED' ? 'approved' : 'rejected';

/**
 * What a draft (a chosen file, or a decision being made) is based on: the document's version,
 * sent in If-Match, and its latest file then. Null when there was no document yet.
 */
export interface DocumentBasis {
  version: number;
  fileVersion: number;
}

export const basisOf = (document: ContractDocument | null): DocumentBasis | null =>
  document && { version: document.version, fileVersion: document.currentVersion.number };

/** What happened to a document since a draft's basis, as the user needs to hear it. */
export type DocumentChange =
  | { kind: 'none' }
  /** Someone uploaded a file: the latest version is another one. */
  | { kind: 'new-file'; latest: DocumentVersion }
  /** The same file, decided on by someone. */
  | { kind: 'decided'; latest: DocumentVersion; review: DocumentReview };

/**
 * The change from `basis` to `latest`. The version counts uploads and decisions, so a new
 * version with the same latest file means a decision on that file.
 */
export function changeSince(
  basis: DocumentBasis | null,
  latest: ContractDocument | null,
): DocumentChange {
  if (!latest || latest.version === basis?.version) return { kind: 'none' };
  const { currentVersion } = latest;
  if (basis && currentVersion.number === basis.fileVersion && currentVersion.review) {
    return { kind: 'decided', latest: currentVersion, review: currentVersion.review };
  }
  return { kind: 'new-file', latest: currentVersion };
}

/** The document of `type` presented against revision `revisionNumber`, if there is one yet. */
export const findDocument = (
  documents: readonly ContractDocument[],
  contractId: string,
  revisionNumber: number,
  type: RequiredDocumentType,
): ContractDocument | null =>
  documents.find(
    (document) =>
      document.contract.id === contractId &&
      document.revisionNumber === revisionNumber &&
      document.documentType === type,
  ) ?? null;

const sizeFormat = new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 });

/** "48.2 KB", "3.1 MB": sizes as file managers show them (1 KB = 1024 bytes). */
export function formatFileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${sizeFormat.format(bytes / 1024)} KB`;
  return `${sizeFormat.format(bytes / (1024 * 1024))} MB`;
}

/** The start of a checksum, enough to compare two copies by eye. */
export const shortChecksum = (sha256: string) => `${sha256.slice(0, 12)}…`;
