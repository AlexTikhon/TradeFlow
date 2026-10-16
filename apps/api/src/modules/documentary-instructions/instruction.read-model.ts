import {
  type CounterpartyContract,
  type DocumentaryInstruction,
  type DocumentaryInstructionRevision,
  DocumentRequirementSchema,
} from '@tradeflow/contracts';
import { z } from 'zod';
import type { Prisma } from '../../generated/prisma/client.js';

/*
 * Read model for documentary instructions: exactly which columns are loaded, and how rows become
 * the API contract. The contract the instruction belongs to is not joined here: the voyages
 * module resolves it, for the reader, through `CounterpartyContracts`. Actor names and
 * organizations are read through the revisions' and acknowledgements' own actor relations.
 */

const organizationSelect = { select: { id: true, name: true, countryCode: true } } as const;

export const instructionSelect = {
  id: true,
  voyageId: true,
  tradeContractId: true,
  version: true,
  currentRevisionNumber: true,
  revisions: {
    select: {
      revisionNumber: true,
      consignee: true,
      notifyParty: true,
      requirements: true,
      createdAt: true,
      createdByUser: { select: { fullName: true } },
      createdByOrganization: organizationSelect,
      acknowledgement: {
        select: {
          acknowledgedAt: true,
          acknowledgedByUser: { select: { fullName: true } },
          acknowledgedByOrganization: organizationSelect,
        },
      },
    },
    orderBy: { revisionNumber: 'desc' },
  },
} satisfies Prisma.DocumentaryInstructionSelect;

export type InstructionRow = Prisma.DocumentaryInstructionGetPayload<{
  select: typeof instructionSelect;
}>;

type RevisionRow = InstructionRow['revisions'][number];

/** The stored requirements, checked: the database's CHECK should make a failure impossible. */
const StoredRequirementsSchema = z.array(DocumentRequirementSchema).min(1);

export const parseStoredRequirements = (json: Prisma.JsonValue) =>
  StoredRequirementsSchema.parse(json);

function toRevision(row: RevisionRow): DocumentaryInstructionRevision {
  return {
    number: row.revisionNumber,
    consignee: row.consignee,
    notifyParty: row.notifyParty,
    requirements: parseStoredRequirements(row.requirements),
    createdAt: row.createdAt.toISOString(),
    createdBy: { name: row.createdByUser.fullName, organization: row.createdByOrganization },
    acknowledgement: row.acknowledgement && {
      acknowledgedAt: row.acknowledgement.acknowledgedAt.toISOString(),
      acknowledgedBy: {
        name: row.acknowledgement.acknowledgedByUser.fullName,
        organization: row.acknowledgement.acknowledgedByOrganization,
      },
    },
  };
}

/** Maps an instruction for a reader who is a party to `contract`. */
export function toInstruction(
  row: InstructionRow,
  contract: CounterpartyContract,
): DocumentaryInstruction {
  const [current, ...previous] = row.revisions;
  if (current?.revisionNumber !== row.currentRevisionNumber) {
    // The deferred constraint trigger guarantees the current revision exists.
    throw new Error(`Instruction ${row.id} was read without its current revision`);
  }
  return {
    id: row.id,
    voyageId: row.voyageId,
    contract,
    version: row.version,
    currentRevision: toRevision(current),
    previousRevisions: previous.map(toRevision),
  };
}
