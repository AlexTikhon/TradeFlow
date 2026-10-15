import { z } from 'zod';
import { apiSchemaRegistry } from './registry.js';
import { CounterpartyContractSchema } from './trade-contracts.js';
import { OrganizationRefSchema } from './voyages.js';

/*
 * Notices travel from the seller to the buyer under one sale contract, and only those two
 * organizations may read them (ADR 0011). One type and one workflow so far: an ETA notice is
 * ISSUED by the seller and ACKNOWLEDGED by the buyer. Acknowledging records receipt; it does not
 * accept anything commercially.
 */

export const NOTICE_TYPES = ['ETA'] as const;

export const NoticeTypeSchema = z.enum(NOTICE_TYPES).register(apiSchemaRegistry, {
  id: 'NoticeType',
  description: 'ETA: the estimated time of arrival of the vessel, as the seller states it.',
});

export const NOTICE_STATUSES = ['ISSUED', 'ACKNOWLEDGED'] as const;

export const NoticeStatusSchema = z.enum(NOTICE_STATUSES).register(apiSchemaRegistry, {
  id: 'NoticeStatus',
  description:
    'ISSUED until the buyer acknowledges receipt, then ACKNOWLEDGED. Being overdue is not a ' +
    'status: see `overdue`.',
});

/** Longest message a notice may carry, in characters. */
export const NOTICE_MESSAGE_MAX_LENGTH = 1000;

/** An instant as the API answers it: ISO 8601 in UTC (`Z`), millisecond precision. */
const InstantSchema = z.iso.datetime();

/**
 * An instant as a client submits it: ISO 8601 with seconds and an explicit offset (`Z` or
 * `+02:00`). A local time without an offset is ambiguous, so it is rejected.
 */
export const InstantInputSchema = z.iso
  .datetime({ offset: true, error: 'Expected a date and time with a time zone offset' })
  .register(apiSchemaRegistry, {
    id: 'InstantInput',
    description: 'An ISO 8601 date and time with seconds and an offset, e.g. 2026-10-20T14:00:00Z.',
  });

/** Who did something to a notice: always the signed-in user, as resolved by the server. */
export const NoticeActorSchema = z
  .object({
    name: z.string(),
    organization: OrganizationRefSchema,
  })
  .register(apiSchemaRegistry, { id: 'NoticeActor' });

export const NoticeSchema = z
  .object({
    id: z.uuid(),
    voyageId: z.uuid(),
    type: NoticeTypeSchema,
    status: NoticeStatusSchema,
    /** The contract the notice was issued under, from the reader's side. */
    contract: CounterpartyContractSchema,
    estimatedArrivalAt: InstantSchema,
    /** The buyer is asked to acknowledge receipt by then; a late acknowledgement is accepted. */
    acknowledgementDueAt: InstantSchema,
    message: z.string().nullable(),
    issuedAt: InstantSchema,
    issuedBy: NoticeActorSchema,
    acknowledgedAt: InstantSchema.nullable(),
    acknowledgedBy: NoticeActorSchema.nullable(),
    /** Derived when the response is built: still ISSUED and the deadline has passed. */
    overdue: z.boolean(),
  })
  .refine(
    (notice) =>
      notice.status === 'ACKNOWLEDGED'
        ? notice.acknowledgedAt !== null && notice.acknowledgedBy !== null
        : notice.acknowledgedAt === null && notice.acknowledgedBy === null,
    { message: 'An acknowledgement is recorded exactly when the notice is ACKNOWLEDGED' },
  )
  .refine((notice) => !(notice.overdue && notice.status === 'ACKNOWLEDGED'), {
    message: 'An acknowledged notice is never overdue',
  })
  .register(apiSchemaRegistry, {
    id: 'Notice',
    description:
      'A notice from the seller to the buyer under one sale contract. Readable only by those ' +
      'two organizations. Its issued content never changes.',
  });

export const NoticeListResponseSchema = z
  .object({
    /** Most recently issued first. */
    items: z.array(NoticeSchema),
  })
  .register(apiSchemaRegistry, { id: 'NoticeListResponse' });

/** A message a client submits: trimmed, not blank, and bounded. */
export const NoticeMessageInputSchema = z
  .string()
  .trim()
  .min(1, 'Leave the message out, or write something')
  .max(NOTICE_MESSAGE_MAX_LENGTH, `Use at most ${NOTICE_MESSAGE_MAX_LENGTH} characters`);

/**
 * Body of `POST /api/voyages/{voyageId}/notices`. Only what the seller states: the issuer, its
 * organization, the time of issue and the status are decided by the server, and a body that
 * tries to set them is rejected. The deadline must also lie in the future when the notice is
 * issued; only the server's clock can check that.
 */
export const IssueNoticeRequestSchema = z
  .strictObject({
    contractId: z.uuid(),
    estimatedArrivalAt: InstantInputSchema,
    acknowledgementDueAt: InstantInputSchema,
    message: NoticeMessageInputSchema.optional(),
  })
  .refine(
    (request) => Date.parse(request.acknowledgementDueAt) <= Date.parse(request.estimatedArrivalAt),
    {
      path: ['acknowledgementDueAt'],
      message: 'The acknowledgement deadline must not be after the estimated arrival',
    },
  )
  .register(apiSchemaRegistry, { id: 'IssueNoticeRequest' });

/**
 * Body of `POST /api/voyages/{voyageId}/notices/{noticeId}/acknowledgement`: empty, or no body
 * at all. Who acknowledged and when come from the session and the server's clock.
 */
export const AcknowledgeNoticeRequestSchema = z.strictObject({}).register(apiSchemaRegistry, {
  id: 'AcknowledgeNoticeRequest',
  description: 'Empty. The acknowledging user, their organization and the time are server-side.',
});

export const NoticeIdParamSchema = z.uuid();

export type NoticeType = z.infer<typeof NoticeTypeSchema>;
export type NoticeStatus = z.infer<typeof NoticeStatusSchema>;
export type NoticeActor = z.infer<typeof NoticeActorSchema>;
export type Notice = z.infer<typeof NoticeSchema>;
export type NoticeListResponse = z.infer<typeof NoticeListResponseSchema>;
export type IssueNoticeRequest = z.infer<typeof IssueNoticeRequestSchema>;
export type AcknowledgeNoticeRequest = z.infer<typeof AcknowledgeNoticeRequestSchema>;
