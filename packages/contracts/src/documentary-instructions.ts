import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';
import { CounterpartyContractSchema } from './trade-contracts.js';
import { OrganizationRefSchema } from './voyages.js';

/*
 * Documentary instructions travel from the buyer to the seller under one sale contract: whom the
 * shipping documents name as consignee and notify party, and which documents the seller must
 * present. Only those two organizations may read them (ADR 0012). One instruction per contract;
 * the buyer revises it, and every revision is kept unchanged. The seller acknowledges receipt of
 * a specific revision. Acknowledging records receipt; it does not accept anything commercially.
 *
 * Writes are conditional (ADR 0012): the instruction's `version` is its entity tag, sent back in
 * `If-Match`; creating one requires `If-None-Match: *`.
 */

/** Documents a buyer may require under these MVP rules. Each appears at most once per revision. */
export const REQUIRED_DOCUMENT_TYPES = [
  'BILL_OF_LADING',
  'COMMERCIAL_INVOICE',
  'CERTIFICATE_OF_ORIGIN',
  'PHYTOSANITARY_CERTIFICATE',
  'WEIGHT_CERTIFICATE',
  'QUALITY_CERTIFICATE',
  'FUMIGATION_CERTIFICATE',
  'INSURANCE_CERTIFICATE',
] as const;

export const RequiredDocumentTypeSchema = z
  .enum(REQUIRED_DOCUMENT_TYPES)
  .register(apiSchemaRegistry, { id: 'RequiredDocumentType' });

/** Most originals, and most copies, a requirement may ask for. */
export const MAX_DOCUMENT_COUNT = 10;

/** Longest consignee or notify-party text, in characters (names and addresses, several lines). */
export const PARTY_DETAILS_MAX_LENGTH = 500;

const countSchema = z
  .int('Enter a whole number')
  .min(0, 'Cannot be negative')
  .max(MAX_DOCUMENT_COUNT, `At most ${MAX_DOCUMENT_COUNT}`);

export const DocumentRequirementSchema = z
  .strictObject({
    document: RequiredDocumentTypeSchema,
    originals: countSchema,
    copies: countSchema,
  })
  .refine((requirement) => requirement.originals + requirement.copies > 0, {
    path: ['originals'],
    message: 'Ask for at least one original or copy',
  })
  .register(apiSchemaRegistry, {
    id: 'DocumentRequirement',
    description: 'One document the seller must present: how many originals and copies.',
  });

/** Party details a client submits: trimmed, not blank, and bounded. */
const partyDetailsInput = (empty: string) =>
  z
    .string()
    .trim()
    .min(1, empty)
    .max(PARTY_DETAILS_MAX_LENGTH, `Use at most ${PARTY_DETAILS_MAX_LENGTH} characters`);

/**
 * The content of one revision, as the buyer states it. Bounded: one to eight requirements, each
 * document at most once. Who wrote it, when, and its number are decided by the server.
 */
export const DocumentaryInstructionContentSchema = z
  .strictObject({
    consignee: partyDetailsInput('Enter the consignee'),
    notifyParty: partyDetailsInput('Leave the notify party out, or name it').optional(),
    requirements: z
      .array(DocumentRequirementSchema)
      .min(1, 'Require at least one document')
      .max(REQUIRED_DOCUMENT_TYPES.length),
  })
  .superRefine((content, context) => {
    const seen = new Set<string>();
    content.requirements.forEach((requirement, index) => {
      if (seen.has(requirement.document)) {
        context.addIssue({
          code: 'custom',
          path: ['requirements', index, 'document'],
          message: 'Each document can be required only once',
        });
      }
      seen.add(requirement.document);
    });
  })
  .register(apiSchemaRegistry, {
    id: 'DocumentaryInstructionContent',
    description:
      'Body of PUT .../documentary-instructions: the full content of the new revision. A ' +
      'revision replaces the content as a whole; it is never patched.',
  });

/** Who did something to an instruction: always the signed-in user, as resolved by the server. */
export const InstructionActorSchema = z
  .object({
    name: z.string(),
    organization: OrganizationRefSchema,
  })
  .register(apiSchemaRegistry, { id: 'InstructionActor' });

const InstantSchema = z.iso.datetime();

