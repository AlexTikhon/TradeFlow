-- ---------------------------------------------------------------------------
-- Hand-written invariants for trade string setup events (ADR 0016). A separate migration because
-- PostgreSQL does not let a transaction use enum values it has just added
-- (20261018100000_trade_string_setup adds VOYAGE_TRADE_STRING_CONFIGURED to audit_action).
-- ---------------------------------------------------------------------------

-- A setup event records the parties and the contracts as committed. (IS NOT DISTINCT FROM,
-- because a missing key yields NULL, and a CHECK that evaluates to NULL passes.)
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_trade_string_configured_payload" CHECK (
  "action" <> 'VOYAGE_TRADE_STRING_CONFIGURED'
  OR (jsonb_typeof("payload" -> 'parties') IS NOT DISTINCT FROM 'array'
    AND jsonb_typeof("payload" -> 'contracts') IS NOT DISTINCT FROM 'array')
);

-- A voyage's trade string is set up at most once. The last line of defence behind the voyage
-- lock and the state checks of the setup command.
CREATE UNIQUE INDEX "audit_events_one_trade_string_configured" ON "audit_events"("voyage_id") WHERE "action" = 'VOYAGE_TRADE_STRING_CONFIGURED';
