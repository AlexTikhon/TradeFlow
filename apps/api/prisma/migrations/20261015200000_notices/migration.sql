-- CreateEnum
CREATE TYPE "notice_type" AS ENUM ('ETA');

-- CreateEnum
CREATE TYPE "notice_status" AS ENUM ('ISSUED', 'ACKNOWLEDGED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "audit_action" ADD VALUE 'NOTICE_ISSUED';
ALTER TYPE "audit_action" ADD VALUE 'NOTICE_ACKNOWLEDGED';

-- CreateTable
CREATE TABLE "notices" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "voyage_id" UUID NOT NULL,
    "trade_contract_id" UUID NOT NULL,
    "type" "notice_type" NOT NULL,
    "status" "notice_status" NOT NULL DEFAULT 'ISSUED',
    "estimated_arrival_at" TIMESTAMPTZ(3) NOT NULL,
    "acknowledgement_due_at" TIMESTAMPTZ(3) NOT NULL,
    "message" TEXT,
    "issued_by_user_id" UUID NOT NULL,
    "issued_by_organization_id" UUID NOT NULL,
    "issued_at" TIMESTAMPTZ(3) NOT NULL,
    "acknowledged_by_user_id" UUID,
    "acknowledged_by_organization_id" UUID,
    "acknowledged_at" TIMESTAMPTZ(3),

    CONSTRAINT "notices_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "notices_voyage_id_trade_contract_id_idx" ON "notices"("voyage_id", "trade_contract_id");

-- CreateIndex
CREATE INDEX "notices_issued_by_user_id_idx" ON "notices"("issued_by_user_id");

-- CreateIndex
CREATE INDEX "notices_acknowledged_by_user_id_idx" ON "notices"("acknowledged_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "trade_contracts_voyage_id_id_key" ON "trade_contracts"("voyage_id", "id");

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_voyage_id_trade_contract_id_fkey" FOREIGN KEY ("voyage_id", "trade_contract_id") REFERENCES "trade_contracts"("voyage_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_issued_by_user_id_fkey" FOREIGN KEY ("issued_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_issued_by_organization_id_fkey" FOREIGN KEY ("issued_by_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_acknowledged_by_user_id_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "notices" ADD CONSTRAINT "notices_acknowledged_by_organization_id_fkey" FOREIGN KEY ("acknowledged_by_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Hand-written invariants (Prisma schema cannot express these).
-- Who may issue and acknowledge (the contract's seller and buyer, operators only) is checked by
-- the notices service: it depends on the signed-in principal, which the database does not know.
-- ---------------------------------------------------------------------------

-- Messages are optional, bounded, and never blank.
ALTER TABLE "notices" ADD CONSTRAINT "notices_message_length" CHECK ("message" IS NULL OR (char_length("message") <= 1000 AND "message" ~ '\S'));

-- The deadline lies after the time of issue and not after the estimated arrival.
ALTER TABLE "notices" ADD CONSTRAINT "notices_due_after_issue" CHECK ("acknowledgement_due_at" > "issued_at");
ALTER TABLE "notices" ADD CONSTRAINT "notices_due_not_after_arrival" CHECK ("acknowledgement_due_at" <= "estimated_arrival_at");

-- An acknowledgement (who, for which organization, when) is recorded exactly when the notice is
-- ACKNOWLEDGED, and never before the notice was issued. A late acknowledgement is allowed.
ALTER TABLE "notices" ADD CONSTRAINT "notices_acknowledgement_matches_status" CHECK (
  ("status" = 'ISSUED'
    AND "acknowledged_by_user_id" IS NULL
    AND "acknowledged_by_organization_id" IS NULL
    AND "acknowledged_at" IS NULL)
  OR ("status" = 'ACKNOWLEDGED'
    AND "acknowledged_by_user_id" IS NOT NULL
    AND "acknowledged_by_organization_id" IS NOT NULL
    AND "acknowledged_at" IS NOT NULL)
);
ALTER TABLE "notices" ADD CONSTRAINT "notices_acknowledged_after_issue" CHECK ("acknowledged_at" IS NULL OR "acknowledged_at" >= "issued_at");

-- What the seller issued is immutable for every writer, and the only change a notice can go
-- through is its acknowledgement: ISSUED -> ACKNOWLEDGED, once. (DELETE is not covered: no
-- endpoint deletes notices, and the demo seed replaces its own voyages' notices wholesale.)
CREATE FUNCTION "notices_refuse_change"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF (NEW."id", NEW."voyage_id", NEW."trade_contract_id", NEW."type", NEW."estimated_arrival_at",
      NEW."acknowledgement_due_at", NEW."message", NEW."issued_by_user_id",
      NEW."issued_by_organization_id", NEW."issued_at")
     IS DISTINCT FROM
     (OLD."id", OLD."voyage_id", OLD."trade_contract_id", OLD."type", OLD."estimated_arrival_at",
      OLD."acknowledgement_due_at", OLD."message", OLD."issued_by_user_id",
      OLD."issued_by_organization_id", OLD."issued_at") THEN
    RAISE EXCEPTION 'notices: issued content is immutable'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF OLD."status" <> 'ISSUED' THEN
    RAISE EXCEPTION 'notices: an acknowledged notice cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "notices_immutable"
BEFORE UPDATE ON "notices"
FOR EACH ROW EXECUTE FUNCTION "notices_refuse_change"();
