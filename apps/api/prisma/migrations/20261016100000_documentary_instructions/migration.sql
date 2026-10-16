-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "audit_action" ADD VALUE 'DOCUMENTARY_INSTRUCTION_REVISED';
ALTER TYPE "audit_action" ADD VALUE 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED';

-- CreateTable
CREATE TABLE "documentary_instructions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "voyage_id" UUID NOT NULL,
    "trade_contract_id" UUID NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "current_revision_number" INTEGER NOT NULL DEFAULT 1,
    "created_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "documentary_instructions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documentary_instruction_revisions" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "instruction_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "consignee" TEXT NOT NULL,
    "notify_party" TEXT,
    "requirements" JSONB NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_by_organization_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "documentary_instruction_revisions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "documentary_instruction_acknowledgements" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "instruction_id" UUID NOT NULL,
    "revision_number" INTEGER NOT NULL,
    "acknowledged_by_user_id" UUID NOT NULL,
    "acknowledged_by_organization_id" UUID NOT NULL,
    "acknowledged_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "documentary_instruction_acknowledgements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "documentary_instructions_trade_contract_id_key" ON "documentary_instructions"("trade_contract_id");

-- CreateIndex
CREATE INDEX "documentary_instructions_voyage_id_idx" ON "documentary_instructions"("voyage_id");

-- CreateIndex
CREATE INDEX "documentary_instruction_revisions_created_by_user_id_idx" ON "documentary_instruction_revisions"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "documentary_instruction_revisions_instruction_id_revision_n_key" ON "documentary_instruction_revisions"("instruction_id", "revision_number");

