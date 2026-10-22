import { z } from 'zod';
import { RequiredDocumentTypeSchema } from './documentary-instructions.js';
import { REJECTION_REASON_MAX_LENGTH } from './documents.js';
import { apiSchemaRegistry } from './registry.js';
import { OrganizationRefSchema } from './voyages.js';

/*
 * The Action Center (ADR 0017): what the signed-in organization has to do next, across every
 * voyage, under the contracts it is the seller or the buyer of. A read-only projection of the
 * notices, instructions, documents and reviews that already exist: nothing here is stored,
 * assigned or completed on its own. An action disappears when the command that answers it
 * (acknowledging, reviewing, replacing) commits, and the commands decide who may run them.
 *
 * Four kinds, each owed by one side of the contract:
 *
 * - ACKNOWLEDGE_NOTICE (buyer): an ETA notice still ISSUED. The only kind with a deadline.
 * - ACKNOWLEDGE_INSTRUCTIONS (seller): the current instruction revision, not yet acknowledged.
 * - REVIEW_DOCUMENT (buyer): the latest file of a document of the current revision, not decided.
 * - REPLACE_REJECTED_DOCUMENT (seller): the latest file of such a document, rejected.
 *
 * Superseded revisions, replaced files and their decisions are history and never produce one.
 */

/** Items per page when the client does not say. */
export const ACTION_ITEMS_DEFAULT_PAGE_SIZE = 20;
/** Most items one page may hold. */
export const ACTION_ITEMS_MAX_PAGE_SIZE = 50;
/** Longest cursor accepted; the API's own are far shorter. */
export const ACTION_ITEMS_CURSOR_MAX_LENGTH = 300;
/** Longest action key the API produces. */
export const ACTION_ITEM_KEY_MAX_LENGTH = 100;

export const ACTION_ITEM_TYPES = [
  'ACKNOWLEDGE_NOTICE',
  'ACKNOWLEDGE_INSTRUCTIONS',
  'REVIEW_DOCUMENT',
  'REPLACE_REJECTED_DOCUMENT',
] as const;

export const ActionItemTypeSchema = z.enum(ACTION_ITEM_TYPES).register(apiSchemaRegistry, {
  id: 'ActionItemType',
  description:
    'ACKNOWLEDGE_NOTICE and REVIEW_DOCUMENT are owed by the buyer under the contract; ' +
    'ACKNOWLEDGE_INSTRUCTIONS and REPLACE_REJECTED_DOCUMENT by the seller.',
});

/** An instant as the API answers it: ISO 8601 in UTC (`Z`), millisecond precision. */
const InstantSchema = z.iso.datetime();

/** The voyage an action is on: enough to name it and to open it. */
export const ActionItemVoyageSchema = z
  .object({
    id: z.uuid(),
    reference: z.string(),
  })
  .register(apiSchemaRegistry, { id: 'ActionItemVoyage' });

/**
 * The contract an action is owed under. Only its two counterparties ever see the action, so the
 * id is theirs to know (ADR 0011); the position is the shared topology (ADR 0010).
 */
export const ActionItemContractSchema = z
  .object({
    id: z.uuid(),
    position: z.int().min(1),
  })
  .register(apiSchemaRegistry, { id: 'ActionItemContract' });

/*
 * Where an action is answered: exactly the record it concerns, by the identifiers its own
 * endpoints take. Self-contained, so a client can open it without reading the rest of the item.
 */

export const NoticeTargetSchema = z
  .object({
    kind: z.literal('NOTICE'),
    voyageId: z.uuid(),
    contractId: z.uuid(),
    noticeId: z.uuid(),
  })
  .register(apiSchemaRegistry, { id: 'NoticeTarget' });

export const InstructionRevisionTargetSchema = z
  .object({
    kind: z.literal('INSTRUCTION_REVISION'),
    voyageId: z.uuid(),
    contractId: z.uuid(),
    instructionId: z.uuid(),
    revisionNumber: z.int().min(1),
  })
  .register(apiSchemaRegistry, { id: 'InstructionRevisionTarget' });

export const DocumentVersionTargetSchema = z
  .object({
    kind: z.literal('DOCUMENT_VERSION'),
    voyageId: z.uuid(),
    contractId: z.uuid(),
    /** The instruction revision the document answers: always the current one. */
    revisionNumber: z.int().min(1),
    documentType: RequiredDocumentTypeSchema,
    documentId: z.uuid(),
    /** The latest file of the document: the one to decide on, or the one that was rejected. */
    versionNumber: z.int().min(1),
  })
  .register(apiSchemaRegistry, { id: 'DocumentVersionTarget' });

const itemBase = {
  /**
   * Identifies this action, and only this one, for as long as it is open: the same notice,
   * revision or file version gives the same key on every read. Opaque; compare it, never parse
   * it. A new revision or a new file is a new action with a new key.
   */
  key: z.string().min(1).max(ACTION_ITEM_KEY_MAX_LENGTH),
  voyage: ActionItemVoyageSchema,
  contract: ActionItemContractSchema,
  /** The other party to the contract: the seller for a buyer's action, and the other way round. */
  counterparty: OrganizationRefSchema,
};