export const RevisionAcknowledgementSchema = z
  .object({
    acknowledgedAt: InstantSchema,
    acknowledgedBy: InstructionActorSchema,
  })
  .register(apiSchemaRegistry, {
    id: 'RevisionAcknowledgement',
    description: "The seller's confirmation that it received this exact revision.",
  });

export const DocumentaryInstructionRevisionSchema = z
  .object({
    /** 1 for the first instruction, then 2, 3, ... */
    number: z.int().min(1),
    consignee: z.string(),
    notifyParty: z.string().nullable(),
    requirements: z.array(DocumentRequirementSchema).min(1),
    createdAt: InstantSchema,
    createdBy: InstructionActorSchema,
    /** Null until the seller acknowledges this revision; never removed once recorded. */
    acknowledgement: RevisionAcknowledgementSchema.nullable(),
  })
  .register(apiSchemaRegistry, {
    id: 'DocumentaryInstructionRevision',
    description: 'One revision of the instructions. Its content never changes.',
  });

export const DocumentaryInstructionSchema = z
  .object({
    id: z.uuid(),
    voyageId: z.uuid(),
    /** The contract the instructions are given under, from the reader's side. */
    contract: CounterpartyContractSchema,
    /**
     * Advances on every change (a revision or an acknowledgement). Its entity tag, `"<version>"`,
     * is the `ETag` of the instruction and the `If-Match` of the next change.
     */
    version: z.int().min(1),
    currentRevision: DocumentaryInstructionRevisionSchema,
    /** Every earlier revision, newest first, with the acknowledgements they received. */
    previousRevisions: z.array(DocumentaryInstructionRevisionSchema),
  })
  .refine(
    (instruction) =>
      instruction.previousRevisions.every(
        (revision, index) => revision.number === instruction.currentRevision.number - index - 1,
      ) && instruction.currentRevision.number === instruction.previousRevisions.length + 1,
    { message: 'Revisions run from the current one down to 1 without gaps' },
  )
  .register(apiSchemaRegistry, {
    id: 'DocumentaryInstruction',
    description:
      'Documentary instructions from the buyer to the seller under one sale contract, with ' +
      'every revision. Readable only by those two organizations.',
  });

export const DocumentaryInstructionListResponseSchema = z
  .object({
    /** In contract position order; contracts without instructions are absent. */
    items: z.array(DocumentaryInstructionSchema),
  })
  .register(apiSchemaRegistry, { id: 'DocumentaryInstructionListResponse' });

/**
 * Body of `POST .../documentary-instructions/revisions/{revisionNumber}/acknowledgement`: empty,
 * or no body at all. The path names the revision; who acknowledged and when are server-side.
 */
export const AcknowledgeRevisionRequestSchema = z.strictObject({}).register(apiSchemaRegistry, {
  id: 'AcknowledgeRevisionRequest',
  description: 'Empty. The acknowledging user, their organization and the time are server-side.',
});

export const ContractIdParamSchema = z.uuid();
/** A revision number in a path: a positive decimal integer without sign or leading zeros. */
export const RevisionNumberParamSchema = z
  .string()
  .regex(/^[1-9]\d{0,8}$/, 'Expected a revision number')
  .transform(Number);

/** The entity tag of an instruction at `version`, as sent in `ETag` and `If-Match`. */
export const instructionEntityTag = (version: number): string => `"${version}"`;

export type RequiredDocumentType = z.infer<typeof RequiredDocumentTypeSchema>;
export type DocumentRequirement = z.infer<typeof DocumentRequirementSchema>;
export type DocumentaryInstructionContent = z.infer<typeof DocumentaryInstructionContentSchema>;
export type InstructionActor = z.infer<typeof InstructionActorSchema>;
export type RevisionAcknowledgement = z.infer<typeof RevisionAcknowledgementSchema>;
export type DocumentaryInstructionRevision = z.infer<typeof DocumentaryInstructionRevisionSchema>;
export type DocumentaryInstruction = z.infer<typeof DocumentaryInstructionSchema>;
export type DocumentaryInstructionListResponse = z.infer<
  typeof DocumentaryInstructionListResponseSchema
>;
export type AcknowledgeRevisionRequest = z.infer<typeof AcknowledgeRevisionRequestSchema>;
