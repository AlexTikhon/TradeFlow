import { Injectable } from '@nestjs/common';
import type { RequiredDocumentType } from '@tradeflow/contracts';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { parseStoredRequirements } from './instruction.read-model.js';

/*
 * Instruction revisions as the documents module needs them (ADR 0013): which revision is
 * current, and which document types a revision requires. This module owns the instruction
 * tables, so this is the only way another module reads them. Callers pass a contract they have
 * already resolved for the principal through `CounterpartyContracts`; nothing here checks who is
 * asking.
 */

export interface RevisionForDocuments {
  instructionId: string;
  revisionNumber: number;
  /** The instruction's current revision, at the time of the read (or of the lock). */
  currentRevisionNumber: number;
  /** The document types this revision requires, in the order the buyer listed them. */
  requiredDocuments: RequiredDocumentType[];
}

type Db = Prisma.TransactionClient;

@Injectable()
export class InstructionRevisions {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Revision `revisionNumber` of the contract's instruction, with the instruction's current
   * revision number. Null when the contract has no instruction or no such revision. A plain read:
   * it can be out of date by the time the caller acts on it.
   */
  async find(
    contractId: string,
    revisionNumber: number,
    db: Db = this.prisma,
  ): Promise<RevisionForDocuments | null> {
    const instruction = await db.documentaryInstruction.findUnique({
      where: { tradeContractId: contractId },
      select: { id: true, currentRevisionNumber: true },
    });
    return instruction && this.withRevision(db, instruction, revisionNumber);
  }

  /**
   * The same, with the instruction row share-locked until the caller's transaction ends: the
   * instruction cannot move on to a new revision meanwhile, and the answer stays true until
   * commit. Under READ COMMITTED, a lock that had to wait for a revision being written returns
   * the instruction as that revision left it, so the caller sees the new current revision.
   */
  async lock(
    tx: Db,
    contractId: string,
    revisionNumber: number,
  ): Promise<RevisionForDocuments | null> {
    const [instruction] = await tx.$queryRaw<{ id: string; current_revision_number: number }[]>`
      SELECT id, current_revision_number FROM documentary_instructions
      WHERE trade_contract_id = ${contractId}::uuid
      FOR SHARE`;
    if (!instruction) {
      return null;
    }
    return this.withRevision(
      tx,
      { id: instruction.id, currentRevisionNumber: instruction.current_revision_number },
      revisionNumber,
    );
  }

  private async withRevision(
    db: Db,
    instruction: { id: string; currentRevisionNumber: number },
    revisionNumber: number,
  ): Promise<RevisionForDocuments | null> {
    // A statement of its own, after the lock: it sees a revision that was being written while
    // the lock waited.
    const revision = await db.documentaryInstructionRevision.findUnique({
      where: { instructionId_revisionNumber: { instructionId: instruction.id, revisionNumber } },
      select: { requirements: true },
    });
    return (
      revision && {
        instructionId: instruction.id,
        revisionNumber,
        currentRevisionNumber: instruction.currentRevisionNumber,
        requiredDocuments: parseStoredRequirements(revision.requirements).map(
          ({ document }) => document,
        ),
      }
    );
  }
}
