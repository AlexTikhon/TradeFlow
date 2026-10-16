import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  PreconditionFailedException,
} from '@nestjs/common';
import type {
  CounterpartyContract,
  DocumentaryInstruction,
  DocumentaryInstructionContent,
  DocumentaryInstructionListResponse,
} from '@tradeflow/contracts';
import { RequestValidationException } from '../../common/http/request-validation.exception.js';
import type { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import { AuditTrail } from '../audit/audit-trail.js';
import type { Principal } from '../auth/principal.js';
import { requireOperator } from '../auth/user-permissions.js';
import { CounterpartyContracts } from '../voyages/counterparty-contracts.js';
import { sameContent, toStoredContent } from './instruction-rules.js';
import {
  instructionSelect,
  parseStoredRequirements,
  toInstruction,
} from './instruction.read-model.js';
import {
  advanceForAcknowledgement,
  advanceToNextRevision,
  createInstruction,
} from './instruction.writes.js';

/** What a write is conditional on, from the request's precondition headers. */
export type WritePrecondition =
  /** `If-None-Match: *`: only if the contract has no instruction yet. */
  | { kind: 'absent' }
  /** `If-Match`: only if the instruction is at one of these versions. */
  | { kind: 'version'; versions: number[] };

export interface PutResult {
  instruction: DocumentaryInstruction;
  created: boolean;
}

/**
 * Documentary instruction use cases (ADR 0012). Each takes the acting principal. Reads are scoped
 * in the database: instructions are loaded only under contracts the voyages module resolved for
 * the principal's organization as a counterparty, so another participant's request finds nothing.
 * Commands check the user's role and the organization's side of the contract here, then make
 * one conditional write (`instruction.writes.ts`) and record its audit event in the same
 * transaction. A failed precondition changes nothing and records nothing.
 */
@Injectable()
export class DocumentaryInstructionsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: CounterpartyContracts,
    private readonly audit: AuditTrail,
  ) {}

  /**
   * The instructions under the principal's organization's contracts on the voyage, in contract
   * order. Null when the voyage does not exist or the organization does not participate in it;
   * empty for a participant that is a party to no contract.
   */
  async list(
    principal: Principal,
    voyageId: string,
  ): Promise<DocumentaryInstructionListResponse | null> {
    const contracts = await this.contracts.listForVoyage(principal, voyageId);
    if (!contracts) {
      return null;
    }
    const rows =
      contracts.length === 0
        ? []
        : await this.prisma.documentaryInstruction.findMany({
            where: { voyageId, tradeContractId: { in: contracts.map(({ id }) => id) } },
            select: instructionSelect,
          });
    const byContract = new Map(rows.map((row) => [row.tradeContractId, row]));
    return {
      items: contracts.flatMap((contract) => {
        const row = byContract.get(contract.id);
        return row ? [toInstruction(row, contract)] : [];
      }),
    };
  }

  /**
   * The contract's instruction, or null alike when the contract is not the principal's
   * organization's (missing, of another voyage, or someone else's) and when it has none yet.
   */
  async findForContract(
    principal: Principal,
    voyageId: string,
    contractId: string,
  ): Promise<DocumentaryInstruction | null> {
    const contract = await this.contracts.findForVoyage(principal, voyageId, contractId);
    if (!contract) {
      return null;
    }
    const row = await this.prisma.documentaryInstruction.findUnique({
      where: { tradeContractId: contract.id },
      select: instructionSelect,
    });
    return row && toInstruction(row, contract);
  }

  /**
   * Writes a new revision: the first one (creating the instruction) when the precondition is
   * `absent`, the next one when it names the version it was based on. Only an operator of the
   * contract's buyer may. Null when the contract cannot be found for the principal's
   * organization. The author and time come from the session and the server's clock.
   */
  async put(
    principal: Principal,
    voyageId: string,
    contractId: string,
    request: DocumentaryInstructionContent,
    precondition: WritePrecondition,
  ): Promise<PutResult | null> {
    requireOperator(principal, 'give documentary instructions');
    const content = toStoredContent(request);

    return this.prisma.$transaction(async (tx) => {
      const contract = await this.contracts.findForVoyage(principal, voyageId, contractId, tx);
      if (!contract) {
        return null;
      }
      if (contract.side !== 'BUYER') {
        throw new ForbiddenException(
          'Only the buyer under a contract may give its documentary instructions.',
        );
      }

      const at = new Date();
      const instruction =
        precondition.kind === 'absent'
          ? await createInstruction(tx, { voyageId, contractId: contract.id, at })
          : await advanceToNextRevision(tx, {
              contractId: contract.id,
              expectedVersions: precondition.versions,
              at,
            });
      if (!instruction && precondition.kind === 'absent') {
        throw new PreconditionFailedException(
          'Documentary instructions already exist for this contract. Review them, then revise them with If-Match.',
        );
      }
      if (!instruction) {
        // Read only to explain the refusal; the conditional write already decided it.
        const existing = await tx.documentaryInstruction.findUnique({
          where: { tradeContractId: contract.id },
          select: { version: true },
        });
        throw new PreconditionFailedException(staleOrMissing(existing));
      }

      const revisionNumber = instruction.currentRevisionNumber;
      if (revisionNumber > 1) {
        const previous = await tx.documentaryInstructionRevision.findUniqueOrThrow({
          where: {
            instructionId_revisionNumber: {
              instructionId: instruction.id,
              revisionNumber: revisionNumber - 1,
            },
          },
          select: { consignee: true, notifyParty: true, requirements: true },
        });
        const unchanged = sameContent(content, {
          ...previous,
          requirements: parseStoredRequirements(previous.requirements),
        });
        if (unchanged) {
          throw new RequestValidationException([
            {
              path: 'body',
              message: `This revision changes nothing: it is the same as revision ${revisionNumber - 1}.`,
            },
          ]);
        }
      }

      // Exactly the three keys, in a fixed order, whatever object the request held.
      const requirements = content.requirements.map(({ document, originals, copies }) => ({
        document,
        originals,
        copies,
      }));
      await tx.documentaryInstructionRevision.create({
        data: {
          instructionId: instruction.id,
          revisionNumber,
          consignee: content.consignee,
          notifyParty: content.notifyParty,
          requirements,
          createdByUserId: principal.userId,
          createdByOrganizationId: principal.organizationId,
          createdAt: at,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'DOCUMENTARY_INSTRUCTION_REVISED',
        actor: principal,
        voyageId,
        payload: {
          instructionId: instruction.id,
          contractId: contract.id,
          revisionNumber,
          version: instruction.version,
          consignee: content.consignee,
          notifyParty: content.notifyParty,
          requirements,
          createdAt: at.toISOString(),
        },
      });
      return {
        instruction: await readWritten(tx, instruction.id, contract),
        created: precondition.kind === 'absent',
      };
    });
  }

  /**
   * Records that the seller received revision `revisionNumber`. Only an operator of the
   * contract's seller may, only for the current revision, once, and only at a version the client
   * names. Null when the contract is not the principal's organization's or has no instruction.
   */
  async acknowledge(
    principal: Principal,
    voyageId: string,
    contractId: string,
    revisionNumber: number,
    expectedVersions: number[],
  ): Promise<DocumentaryInstruction | null> {
    requireOperator(principal, 'acknowledge documentary instructions');

    return this.prisma.$transaction(async (tx) => {
      const contract = await this.contracts.findForVoyage(principal, voyageId, contractId, tx);
      if (!contract) {
        return null;
      }
      if (contract.side !== 'SELLER') {
        throw new ForbiddenException(
          'Only the seller under a contract may acknowledge its documentary instructions.',
        );
      }

      const at = new Date();
      const instruction = await advanceForAcknowledgement(tx, {
        contractId: contract.id,
        revisionNumber,
        expectedVersions,
        at,
      });
      if (!instruction) {
        const current = await tx.documentaryInstruction.findUnique({
          where: { tradeContractId: contract.id },
          select: { version: true, currentRevisionNumber: true },
        });
        if (!current) {
          return null;
        }
        throw whyNotAcknowledged(current, revisionNumber, expectedVersions);
      }

      await tx.documentaryInstructionAcknowledgement.create({
        data: {
          instructionId: instruction.id,
          revisionNumber,
          acknowledgedByUserId: principal.userId,
          acknowledgedByOrganizationId: principal.organizationId,
          acknowledgedAt: at,
        },
        select: { id: true },
      });
      await this.audit.record(tx, {
        action: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
        actor: principal,
        voyageId,
        payload: {
          instructionId: instruction.id,
          contractId: contract.id,
          revisionNumber,
          version: instruction.version,
          acknowledgedAt: at.toISOString(),
        },
      });
      return readWritten(tx, instruction.id, contract);
    });
  }
}

