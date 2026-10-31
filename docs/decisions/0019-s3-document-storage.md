# ADR 0019: S3 document storage and paired recovery

Status: Accepted

## Context

The local adapter ties evidence to an API filesystem. The first persistent hosted environment
needs an independently provisioned private object store and a way to recover database rows and
the exact bytes together. The command, authorization and compensation rules of ADR 0013 remain.

## Decision

Select `local` (default) or `s3` explicitly through validated configuration. API and seed share
the factory. The SDK's credential chain supports workload roles; configuration contains no
embedded credentials. A custom production endpoint must use HTTPS. The application neither
creates buckets nor sets ACLs. Deployment owns private access, encryption, retention and backups.

`stage` streams into a new UUID object under `<prefix>objects/<uuid>`. The
[SDK managed upload](https://docs.aws.amazon.com/AWSJavaScriptSDK/v3/latest/Package/-aws-sdk-lib-storage/)
uses one 5 MiB part at a time and aborts known incomplete multipart uploads on failure. The
existing HTTP inspection still enforces PDF signature and the 10 MiB limit during reception.
`promote` returns that UUID: publication is the subsequent database transaction, not a rename
or copy. The object is never available anonymously or through a direct client URL.

On a failed upload the adapter tries to remove its known key, including a PUT or multipart
completion whose acknowledgement was lost. A failed cleanup is logged with the key. A process
crash can leave an object or an incomplete multipart upload: lifecycle expiration of incomplete
multipart uploads is required, and complete objects are reconciled with database references.
There is deliberately no automatic age-based deletion of complete objects.

After promotion, the command's existing compensation remains authoritative: certain rollback
removes bytes; unknown COMMIT outcome retains them. Command and audit event still share one
SQL transaction. Keys are opaque server-generated UUIDs, and reads remain behind counterparty
authorization and the recorded size/SHA-256 verification. SDK retries and per-request connection
and response timeouts are bounded; there is no new global HTTP-upload deadline in this change.

Maintenance tools inventory the object prefix and verify every stored file version. Export
includes only a reconciled database's referenced bytes and a manifest. Import requires an exact
manifest match to the restored database and an empty target prefix, and uses conditional creates.
The offline procedure stops all writers throughout the database dump and object export: a
database snapshot alone cannot freeze another storage system. See [recovery](../storage-recovery.md).

## Alternatives and consequences

- Staging prefix followed by copy/delete adds distributed operations and ambiguous results
  without improving API visibility. Logical promotion needs only one object write.
- Direct browser uploads would require a new completion protocol, access checks and limits.
  They are outside this change; the current bounded API stream is retained.
- Object storage is not a backup. Versioning, independently retained copies and operational
  restore credentials remain deployment responsibilities. The runbook provides an offline
  paired backup and restore, not an online point-in-time recovery service.
- Existing local files are not migrated automatically. Switching a populated environment's
  driver requires copying its referenced UUID objects and checking every size/hash first.
- Tests use a digest-pinned SeaweedFS S3 endpoint, with real credentials and real PostgreSQL.
  This proves that exercised protocol subset, not AWS IAM, KMS, TLS or a hosted provider.
- The local demo explicitly isolates storage environment variables and keeps the local adapter.
  One API instance and best-effort SSE are unchanged.
