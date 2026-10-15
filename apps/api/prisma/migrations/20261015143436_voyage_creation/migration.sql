-- CreateEnum
CREATE TYPE "user_role" AS ENUM ('VIEWER', 'OPERATOR');

-- CreateEnum
CREATE TYPE "audit_action" AS ENUM ('VOYAGE_CREATED');

-- AlterTable
ALTER TABLE "users" ADD COLUMN     "role" "user_role" NOT NULL DEFAULT 'VIEWER';

-- CreateTable
CREATE TABLE "voyage_reference_counters" (
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL,

    CONSTRAINT "voyage_reference_counters_pkey" PRIMARY KEY ("year")
);

-- CreateTable
CREATE TABLE "audit_events" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "action" "audit_action" NOT NULL,
    "actor_user_id" UUID NOT NULL,
    "actor_organization_id" UUID NOT NULL,
    "voyage_id" UUID NOT NULL,
    "occurred_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL,

    CONSTRAINT "audit_events_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "audit_events_voyage_id_occurred_at_idx" ON "audit_events"("voyage_id", "occurred_at");

-- CreateIndex
CREATE INDEX "audit_events_actor_user_id_idx" ON "audit_events"("actor_user_id");

-- CreateIndex
CREATE INDEX "audit_events_actor_organization_id_idx" ON "audit_events"("actor_organization_id");

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_user_id_fkey" FOREIGN KEY ("actor_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_organization_id_fkey" FOREIGN KEY ("actor_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (Prisma schema cannot express these).
-- ---------------------------------------------------------------------------

-- Reference counters hold four-digit years and non-negative numbers.
ALTER TABLE "voyage_reference_counters" ADD CONSTRAINT "voyage_reference_counters_year_range" CHECK ("year" BETWEEN 2000 AND 9999);
ALTER TABLE "voyage_reference_counters" ADD CONSTRAINT "voyage_reference_counters_last_number_non_negative" CHECK ("last_number" >= 0);

-- Existing voyages already use TF-<year>-<number> references: continue after the highest one, so
-- the first voyage created through the API cannot collide with them.
INSERT INTO "voyage_reference_counters" ("year", "last_number")
SELECT (regexp_match("reference", '^TF-(\d{4})-\d+$'))[1]::int,
       max((regexp_match("reference", '^TF-\d{4}-(\d+)$'))[1]::int)
FROM "voyages"
WHERE "reference" ~ '^TF-\d{4}-\d+$'
GROUP BY 1;

-- Audit payloads are JSON objects (named facts), never bare values.
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_payload_object" CHECK (jsonb_typeof("payload") = 'object');

-- A voyage is created once, so it has at most one creation event.
CREATE UNIQUE INDEX "audit_events_one_voyage_created" ON "audit_events"("voyage_id") WHERE "action" = 'VOYAGE_CREATED';

-- The audit trail is append-only for every writer, not only for the API. (TRUNCATE, an
-- administrative operation used to reset test databases, is deliberately not covered.)
CREATE FUNCTION "audit_events_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only: % is not allowed', TG_OP
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "audit_events_append_only"
BEFORE UPDATE OR DELETE ON "audit_events"
FOR EACH ROW EXECUTE FUNCTION "audit_events_refuse_change"();
