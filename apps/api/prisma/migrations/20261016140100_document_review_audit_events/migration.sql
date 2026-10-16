-- ---------------------------------------------------------------------------
-- Hand-written invariants for document review audit events. A separate migration because
-- PostgreSQL does not let a transaction use enum values it has just added
-- (20261016140000_document_reviews adds DOCUMENT_VERSION_REVIEWED to audit_action).
-- ---------------------------------------------------------------------------

-- Review events name their document, the file version decided on, the document version the
-- review produced, and the decision. (IS NOT DISTINCT FROM and COALESCE, because a missing key
-- yields NULL, and a CHECK that evaluates to NULL passes.)
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_document_review_payload" CHECK (
  "action" <> 'DOCUMENT_VERSION_REVIEWED'
  OR (jsonb_typeof("payload" -> 'documentId') IS NOT DISTINCT FROM 'string'
    AND jsonb_typeof("payload" -> 'versionNumber') IS NOT DISTINCT FROM 'number'
    AND jsonb_typeof("payload" -> 'version') IS NOT DISTINCT FROM 'number'
    AND COALESCE("payload" ->> 'decision' IN ('APPROVED', 'REJECTED'), false))
);

-- Every file version is decided at most once, and every version of a document is produced by
-- exactly one change, an upload or a review. The last line of defence behind the conditional
-- writes. (Upload events recorded before this migration carry no version; NULLs never collide.)
CREATE UNIQUE INDEX "audit_events_one_document_review" ON "audit_events"(("payload" ->> 'documentId'), ("payload" ->> 'versionNumber')) WHERE "action" = 'DOCUMENT_VERSION_REVIEWED';
CREATE UNIQUE INDEX "audit_events_one_document_change" ON "audit_events"(("payload" ->> 'documentId'), ("payload" ->> 'version')) WHERE "action" IN ('DOCUMENT_VERSION_UPLOADED', 'DOCUMENT_VERSION_REVIEWED');
