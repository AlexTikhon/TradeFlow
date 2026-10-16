-- CreateEnum
CREATE TYPE "document_review_decision" AS ENUM ('APPROVED', 'REJECTED');

-- AlterEnum
ALTER TYPE "audit_action" ADD VALUE 'DOCUMENT_VERSION_REVIEWED';

-- AlterTable
ALTER TABLE "documents" ADD COLUMN     "version" INTEGER NOT NULL DEFAULT 1;

-- CreateTable
CREATE TABLE "document_reviews" (
    "id" UUID NOT NULL DEFAULT uuidv7(),
    "document_id" UUID NOT NULL,
    "version_number" INTEGER NOT NULL,
    "decision" "document_review_decision" NOT NULL,
    "reason" TEXT,
    "reviewed_by_user_id" UUID NOT NULL,
    "reviewed_by_organization_id" UUID NOT NULL,
    "reviewed_at" TIMESTAMPTZ(3) NOT NULL,

    CONSTRAINT "document_reviews_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "document_reviews_reviewed_by_user_id_idx" ON "document_reviews"("reviewed_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "document_reviews_document_id_version_number_key" ON "document_reviews"("document_id", "version_number");

-- AddForeignKey
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_document_id_version_number_fkey" FOREIGN KEY ("document_id", "version_number") REFERENCES "document_versions"("document_id", "version_number") ON DELETE CASCADE ON UPDATE NO ACTION;

-- AddForeignKey
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_reviewed_by_user_id_fkey" FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_reviewed_by_organization_id_fkey" FOREIGN KEY ("reviewed_by_organization_id") REFERENCES "organizations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;



-- ---------------------------------------------------------------------------
-- Backfill (ADR 0014). Before this migration every change to a document was an upload, so a
-- document's version is the number of its uploads: its current version number. The column was
-- added at 1 for every row; documents with several versions are set to their count here.
--
-- documents_guard refuses any update that does not add a version, so it is switched off for the
-- backfill only, and switched on again before anything else runs. The deferred check that the
-- current version exists is made immediate, so the backfill leaves no pending trigger events
-- (PostgreSQL refuses ALTER TABLE on a table that has some).
-- ---------------------------------------------------------------------------

SET CONSTRAINTS "documents_require_version" IMMEDIATE;
ALTER TABLE "documents" DISABLE TRIGGER "documents_guard";
UPDATE "documents" SET "version" = "current_version_number" WHERE "version" <> "current_version_number";
ALTER TABLE "documents" ENABLE TRIGGER "documents_guard";
SET CONSTRAINTS "documents_require_version" DEFERRED;

-- ---------------------------------------------------------------------------
-- Hand-written invariants (Prisma schema cannot express these).
-- Who may review (operators of the contract's buyer) is checked by the documents service: it
-- depends on the signed-in principal, which the database does not know. Everything below holds
-- for every writer.
-- ---------------------------------------------------------------------------

-- The version counts uploads and reviews, so it is never behind the uploads alone.
ALTER TABLE "documents" ADD CONSTRAINT "documents_version_counts_uploads" CHECK (
  "version" >= "current_version_number"
);

-- How a document may change, for every writer (replaces the rules of 20261016120000_documents).
-- It is created at version 1 with file version 1, for an open revision that requires it. Each
-- change afterwards, an upload or a review, advances the version by exactly one; an upload also
-- advances the file version by one, a review leaves it. What the document belongs to never
-- changes.
CREATE OR REPLACE FUNCTION "documents_guard"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."current_version_number" <> 1 OR NEW."version" <> 1 THEN
      RAISE EXCEPTION 'documents: a document starts at version 1'
        USING ERRCODE = 'restrict_violation';
    END IF;
    PERFORM "documents_require_open_revision"(NEW."instruction_id", NEW."revision_number", NEW."document_type");
    RETURN NEW;
  END IF;
  IF (NEW."id", NEW."voyage_id", NEW."trade_contract_id", NEW."instruction_id", NEW."revision_number",
      NEW."document_type", NEW."created_at")
     IS DISTINCT FROM (OLD."id", OLD."voyage_id", OLD."trade_contract_id", OLD."instruction_id",
      OLD."revision_number", OLD."document_type", OLD."created_at") THEN
    RAISE EXCEPTION 'documents: what a document belongs to cannot change'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."current_version_number" NOT IN (OLD."current_version_number", OLD."current_version_number" + 1) THEN
    RAISE EXCEPTION 'documents: versions are numbered one after another'
      USING ERRCODE = 'restrict_violation';
  END IF;
  IF NEW."version" <> OLD."version" + 1 THEN
    RAISE EXCEPTION 'documents: every change advances the version by exactly one'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

-- By the time a transaction commits, a document's version is its uploads plus its reviews: a
-- version is never advanced without writing the file version or the review it stands for, and a
-- review is never written without advancing it. Checked at commit, when both rows are written,
-- from both tables' sides.
CREATE FUNCTION "documents_check_version"(document uuid) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE
  counts record;
BEGIN
  SELECT d."version", d."current_version_number",
         (SELECT count(*) FROM "document_reviews" AS r WHERE r."document_id" = d."id") AS "reviews"
  INTO counts
  FROM "documents" AS d WHERE d."id" = document;
  IF FOUND AND counts."version" <> counts."current_version_number" + counts."reviews" THEN
    RAISE EXCEPTION 'documents: version % of document % does not count its % uploads and % reviews',
      counts."version", document, counts."current_version_number", counts."reviews"
      USING ERRCODE = 'check_violation';
  END IF;
END;
$$;

CREATE FUNCTION "documents_require_counted_version"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "documents_check_version"(NEW."id");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "documents_require_counted_version"
AFTER INSERT OR UPDATE ON "documents"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "documents_require_counted_version"();

CREATE FUNCTION "document_reviews_require_counted_version"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  PERFORM "documents_check_version"(NEW."document_id");
  RETURN NULL;
END;
$$;

CREATE CONSTRAINT TRIGGER "document_reviews_require_counted_version"
AFTER INSERT ON "document_reviews"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION "document_reviews_require_counted_version"();

-- A rejection says why, within bounds; an approval carries no reason.
ALTER TABLE "document_reviews" ADD CONSTRAINT "document_reviews_reason" CHECK (
  ("decision" = 'APPROVED' AND "reason" IS NULL)
  OR ("decision" = 'REJECTED' AND "reason" IS NOT NULL
    AND char_length("reason") BETWEEN 1 AND 1000 AND "reason" ~ '\S')
);

-- Only the latest file version is reviewed, and only while its document's revision is the
-- instruction's current revision. (At most one review per file version is the unique index.)
-- Both rows are share-locked, in the order uploads lock them: the document cannot take a new
-- version, nor the instruction a new revision, until this transaction ends. A replacement or a
-- revision committed first is seen here, and refuses the review.
CREATE FUNCTION "document_reviews_require_current"() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE
  document record;
  current_revision integer;
BEGIN
  SELECT "instruction_id", "revision_number", "current_version_number" INTO document
  FROM "documents" WHERE "id" = NEW."document_id"
  FOR SHARE;
  IF document."current_version_number" IS DISTINCT FROM NEW."version_number" THEN
    RAISE EXCEPTION 'document_reviews: only the current version of a document can be reviewed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  SELECT "current_revision_number" INTO current_revision
  FROM "documentary_instructions" WHERE "id" = document."instruction_id"
  FOR SHARE;
  IF current_revision IS DISTINCT FROM document."revision_number" THEN
    RAISE EXCEPTION 'document_reviews: only documents of the current revision of an instruction can be reviewed'
      USING ERRCODE = 'restrict_violation';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER "document_reviews_current"
BEFORE INSERT ON "document_reviews"
FOR EACH ROW EXECUTE FUNCTION "document_reviews_require_current"();

-- Decisions are final for every writer: never edited, never reopened. (DELETE is not covered, as
-- for versions: the demo seed removes documents on its own voyages wholesale, which cascades.)
CREATE FUNCTION "document_reviews_refuse_update"() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'document_reviews: decisions are final'
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER "document_reviews_immutable"
BEFORE UPDATE ON "document_reviews"
FOR EACH ROW EXECUTE FUNCTION "document_reviews_refuse_update"();