export const ActionItemSchema = z
  .discriminatedUnion('type', [
    z.object({
      ...itemBase,
      type: z.literal('ACKNOWLEDGE_NOTICE'),
      issuedAt: InstantSchema,
      /** The deadline the seller set. The only deadline any action has. */
      acknowledgementDueAt: InstantSchema,
      /** As of `generatedAt`: the deadline has passed. A late acknowledgement is still accepted. */
      overdue: z.boolean(),
      target: NoticeTargetSchema,
    }),
    z.object({
      ...itemBase,
      type: z.literal('ACKNOWLEDGE_INSTRUCTIONS'),
      /** When the buyer gave this revision. */
      revisionCreatedAt: InstantSchema,
      target: InstructionRevisionTargetSchema,
    }),
    z.object({
      ...itemBase,
      type: z.literal('REVIEW_DOCUMENT'),
      /** When the seller uploaded the file awaiting a decision. */
      uploadedAt: InstantSchema,
      target: DocumentVersionTargetSchema,
    }),
    z.object({
      ...itemBase,
      type: z.literal('REPLACE_REJECTED_DOCUMENT'),
      /** When the seller uploaded the rejected file. */
      uploadedAt: InstantSchema,
      /** When the buyer rejected it. */
      rejectedAt: InstantSchema,
      /** The buyer's reason, as given. Served only on this kind of action. */
      rejectionReason: z.string().min(1).max(REJECTION_REASON_MAX_LENGTH),
      target: DocumentVersionTargetSchema,
    }),
  ])
  .refine(
    (item) =>
      item.target.voyageId === item.voyage.id && item.target.contractId === item.contract.id,
    { path: ['target'], message: 'The target is on the item’s voyage and contract' },
  )
  .register(apiSchemaRegistry, {
    id: 'ActionItem',
    description:
      'Something the signed-in organization has to do under one of its contracts, derived from ' +
      'the records as they are. Never stored; it is gone once the command that answers it ' +
      'commits.',
  });

export const ActionItemPageSchema = z
  .object({
    /**
     * Notices first, earliest deadline first (so overdue ones lead); then every other action,
     * longest waiting first. Ties in a fixed order by `key`.
     */
    items: z.array(ActionItemSchema).max(ACTION_ITEMS_MAX_PAGE_SIZE),
    /** The API's clock when this page was built; `overdue` is true as of then. */
    generatedAt: InstantSchema,
    /**
     * Pass as `cursor`, with the same filters, for the next page. Null when nothing follows. A
     * position, not a snapshot: see ADR 0017 for what changes between pages.
     */
    nextCursor: z.string().min(1).max(ACTION_ITEMS_CURSOR_MAX_LENGTH).nullable(),
  })
  .register(apiSchemaRegistry, {
    id: 'ActionItemPage',
    description: 'One page of the organization’s open actions. Carries no total.',
  });

/** Query of `GET /api/action-items`. Every parameter arrives as a string. */
export const ActionItemsQuerySchema = z.object({
  /** Only actions of this type. */
  type: ActionItemTypeSchema.optional(),
  /** `true`: only overdue actions, which only notices can be. Leave it out for all. */
  overdue: z
    .literal('true', 'Expected true, or leave it out')
    .transform(() => true as const)
    .optional(),
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, `Expected a whole number from 1 to ${ACTION_ITEMS_MAX_PAGE_SIZE}`)
    .transform(Number)
    .pipe(
      z
        .int()
        .max(
          ACTION_ITEMS_MAX_PAGE_SIZE,
          `Expected a whole number from 1 to ${ACTION_ITEMS_MAX_PAGE_SIZE}`,
        ),
    )
    .optional(),
  /** Opaque: only ever a `nextCursor` the API returned. */
  cursor: z
    .string()
    .max(ACTION_ITEMS_CURSOR_MAX_LENGTH, 'Expected a cursor from a previous page')
    .regex(/^[A-Za-z0-9_-]+$/, 'Expected a cursor from a previous page')
    .optional(),
});

export type ActionItemType = z.infer<typeof ActionItemTypeSchema>;
export type ActionItemVoyage = z.infer<typeof ActionItemVoyageSchema>;
export type ActionItemContract = z.infer<typeof ActionItemContractSchema>;
export type NoticeTarget = z.infer<typeof NoticeTargetSchema>;
export type InstructionRevisionTarget = z.infer<typeof InstructionRevisionTargetSchema>;
export type DocumentVersionTarget = z.infer<typeof DocumentVersionTargetSchema>;
export type ActionItem = z.infer<typeof ActionItemSchema>;
export type ActionItemPage = z.infer<typeof ActionItemPageSchema>;
export type ActionItemsQuery = z.infer<typeof ActionItemsQuerySchema>;