-- CreateIndex
CREATE INDEX "documentary_instruction_acknowledgements_acknowledged_by_us_idx" ON "documentary_instruction_acknowledgements"("acknowledged_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "documentary_instruction_acknowledgements_instruction_id_rev_key" ON "documentary_instruction_acknowledgements"("instruction_id", "revision_number");

-- AddForeignKey
ALTER TABLE "documentary_instructions" ADD CONSTRAINT "documentary_instructions_voyage_id_fkey" FOREIGN KEY ("voyage_id") REFERENCES "voyages"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentary_instructions" ADD CONSTRAINT "documentary_instructions_voyage_id_trade_contract_id_fkey" FOREIGN KEY ("voyage_id", "trade_contract_id") REFERENCES "trade_contracts"("voyage_id", "id") ON DELETE RESTRICT ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "documentary_instruction_revisions" ADD CONSTRAINT "documentary_instruction_revisions_instruction_id_fkey" FOREIGN KEY ("instruction_id") REFERENCES "documentary_instructions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentary_instruction_revisions" ADD CONSTRAINT "documentary_instruction_revisions_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentary_instruction_revisions" ADD CONSTRAINT "documentary_instruction_revisions_created_by_organization__fkey" FOREIGN KEY ("created_by_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentary_instruction_acknowledgements" ADD CONSTRAINT "documentary_instruction_acknowledgements_instruction_id_fkey" FOREIGN KEY ("instruction_id") REFERENCES "documentary_instructions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentary_instruction_acknowledgements" ADD CONSTRAINT "documentary_instruction_acknowledgements_instruction_id_re_fkey" FOREIGN KEY ("instruction_id", "revision_number") REFERENCES "documentary_instruction_revisions"("instruction_id", "revision_number") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "documentary_instruction_acknowledgements" ADD CONSTRAINT "documentary_instruction_acknowledgements_acknowledged_by_u_fkey" FOREIGN KEY ("acknowledged_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "documentary_instruction_acknowledgements" ADD CONSTRAINT "documentary_instruction_acknowledgements_acknowledged_by_o_fkey" FOREIGN KEY ("acknowledged_by_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Hand-written invariants (Prisma schema cannot express these).
-- Who may revise and acknowledge (the contract's buyer and seller, operators only) is checked by
-- the documentary-instructions service: it depends on the signed-in principal, which the
-- database does not know. Everything below holds for every writer.
-- ---------------------------------------------------------------------------

-- The aggregate: positive counters, and at most one revision per change (each revision is a
-- change, so the current revision number never exceeds the version).
ALTER TABLE "documentary_instructions" ADD CONSTRAINT "documentary_instructions_counters" CHECK (
  "version" >= 1 AND "current_revision_number" >= 1 AND "current_revision_number" <= "version"
);

-- Revision content: bounded, never blank party details, and well-formed requirements.
ALTER TABLE "documentary_instruction_revisions" ADD CONSTRAINT "documentary_instruction_revisions_number_positive" CHECK ("revision_number" >= 1);
ALTER TABLE "documentary_instruction_revisions" ADD CONSTRAINT "documentary_instruction_revisions_consignee_length" CHECK (char_length("consignee") <= 500 AND "consignee" ~ '\S');
ALTER TABLE "documentary_instruction_revisions" ADD CONSTRAINT "documentary_instruction_revisions_notify_party_length" CHECK ("notify_party" IS NULL OR (char_length("notify_party") <= 500 AND "notify_party" ~ '\S'));

-- `[{ "document": <type>, "originals": 0..10, "copies": 0..10 }]`: one to eight entries, exactly
-- those keys, integer counts not both zero, each document at most once. The document types are
-- the shared contract's REQUIRED_DOCUMENT_TYPES; an integration test writes every one of them.
CREATE FUNCTION "documentary_requirements_valid"(requirements jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE
  item jsonb;
  documents text[] := '{}';
BEGIN
  IF jsonb_typeof(requirements) IS DISTINCT FROM 'array'
     OR jsonb_array_length(requirements) NOT BETWEEN 1 AND 8 THEN
    RETURN false;
  END IF;
  FOR item IN SELECT value FROM jsonb_array_elements(requirements) LOOP
    IF jsonb_typeof(item) <> 'object'
       OR ARRAY(SELECT jsonb_object_keys(item) ORDER BY 1) <> ARRAY['copies', 'document', 'originals']
       OR jsonb_typeof(item -> 'document') <> 'string'
       OR NOT (item ->> 'document') = ANY (ARRAY['BILL_OF_LADING', 'COMMERCIAL_INVOICE',
         'CERTIFICATE_OF_ORIGIN', 'PHYTOSANITARY_CERTIFICATE', 'WEIGHT_CERTIFICATE',
         'QUALITY_CERTIFICATE', 'FUMIGATION_CERTIFICATE', 'INSURANCE_CERTIFICATE'])
       OR (item ->> 'document') = ANY (documents)
       OR jsonb_typeof(item -> 'originals') <> 'number'
       OR jsonb_typeof(item -> 'copies') <> 'number'
       OR (item ->> 'originals') !~ '^(10|[0-9])$'
       OR (item ->> 'copies') !~ '^(10|[0-9])$'
       OR (item ->> 'originals')::int + (item ->> 'copies')::int = 0 THEN
      RETURN false;
    END IF;
    documents := documents || (item ->> 'document');
  END LOOP;
  RETURN true;
END;
$$;

ALTER TABLE "documentary_instruction_revisions" ADD CONSTRAINT "documentary_instruction_revisions_requirements_valid" CHECK ("documentary_requirements_valid"("requirements"));

-- How the aggregate may change, for every writer. It is created at version 1 with revision 1.
-- Afterwards each change advances the version by exactly one, and the current revision number
-- by at most one; what the instruction belongs to never changes.
CREATE FUNCTION "documentary_instructions_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."version" <> 1 OR NEW."current_revision_number" <> 1 THEN
      RAISE EXCEPTION 'documentary_instructions: an instruction starts at version 1 with revision 1'
        USING ERRCODE = 'restrict_violation';
    END IF;
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."voyage_id", NEW."trade_contract_id", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."voyage_id", OLD."trade_contract_id", OLD."created_at") THEN
    RAISE EXCEPTION 'documentary_instructions: what an instruction belongs to cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'documentary_instructions: every change advances the version by exactly one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."current_revision_number" NOT IN (OLD."current_revision_number", OLD."current_revision_number" + 1) THEN
    RAISE EXCEPTION 'documentary_instructions: revisions are numbered one after another'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "documentary_instructions_guard"
BEFORE INSERT OR UPDATE ON "documentary_instructions"
FOR EACH ROW EXECUTE FUNCTION "documentary_instructions_guard"();

-- The current revision exists by the time the transaction commits: an instruction is never
-- created, or advanced to a new revision, without writing that revision.
CREATE FUNCTION "documentary_instructions_require_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "documentary_instruction_revisions"
    WHERE "instruction_id" = NEW."id" AND "revision_number" = NEW."current_revision_number"
  ) THEN
    RAISE EXCEPTION 'documentary_instructions: the current revision % does not exist', NEW."current_revision_number"
      USING ERRCODE = 'foreign_key_violation';
  END IF;
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "documentary_instructions_require_revision"
AFTER INSERT OR UPDATE ON "documentary_instructions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "documentary_instructions_require_revision"();

-- Revisions and acknowledgements are written only for the instruction's current revision: a
-- revision right after the instruction advanced to it (so numbers have no gaps), and an
-- acknowledgement of the revision in force (never of a superseded one). The instruction row is
-- share-locked, so it cannot move on until this transaction ends.
CREATE FUNCTION "documentary_instructions_require_current_revision"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  current_number integer;
BEGIN
  SELECT "current_revision_number" INTO current_number
  FROM "documentary_instructions" WHERE "id" = NEW."instruction_id"
  FOR SHARE;
  IF current_number IS DISTINCT FROM NEW."revision_number" THEN
    RAISE EXCEPTION '%: only the current revision of an instruction can be written', TG_TABLE_NAME
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "documentary_instruction_revisions_current"
BEFORE INSERT ON "documentary_instruction_revisions"
FOR EACH ROW EXECUTE FUNCTION "documentary_instructions_require_current_revision"();

CREATE TRIGGER "documentary_instruction_acknowledgements_current"
BEFORE INSERT ON "documentary_instruction_acknowledgements"
FOR EACH ROW EXECUTE FUNCTION "documentary_instructions_require_current_revision"();

-- Revisions and acknowledgements are immutable for every writer. (DELETE is not covered: no
-- endpoint deletes them, and the demo seed removes instructions on its own voyages wholesale,
-- which cascades. The same choice as for notices.)
CREATE FUNCTION "documentary_instructions_refuse_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '%: rows are immutable', TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "documentary_instruction_revisions_immutable"
BEFORE UPDATE ON "documentary_instruction_revisions"
FOR EACH ROW EXECUTE FUNCTION "documentary_instructions_refuse_update"();

CREATE TRIGGER "documentary_instruction_acknowledgements_immutable"
BEFORE UPDATE ON "documentary_instruction_acknowledgements"
FOR EACH ROW EXECUTE FUNCTION "documentary_instructions_refuse_update"();
