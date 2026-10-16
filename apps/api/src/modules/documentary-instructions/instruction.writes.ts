import type { Prisma } from '../../generated/prisma/client.js';

/*
 * The conditional writes that decide every change to an instruction (ADR 0012). Each is a single
 * statement whose condition is evaluated by PostgreSQL on the row it changes, so there is no
 * read-then-save window:
 *
 * - Under READ COMMITTED, an UPDATE that finds the row locked by another transaction waits, then
 *   re-evaluates its WHERE clause against the committed row. The version predicate therefore
 *   sees the competitor's change and the statement changes nothing.
 * - The version predicate is on the updated table itself, never inside a subquery: PostgreSQL
 *   re-checks only the target row's own conditions after such a wait.
 * - A concurrent first instruction for the same contract waits on the unique index, then
 *   inserts nothing (ON CONFLICT DO NOTHING).
 *
 * Written as SQL rather than through `updateMany` so that the statement's shape (one UPDATE with
 * these predicates, RETURNING the result) is explicit and cannot change with ORM query planning.
 */

type Tx = Prisma.TransactionClient;

export interface AdvancedInstruction {
  id: string;
  version: number;
  currentRevisionNumber: number;
}

interface AdvancedRow {
  id: string;
  version: number;
  current_revision_number: number;
}

const advanced = (row: AdvancedRow | undefined): AdvancedInstruction | null =>
  row
    ? { id: row.id, version: row.version, currentRevisionNumber: row.current_revision_number }
    : null;

/**
 * Creates the contract's instruction at version 1, revision 1, unless one exists. Null when it
 * does, including when a concurrent creation committed first. The caller writes revision 1 in
 * the same transaction (a deferred trigger requires it).
 */
export async function createInstruction(
  tx: Tx,
  { voyageId, contractId, at }: { voyageId: string; contractId: string; at: Date },
): Promise<AdvancedInstruction | null> {
  const [row] = await tx.$queryRaw<AdvancedRow[]>`
    INSERT INTO documentary_instructions
      (voyage_id, trade_contract_id, version, current_revision_number, created_at, updated_at)
    VALUES (${voyageId}::uuid, ${contractId}::uuid, 1, 1, ${at}, ${at})
    ON CONFLICT (trade_contract_id) DO NOTHING
    RETURNING id, version, current_revision_number`;
  return advanced(row);
}

/**
 * Advances the contract's instruction to its next revision, if its version is one of
 * `expectedVersions`. Null when it does not exist or its version is another. The caller writes
 * the new revision in the same transaction.
 */
export async function advanceToNextRevision(
  tx: Tx,
  {
    contractId,
    expectedVersions,
    at,
  }: { contractId: string; expectedVersions: number[]; at: Date },
): Promise<AdvancedInstruction | null> {
  const [row] = await tx.$queryRaw<AdvancedRow[]>`
    UPDATE documentary_instructions
    SET version = version + 1,
        current_revision_number = current_revision_number + 1,
        updated_at = ${at}
    WHERE trade_contract_id = ${contractId}::uuid
      AND version = ANY(${expectedVersions}::int[])
    RETURNING id, version, current_revision_number`;
  return advanced(row);
}

/**
 * Advances the version for an acknowledgement of `revisionNumber`, if the instruction's version
 * is one of `expectedVersions`, that revision is still current, and it has no acknowledgement
 * yet. Null otherwise. (The acknowledgement check is a subquery, but any acknowledgement also
 * advances the version, so the version predicate already excludes a concurrent one.) The caller
 * writes the acknowledgement in the same transaction.
 */
export async function advanceForAcknowledgement(
  tx: Tx,
  {
    contractId,
    revisionNumber,
    expectedVersions,
    at,
  }: { contractId: string; revisionNumber: number; expectedVersions: number[]; at: Date },
): Promise<AdvancedInstruction | null> {
  const [row] = await tx.$queryRaw<AdvancedRow[]>`
    UPDATE documentary_instructions AS instruction
    SET version = instruction.version + 1,
        updated_at = ${at}
    WHERE instruction.trade_contract_id = ${contractId}::uuid
      AND instruction.version = ANY(${expectedVersions}::int[])
      AND instruction.current_revision_number = ${revisionNumber}
      AND NOT EXISTS (
        SELECT 1 FROM documentary_instruction_acknowledgements AS acknowledgement
        WHERE acknowledgement.instruction_id = instruction.id
          AND acknowledgement.revision_number = ${revisionNumber})
    RETURNING instruction.id, instruction.version, instruction.current_revision_number`;
  return advanced(row);
}
