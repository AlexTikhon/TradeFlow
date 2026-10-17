import { z } from 'zod';
import { RequiredDocumentTypeSchema } from './documentary-instructions.js';
import { DocumentReviewDecisionSchema } from './documents.js';
import { apiSchemaRegistry } from './registry.js';
import { OrganizationRefSchema } from './voyages.js';

/*
 * A voyage's timeline: the audit events (ADR 0009) the signed-in organization may see, newest
 * first. Read-only. Each event says who acted, for which organization, when, and what, naming its
 * subject by identifiers only: nothing a payload records beyond that (instruction contents, file
 * names, checksums, rejection reasons, ...) is served here, and the panels that own those facts
 * keep serving them under their own rules.
 *
 * Who sees what follows the facts' own visibility. The voyage's creation: every participant.
 * Notice, instruction and document events: only the two counterparties of the contract they
 * happened under (ADR 0011). Events the organization may not see are left out by the database
 * before a page is cut, so they never shorten a page or show up in its cursor.
 */

/** Events per page when the client does not say. */
export const TIMELINE_DEFAULT_PAGE_SIZE = 20;
/** Most events one page may hold. */
export const TIMELINE_MAX_PAGE_SIZE = 50;
/** Longest cursor accepted; the API's own are far shorter. */
export const TIMELINE_CURSOR_MAX_LENGTH = 200;

export const TIMELINE_ACTIONS = [
  'VOYAGE_CREATED',
  'NOTICE_ISSUED',
  'NOTICE_ACKNOWLEDGED',
  'DOCUMENTARY_INSTRUCTION_REVISED',
  'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
  'DOCUMENT_VERSION_UPLOADED',
  'DOCUMENT_VERSION_REVIEWED',
] as const;

export const TimelineActionSchema = z
  .enum(TIMELINE_ACTIONS)
  .register(apiSchemaRegistry, { id: 'TimelineAction' });

/** Who acted: the signed-in user at the time, and the organization they acted for. */
export const TimelineActorSchema = z
  .object({
    name: z.string(),
    organization: OrganizationRefSchema,
  })
  .register(apiSchemaRegistry, { id: 'TimelineActor' });

/**
 * The contract an event happened under. Only its two counterparties ever see such an event, so
 * the id is theirs to know (ADR 0011); the position is the shared topology (ADR 0010).
 */
export const TimelineContractSchema = z
  .object({
    id: z.uuid(),
    position: z.int().min(1),
  })
  .register(apiSchemaRegistry, { id: 'TimelineContract' });

const eventBase = {
  id: z.uuid(),
  /** When the action happened, by the API's clock. */
  occurredAt: z.iso.datetime(),
  actor: TimelineActorSchema,
};

const contractEventBase = { ...eventBase, contract: TimelineContractSchema };

const instructionEvent = {
  ...contractEventBase,
  instructionId: z.uuid(),
  revisionNumber: z.int().min(1),
  /** The instruction's version this change produced (its entity tag). */
  version: z.int().min(1),
};

const documentEvent = {
  ...contractEventBase,
  documentId: z.uuid(),
  /** The instruction revision the document answers. */
  revisionNumber: z.int().min(1),
  documentType: RequiredDocumentTypeSchema,
  /** The file version uploaded or decided on. */
  versionNumber: z.int().min(1),
};

export const TimelineEventSchema = z
  .discriminatedUnion('action', [
    z.object({ ...eventBase, action: z.literal('VOYAGE_CREATED') }),
    z.object({ ...contractEventBase, action: z.literal('NOTICE_ISSUED'), noticeId: z.uuid() }),
    z.object({
      ...contractEventBase,
      action: z.literal('NOTICE_ACKNOWLEDGED'),
      noticeId: z.uuid(),
    }),
    z.object({ ...instructionEvent, action: z.literal('DOCUMENTARY_INSTRUCTION_REVISED') }),
    z.object({ ...instructionEvent, action: z.literal('DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED') }),
    z.object({
      ...documentEvent,
      action: z.literal('DOCUMENT_VERSION_UPLOADED'),
      /**
       * The document's version this upload produced (its entity tag). Null for uploads recorded
       * before reviews existed (ADR 0014), which did not record it.
       */
      version: z.int().min(1).nullable(),
    }),
    z.object({
      ...documentEvent,
      action: z.literal('DOCUMENT_VERSION_REVIEWED'),
      decision: DocumentReviewDecisionSchema,
      /** The document's version this review produced (its entity tag). */
      version: z.int().min(1),
    }),
  ])
  .register(apiSchemaRegistry, {
    id: 'TimelineEvent',
    description:
      'One action on the voyage: who, for which organization, when, and identifiers of what. ' +
      'Never the contents the action recorded.',
  });

export const VoyageTimelinePageSchema = z
  .object({
    /** Newest first; events with the same time in a fixed order. */
    items: z.array(TimelineEventSchema).max(TIMELINE_MAX_PAGE_SIZE),
    /** Pass as `cursor` for the next, older page. Null when there is nothing older. */
    nextCursor: z.string().min(1).max(TIMELINE_CURSOR_MAX_LENGTH).nullable(),
  })
  .register(apiSchemaRegistry, { id: 'VoyageTimelinePage' });

/** Query of `GET /api/voyages/{voyageId}/timeline`. Both parameters arrive as strings. */
export const VoyageTimelineQuerySchema = z.object({
  limit: z
    .string()
    .regex(/^[1-9]\d{0,2}$/, `Expected a whole number from 1 to ${TIMELINE_MAX_PAGE_SIZE}`)
    .transform(Number)
    .pipe(
      z
        .int()
        .max(TIMELINE_MAX_PAGE_SIZE, `Expected a whole number from 1 to ${TIMELINE_MAX_PAGE_SIZE}`),
    )
    .optional(),
  /** Opaque: only ever a `nextCursor` the API returned. */
  cursor: z
    .string()
    .max(TIMELINE_CURSOR_MAX_LENGTH, 'Expected a cursor from a previous page')
    .regex(/^[A-Za-z0-9_-]+$/, 'Expected a cursor from a previous page')
    .optional(),
});

export type TimelineAction = z.infer<typeof TimelineActionSchema>;
export type TimelineActor = z.infer<typeof TimelineActorSchema>;
export type TimelineContract = z.infer<typeof TimelineContractSchema>;
export type TimelineEvent = z.infer<typeof TimelineEventSchema>;
export type VoyageTimelinePage = z.infer<typeof VoyageTimelinePageSchema>;
export type VoyageTimelineQuery = z.infer<typeof VoyageTimelineQuerySchema>;
