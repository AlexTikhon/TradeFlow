import type { RequiredDocumentType } from '@tradeflow/contracts';
import type { Prisma } from '../../generated/prisma/client.js';

/*
 * The conditional writes that decide every change to a document: each upload (ADR 0013) and each
 * review (ADR 0014), following the pattern of the instruction writes (ADR 0012). Each is a single
 * statement whose condition PostgreSQL evaluates on the row it changes, so there is no
 * read-then-save window:
 *
 * - A concurrent first version of the same document waits on the unique index, then inserts
 *   nothing (ON CONFLICT DO NOTHING).
 * - Under READ COMMITTED, a replacement or a review that finds the row locked by another upload
 *   or review waits, then re-evaluates its WHERE clause against the committed row: the version
 *   predicate sees the competitor's version and the statement changes nothing.
 * - The version predicate is on the updated table itself, never inside a subquery: PostgreSQL
 *   re-checks only the target row's own conditions after such a wait.
 *
 * The document's `version` counts every change; `current_version_number` counts uploads. The
 * caller writes the version row or the review row in the same transaction (deferred triggers
 * require them).
 */

type Tx = Prisma.TransactionClient;

export interface AdvancedDocument {
  id: string;
  version: number;
  currentVersionNumber: number;
}

interface AdvancedRow {
  id: string;
  version: number;
  current_version_number: number;
}

const advanced = (row: AdvancedRow | undefined): AdvancedDocument | null =>
  row
    ? { id: row.id, version: row.version, currentVersionNumber: row.current_version_number }
    : null;

export interface DocumentKey {
  contractId: string;
  revisionNumber: number;
  documentType: RequiredDocumentType;
}

/**
 * Creates the document at version 1, file version 1, unless it exists. Null when it does,
 * including when a concurrent first upload committed first.
 */
export async function createDocument(
  tx: Tx,
  {
    voyageId,
    instructionId,
    contractId,
    revisionNumber,
    documentType,
    at,
  }: DocumentKey & { voyageId: string; instructionId: string; at: Date },
): Promise<AdvancedDocument | null> {
  const [row] = await tx.$queryRaw<AdvancedRow[]>`
    INSERT INTO documents
      (voyage_id, trade_contract_id, instruction_id, revision_number, document_type,
       version, current_version_number, created_at, updated_at)
    VALUES (${voyageId}::uuid, ${contractId}::uuid, ${instructionId}::uuid, ${revisionNumber},
       ${documentType}::document_type, 1, 1, ${at}, ${at})
    ON CONFLICT (trade_contract_id, revision_number, document_type) DO NOTHING
    RETURNING id, version, current_version_number`;
  return advanced(row);
}

/**
 * Advances the document to its next file version, if its version is one of `expectedVersions`.
 * Null when it does not exist or is at another version (a newer upload, or a review).
 */
export async function advanceDocumentVersion(
  tx: Tx,
  {
    contractId,
    revisionNumber,
    documentType,
    expectedVersions,
    at,
  }: DocumentKey & { expectedVersions: number[]; at: Date },
): Promise<AdvancedDocument | null> {
  const [row] = await tx.$queryRaw<AdvancedRow[]>`
    UPDATE documents
    SET version = version + 1,
        current_version_number = current_version_number + 1,
        updated_at = ${at}
    WHERE trade_contract_id = ${contractId}::uuid
      AND revision_number = ${revisionNumber}
      AND document_type = ${documentType}::document_type
      AND version = ANY(${expectedVersions}::int[])
    RETURNING id, version, current_version_number`;
  return advanced(row);
}

/**
 * Advances the version for a review of file version `versionNumber`, if the document's version
 * is one of `expectedVersions`, that file version is still the current one, and it has no review
 * yet. Null otherwise. (The review check is a subquery, but any review also advances the version,
 * so the version predicate already excludes a concurrent one; likewise any replacement.)
 */
export async function advanceForReview(
  tx: Tx,
  {
    contractId,
    revisionNumber,
    documentType,
    versionNumber,
    expectedVersions,
    at,
  }: DocumentKey & { versionNumber: number; expectedVersions: number[]; at: Date },
): Promise<AdvancedDocument | null> {
  const [row] = await tx.$queryRaw<AdvancedRow[]>`
    UPDATE documents AS document
    SET version = document.version + 1,
        updated_at = ${at}
    WHERE document.trade_contract_id = ${contractId}::uuid
      AND document.revision_number = ${revisionNumber}
      AND document.document_type = ${documentType}::document_type
      AND document.version = ANY(${expectedVersions}::int[])
      AND document.current_version_number = ${versionNumber}
      AND NOT EXISTS (
        SELECT 1 FROM document_reviews AS review
        WHERE review.document_id = document.id
          AND review.version_number = ${versionNumber})
    RETURNING document.id, document.version, document.current_version_number`;
  return advanced(row);
}
