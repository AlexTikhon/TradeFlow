-- ---------------------------------------------------------------------------
-- Hand-written invariants for document audit events. A separate migration because PostgreSQL does
-- not let a transaction use enum values it has just added (20261016120000_documents adds
-- DOCUMENT_VERSION_UPLOADED to audit_action).
-- ---------------------------------------------------------------------------

-- Upload events name their document, the version they produced and its checksum.
-- (IS NOT DISTINCT FROM, because a missing key yields NULL, and a CHECK that evaluates to NULL
-- passes.)
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_document_payload" CHECK (
  "action" <> 'DOCUMENT_VERSION_UPLOADED'
  OR (jsonb_typeof("payload" -> 'documentId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload" -> 'versionNumber') IS NOT DISTINCT FROM 'number'
    AND jsonb_typeof("payload" -> 'sha256') IS NOT DISTINCT FROM 'string')
);

-- Every version of a document is uploaded once. The last line of defence behind the conditional
-- writes.
CREATE UNIQUE INDEX "audit_events_one_document_version" ON "audit_events"(("payload" ->> 'documentId'), ("payload" ->> 'versionNumber')) WHERE "action" = 'DOCUMENT_VERSION_UPLOADED';
