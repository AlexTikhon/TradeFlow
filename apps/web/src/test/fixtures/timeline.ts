import type { TimelineActor, TimelineEvent, VoyageTimelinePage } from '@tradeflow/contracts';
import { ana } from './notices';

/** Typed against the shared contract, so fixtures cannot drift from what the API returns. */
export const emptyTimeline: VoyageTimelinePage = { items: [], nextCursor: null };

export const timelinePage = (
  items: TimelineEvent[],
  nextCursor: string | null = null,
): VoyageTimelinePage => ({ items, nextCursor });

/** Contract 1 of TF-2026-0001 (Cerrado → Lacustra), as an event names it. */
export const timelineContract1 = { id: '01990000-0000-7000-8008-000000000101', position: 1 };

/**
 * What every event has: event `n` (ids are numbered so tests can make as many distinct ones as
 * they need), at `occurredAt`, by `actor` (Ana for Cerrado unless stated).
 */
export const eventBase = (
  n: number,
  occurredAt = '2030-10-15T12:00:00.000Z',
  actor: TimelineActor = ana,
) => ({ id: `01990000-0000-7000-8010-${String(n).padStart(12, '0')}`, occurredAt, actor });

/** The voyage's creation, by Ana for Cerrado. */
export const voyageCreated = (n = 1): TimelineEvent => ({
  ...eventBase(n, '2030-10-01T11:00:00.000Z'),
  action: 'VOYAGE_CREATED',
});

/** A notice issued by Ana under contract 1. */
export const noticeIssued = (n: number, occurredAt?: string): TimelineEvent => ({
  ...eventBase(n, occurredAt),
  action: 'NOTICE_ISSUED',
  contract: timelineContract1,
  noticeId: `01990000-0000-7000-8009-${String(n).padStart(12, '0')}`,
});
