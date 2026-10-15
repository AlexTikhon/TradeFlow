-- ---------------------------------------------------------------------------
-- Hand-written invariants for notice audit events. A separate migration because PostgreSQL
-- does not let a transaction use enum values it has just added (20261015200000_notices adds
-- NOTICE_ISSUED and NOTICE_ACKNOWLEDGED to audit_action).
-- ---------------------------------------------------------------------------

-- Notice events name their notice. (IS NOT DISTINCT FROM, because a missing key yields NULL,
-- and a CHECK that evaluates to NULL passes.)
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_notice_payload" CHECK (
  "action" NOT IN ('NOTICE_ISSUED', 'NOTICE_ACKNOWLEDGED')
  OR jsonb_typeof("payload" -> 'noticeId') IS NOT DISTINCT FROM 'string'
);

-- A notice is issued once and acknowledged at most once, so it has at most one event of each.
-- The last line of defence behind the conditional update that acknowledges a notice.
CREATE UNIQUE INDEX "audit_events_one_notice_issued" ON "audit_events"(("payload" ->> 'noticeId')) WHERE "action" = 'NOTICE_ISSUED';
CREATE UNIQUE INDEX "audit_events_one_notice_acknowledged" ON "audit_events"(("payload" ->> 'noticeId')) WHERE "action" = 'NOTICE_ACKNOWLEDGED';
