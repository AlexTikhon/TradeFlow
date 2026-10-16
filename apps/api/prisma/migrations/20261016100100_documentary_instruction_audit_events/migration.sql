-- ---------------------------------------------------------------------------
-- Hand-written invariants for documentary instruction audit events. A separate migration because
-- PostgreSQL does not let a transaction use enum values it has just added
-- (20261016100000_documentary_instructions adds DOCUMENTARY_INSTRUCTION_REVISED and
-- DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED to audit_action).
-- ---------------------------------------------------------------------------

-- Instruction events name their instruction, the revision and the version the change produced.
-- (IS NOT DISTINCT FROM, because a missing key yields NULL, and a CHECK that evaluates to NULL
-- passes.)
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_documentary_instruction_payload" CHECK (
  "action" NOT IN ('DOCUMENTARY_INSTRUCTION_REVISED', 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED')
  OR (jsonb_typeof("payload" -> 'instructionId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload" -> 'revisionNumber') IS NOT DISTINCT FROM 'number'
    AND jsonb_typeof("payload" -> 'version') IS NOT DISTINCT FROM 'number')
);

-- Every version of an instruction is produced by exactly one change, and a revision is written
-- once and acknowledged at most once. The last line of defence behind the conditional updates.
CREATE UNIQUE INDEX "audit_events_one_instruction_version" ON "audit_events"(("payload" ->> 'instructionId'), ("payload" ->> 'version')) WHERE "action" IN ('DOCUMENTARY_INSTRUCTION_REVISED', 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED');
CREATE UNIQUE INDEX "audit_events_one_instruction_revision" ON "audit_events"(("payload" ->> 'instructionId'), ("payload" ->> 'revisionNumber')) WHERE "action" = 'DOCUMENTARY_INSTRUCTION_REVISED';
CREATE UNIQUE INDEX "audit_events_one_instruction_acknowledgement" ON "audit_events"(("payload" ->> 'instructionId'), ("payload" ->> 'revisionNumber')) WHERE "action" = 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED';
