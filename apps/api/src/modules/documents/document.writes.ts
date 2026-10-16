import type { RequiredDocumentType } from '@tradeflow/contracts';
import type { Prisma } from '../../generated/prisma/client.js';

/*
 * The conditional writes that decide every new document version (ADR 0013), following the
 * pattern of the instruction writes (ADR 0012). Each is a single statement whose condition
 * PostgreSQL evaluates on the row it changes, so there is no read-then-save window:
 *
 * - A concurrent first version of the same document waits on the unique index, then inserts
 *   nothing (ON CONFLICT DO NOTHING).
 * - Under READ COMMITTED, a replacement that finds the row locked by another upload waits, then
 *   re-evaluates its WHERE clause against the committed row: the version predicate sees the
 *   competitor's version and the statement changes nothing.
 *
 * The caller writes the version row in the same transaction (a deferred trigger requires it).
 */

type Tx = Prisma.TransactionClient;

export interface AdvancedDocument {
  id: string;
  currentVersionNumber: number;
}

interface AdvancedRow {
  id: string;
  current_version_number: number;
}

const advanced = (row: AdvancedRow | undefined): AdvancedDocument | null =>
  row ? { id: row.id, currentVersionNumber: row.current_version_number } : null;

export interface DocumentKey {
  contractId: string;
  revisionNumber: number;
  documentType: RequiredDocumentType;
}

/**
 * Creates the document at version 1, unless it exists. Null when it does, including when a
 * concurrent first upload committed first.
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
       current_version_number, created_at, updated_at)
    VALUES (${voyageId}::uuid, ${contractId}::uuid, ${instructionId}::uuid, ${revisionNumber},
       ${documentType}::document_type, 1, ${at}, ${at})
    ON CONFLICT (trade_contract_id, revision_number, document_type) DO NOTHING
    RETURNING id, current_version_number`;
  return advanced(row);
}

/**
 * Advances the document to its next version, if its current version is one of
 * `expectedVersions`. Null when it does not exist or is at another version.
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
    SET current_version_number = current_version_number + 1,
        updated_at = ${at}
    WHERE trade_contract_id = ${contractId}::uuid
      AND revision_number = ${revisionNumber}
      AND document_type = ${documentType}::document_type
      AND current_version_number = ANY(${expectedVersions}::int[])
    RETURNING id, current_version_number`;
  return advanced(row);
}
