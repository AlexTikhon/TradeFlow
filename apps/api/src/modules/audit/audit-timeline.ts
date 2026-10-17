import { Injectable } from '@nestjs/common';
import {
  DocumentReviewDecisionSchema,
  RequiredDocumentTypeSchema,
  type TimelineActor,
  type TimelineContract,
  type TimelineEvent,
  type VoyageTimelinePage,
} from '@tradeflow/contracts';
import { z } from 'zod';
import { RequestValidationException } from '../../common/http/request-validation.exception.js';
import type { AuditAction, Prisma } from '../../generated/prisma/client.js';

/*
 * Reads `audit_events` as a voyage's timeline (ADR 0009): newest first, a page at a time. The
 * audit module owns the table, so this is the only reader. It does not decide who may see what;
 * the caller does (the voyages module, which owns participation and contracts), and hands over
 * the result as a `TimelineScope`. The scope is applied in the WHERE clause, so events outside it
 * are gone before LIMIT: they never shorten a page, decide whether there is a next one, or end
 * up in a cursor.
 */

/** Where a page ends: the last event served, in the order `occurredAt DESC, id DESC`. */
export interface TimelinePosition {
  occurredAt: Date;
  id: string;
}

/** What the reader may see of one voyage's events. */
export interface TimelineScope {
  voyageId: string;
  /**
   * The voyage's contracts the reader's organization is a counterparty to, now: their events
   * are visible, and no other contract's are. The voyage's own events (its creation) are visible
   * to whoever the caller has already established participates in it.
   */
  contracts: readonly TimelineContract[];
}

export interface TimelinePageRequest {
  /** Events strictly older than this position; the newest when absent. */
  after?: TimelinePosition | undefined;
  limit: number;
}

/** Events about the voyage itself, visible to every participant. */
const VOYAGE_ACTIONS = ['VOYAGE_CREATED'] as const satisfies readonly AuditAction[];

/** Events under one sale contract, visible to its two counterparties only (ADR 0011). */
const CONTRACT_ACTIONS = [
  'NOTICE_ISSUED',
  'NOTICE_ACKNOWLEDGED',
  'DOCUMENTARY_INSTRUCTION_REVISED',
  'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
  'DOCUMENT_VERSION_UPLOADED',
  'DOCUMENT_VERSION_REVIEWED',
] as const satisfies readonly AuditAction[];

/*
 * The payload facts a timeline entry may carry, per action: identifiers only. Zod objects drop
 * every other key, so instruction contents, file names, checksums, rejection reasons and anything
 * a payload gains later never reach a response unless they are added here on purpose.
 */
const contractFacts = { contractId: z.uuid() };
const instructionFacts = z.object({
  ...contractFacts,
  instructionId: z.uuid(),
  revisionNumber: z.int().min(1),
  version: z.int().min(1),
});
const documentFacts = {
  ...contractFacts,
  documentId: z.uuid(),
  revisionNumber: z.int().min(1),
  documentType: RequiredDocumentTypeSchema,
  versionNumber: z.int().min(1),
};
const noticeFacts = z.object({ ...contractFacts, noticeId: z.uuid() });
const uploadFacts = z.object({
  ...documentFacts,
  // Uploads recorded before ADR 0014 did not record the document's version.
  version: z.int().min(1).optional(),
});
const reviewFacts = z.object({
  ...documentFacts,
  decision: DocumentReviewDecisionSchema,
  version: z.int().min(1),
});

const timelineEventSelect = {
  id: true,
  action: true,
  occurredAt: true,
  payload: true,
  actorUser: { select: { fullName: true } },
  actorOrganization: { select: { id: true, name: true, countryCode: true } },
} satisfies Prisma.AuditEventSelect;

type TimelineEventRow = Prisma.AuditEventGetPayload<{ select: typeof timelineEventSelect }>;

@Injectable()
export class AuditTimeline {
  /**
   * One page of the voyage's events within `scope`, newest first. Reads through `db`, so a
   * caller that resolved the scope in a transaction reads the events from the same snapshot.
   * Takes one row beyond the page to tell whether an older page exists.
   */
  async page(
    db: Prisma.TransactionClient,
    scope: TimelineScope,
    { after, limit }: TimelinePageRequest,
  ): Promise<VoyageTimelinePage> {
    const rows = await db.auditEvent.findMany({
      where: { AND: [visibleIn(scope), ...(after ? [olderThan(after)] : [])] },
      select: timelineEventSelect,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: limit + 1,
    });
    const items = rows.slice(0, limit);
    const last = items.at(-1);
    return {
      items: items.map((row) => toTimelineEvent(row, scope)),
      nextCursor: rows.length > limit && last ? encodeTimelineCursor(last) : null,
    };
  }
}

