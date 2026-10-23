import { Injectable } from '@nestjs/common';
import type {
  DocumentReviewDecision,
  DocumentType,
  Prisma,
} from '../../generated/prisma/client.js';

/*
 * The latest file of each document, with the buyer's decision on it, as the Action Center needs
 * them (ADR 0017). This module owns `documents`, their versions and reviews, so this is the only
 * way another module reads them. Which revision is current is the documentary-instructions
 * module's to say: callers pass it, read in the same transaction, together with contracts they
 * have already resolved for the principal through `CounterpartyContracts`. Nothing here checks
 * who is asking.
 */

/** An instruction revision whose documents to read: the contract's current one. */
export interface DocumentRevision {
  contractId: string;
  revisionNumber: number;
}

export interface LatestDocumentVersion {
  documentId: string;
  contractId: string;
  revisionNumber: number;
  documentType: DocumentType;
  /** The document's latest file. */
  versionNumber: number;
  uploadedAt: Date;
  /** Null while the buyer has not decided on this file. */
  review: { decision: DocumentReviewDecision; reason: string | null; reviewedAt: Date } | null;
}

interface LatestDocumentVersionRow {
  document_id: string;
  contract_id: string;
  revision_number: number;
  document_type: DocumentType;
  version_number: number;
  uploaded_at: Date;
  decision: DocumentReviewDecision | null;
  reason: string | null;
  reviewed_at: Date | null;
}

@Injectable()
export class LatestDocumentVersions {
  /**
   * The documents answering exactly `revisions`, each with its latest file and that file's
   * review, from one statement. Documents of other revisions, earlier files and their decisions
   * are not read, nor is anything of a file but its number and upload time (no name, checksum or
   * storage key). Reads through `db`, so the caller's snapshot decides which file is latest.
   */
  async listForRevisions(
    revisions: readonly DocumentRevision[],
    db: Prisma.TransactionClient,
  ): Promise<LatestDocumentVersion[]> {
    if (revisions.length === 0) {
      return [];
    }
    const rows = await db.$queryRaw<LatestDocumentVersionRow[]>`
      SELECT document.id AS document_id,
             document.trade_contract_id AS contract_id,
             document.revision_number,
             document.document_type::text AS document_type,
             version.version_number,
             version.uploaded_at,
             review.decision::text AS decision,
             review.reason,
             review.reviewed_at
      FROM unnest(
             ${revisions.map(({ contractId }) => contractId)}::uuid[],
             ${revisions.map(({ revisionNumber }) => revisionNumber)}::int[]
           ) AS wanted (contract_id, revision_number)
      JOIN documents AS document
        ON document.trade_contract_id = wanted.contract_id
       AND document.revision_number = wanted.revision_number
      JOIN document_versions AS version
        ON version.document_id = document.id
       AND version.version_number = document.current_version_number
      LEFT JOIN document_reviews AS review
        ON review.document_id = document.id
       AND review.version_number = document.current_version_number`;
    return rows.map((row) => ({
      documentId: row.document_id,
      contractId: row.contract_id,
      revisionNumber: row.revision_number,
      documentType: row.document_type,
      versionNumber: row.version_number,
      uploadedAt: row.uploaded_at,
      review:
        row.decision === null || row.reviewed_at === null
          ? null
          : { decision: row.decision, reason: row.reason, reviewedAt: row.reviewed_at },
    }));
  }
}
