import { Injectable } from '@nestjs/common';
import type { Prisma } from '../../generated/prisma/client.js';

/*
 * The current revision of each instruction, with whether the seller has acknowledged it, as the
 * Action Center needs them (ADR 0017). This module owns the instruction tables, so this is the
 * only way another module reads them. Callers pass contracts they have already resolved for the
 * principal through `CounterpartyContracts`; nothing here checks who is asking.
 */

export interface CurrentRevision {
  instructionId: string;
  contractId: string;
  /** The instruction's current revision. */
  revisionNumber: number;
  /** When the buyer gave it. */
  createdAt: Date;
  /** Null until the seller acknowledges this exact revision. */
  acknowledgedAt: Date | null;
}

interface CurrentRevisionRow {
  instruction_id: string;
  contract_id: string;
  revision_number: number;
  created_at: Date;
  acknowledged_at: Date | null;
}

@Injectable()
export class CurrentRevisions {
  /**
   * The current revision of the instruction under each of `contractIds` that has one, from one
   * statement. Earlier revisions and their acknowledgements are not read: the join takes only
   * the revision the instruction names as current, and none of its contents. Reads through
   * `db`, so the caller's snapshot decides which revision is current.
   */
  async listUnderContracts(
    contractIds: readonly string[],
    db: Prisma.TransactionClient,
  ): Promise<CurrentRevision[]> {
    if (contractIds.length === 0) {
      return [];
    }
    const rows = await db.$queryRaw<CurrentRevisionRow[]>`
      SELECT instruction.id AS instruction_id,
             instruction.trade_contract_id AS contract_id,
             revision.revision_number,
             revision.created_at,
             acknowledgement.acknowledged_at
      FROM documentary_instructions AS instruction
      JOIN documentary_instruction_revisions AS revision
        ON revision.instruction_id = instruction.id
       AND revision.revision_number = instruction.current_revision_number
      LEFT JOIN documentary_instruction_acknowledgements AS acknowledgement
        ON acknowledgement.instruction_id = instruction.id
       AND acknowledgement.revision_number = instruction.current_revision_number
      WHERE instruction.trade_contract_id = ANY(${[...contractIds]}::uuid[])`;
    return rows.map((row) => ({
      instructionId: row.instruction_id,
      contractId: row.contract_id,
      revisionNumber: row.revision_number,
      createdAt: row.created_at,
      acknowledgedAt: row.acknowledged_at,
    }));
  }
}