/** The scope as a predicate: the voyage's own events, and events under the given contracts. */
function visibleIn({ voyageId, contracts }: TimelineScope): Prisma.AuditEventWhereInput {
  const contractEvents: Prisma.AuditEventWhereInput[] =
    contracts.length === 0
      ? []
      : [
          {
            action: { in: [...CONTRACT_ACTIONS] },
            OR: contracts.map(({ id }) => ({ payload: { path: ['contractId'], equals: id } })),
          },
        ];
  return {
    voyageId,
    // Any action not listed here (a future one) stays hidden until it is given a rule.
    OR: [{ action: { in: [...VOYAGE_ACTIONS] } }, ...contractEvents],
  };
}

/** Strictly after `position` in `occurredAt DESC, id DESC` order. */
function olderThan({ occurredAt, id }: TimelinePosition): Prisma.AuditEventWhereInput {
  return { OR: [{ occurredAt: { lt: occurredAt } }, { occurredAt, id: { lt: id } }] };
}

/*
 * Cursors are the position of the last event served, as base64url JSON. They carry nothing the
 * reader did not just receive, and need no signature: the scope is applied to every page, so a
 * cursor made up by hand can only move within what its bearer may see anyway.
 */
const CursorSchema = z.tuple([z.iso.datetime(), z.uuid()]);

function encodeTimelineCursor({ occurredAt, id }: TimelinePosition): string {
  return Buffer.from(JSON.stringify([occurredAt.toISOString(), id])).toString('base64url');
}

/**
 * The position a cursor names. A cursor the API did not produce is a client error (400), the
 * same for every voyage, so it says nothing about whether the voyage exists.
 */
export function parseTimelineCursor(cursor: string): TimelinePosition {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    decoded = undefined;
  }
  const parsed = CursorSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new RequestValidationException([
      { path: 'query.cursor', message: 'Expected a cursor from a previous page' },
    ]);
  }
  const [occurredAt, id] = parsed.data;
  return { occurredAt: new Date(occurredAt), id };
}

function toTimelineEvent(row: TimelineEventRow, scope: TimelineScope): TimelineEvent {
  const base = {
    id: row.id,
    occurredAt: row.occurredAt.toISOString(),
    actor: {
      name: row.actorUser.fullName,
      organization: row.actorOrganization,
    } satisfies TimelineActor,
  };
  const facts = <T extends z.ZodType>(schema: T): z.output<T> => {
    const parsed = schema.safeParse(row.payload);
    if (!parsed.success) {
      // The write paths and CHECK constraints make this a data error, never a client's.
      throw new Error(`Audit event ${row.id} (${row.action}) has an unreadable payload`);
    }
    return parsed.data;
  };
  const contract = (contractId: string): TimelineContract => {
    const found = scope.contracts.find(({ id }) => id === contractId);
    if (!found) {
      // The query selected only events under these contracts.
      throw new Error(`Audit event ${row.id} is outside the timeline's scope`);
    }
    return found;
  };

  switch (row.action) {
    case 'VOYAGE_CREATED':
      return { ...base, action: row.action };
    case 'NOTICE_ISSUED':
    case 'NOTICE_ACKNOWLEDGED': {
      const { contractId, noticeId } = facts(noticeFacts);
      return { ...base, action: row.action, contract: contract(contractId), noticeId };
    }
    case 'DOCUMENTARY_INSTRUCTION_REVISED':
    case 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED': {
      const { contractId, instructionId, revisionNumber, version } = facts(instructionFacts);
      return {
        ...base,
        action: row.action,
        contract: contract(contractId),
        instructionId,
        revisionNumber,
        version,
      };
    }
    case 'DOCUMENT_VERSION_UPLOADED': {
      const { contractId, documentId, revisionNumber, documentType, versionNumber, version } =
        facts(uploadFacts);
      return {
        ...base,
        action: row.action,
        contract: contract(contractId),
        documentId,
        revisionNumber,
        documentType,
        versionNumber,
        version: version ?? null,
      };
    }
    case 'DOCUMENT_VERSION_REVIEWED': {
      const {
        contractId,
        documentId,
        revisionNumber,
        documentType,
        versionNumber,
        decision,
        version,
      } = facts(reviewFacts);
      return {
        ...base,
        action: row.action,
        contract: contract(contractId),
        documentId,
        revisionNumber,
        documentType,
        versionNumber,
        decision,
        version,
      };
    }
  }
}