/**
 * The instruction as this transaction left it, for a reader already resolved as a party to
 * `contract`. Read before commit while the row is still locked, so the response (and its ETag)
 * is exactly the version this write produced, not a later one.
 */
async function readWritten(
  tx: Prisma.TransactionClient,
  instructionId: string,
  contract: CounterpartyContract,
): Promise<DocumentaryInstruction> {
  const row = await tx.documentaryInstruction.findUniqueOrThrow({
    where: { id: instructionId },
    select: instructionSelect,
  });
  return toInstruction(row, contract);
}

function staleOrMissing(existing: { version: number } | null): string {
  return existing
    ? `The documentary instructions have changed since the version you sent; they are now at version ${existing.version}. Review the latest revision before revising.`
    : 'There are no documentary instructions for this contract yet. Create them with If-None-Match: *.';
}

/**
 * Why an acknowledgement changed nothing, judged from the instruction as it is now. When the
 * version matches and the revision is current, the only remaining reason is an existing
 * acknowledgement.
 */
function whyNotAcknowledged(
  current: { version: number; currentRevisionNumber: number },
  revisionNumber: number,
  expectedVersions: number[],
) {
  if (revisionNumber > current.currentRevisionNumber) {
    return new NotFoundException('Revision was not found.');
  }
  if (!expectedVersions.includes(current.version)) {
    return new PreconditionFailedException(
      `The documentary instructions have changed since the version you sent; they are now at version ${current.version}. Review the current revision before acknowledging it.`,
    );
  }
  if (revisionNumber < current.currentRevisionNumber) {
    return new ConflictException(
      `Revision ${revisionNumber} has been superseded by revision ${current.currentRevisionNumber}; only the current revision can be acknowledged.`,
    );
  }
  return new ConflictException(`Revision ${revisionNumber} has already been acknowledged.`);
}
