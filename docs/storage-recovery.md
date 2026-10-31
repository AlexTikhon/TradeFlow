# Private document storage and paired recovery

The API supports `DOCUMENT_STORAGE_DRIVER=local` (default) and `s3`. See
[ADR 0019](decisions/0019-s3-document-storage.md). These commands require Node, installed
dependencies, generated Prisma client (`pnpm codegen`), and explicitly supplied environment
variables. The maintenance CLI does not read `.env` files.

## Configure S3

Set `DOCUMENT_STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, and optionally `S3_ENDPOINT`,
`S3_FORCE_PATH_STYLE=true`, and `S3_PREFIX` (default `tradeflow/`). Use the SDK credential chain:
workload credentials in hosting, or `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` and, when
applicable, `AWS_SESSION_TOKEN`. Omit endpoint for AWS S3. Custom production endpoints require
HTTPS. Supply bucket names and credentials server-side only.

Provision the bucket separately. Block public access and anonymous listing/reads, use bucket
owner enforced ownership (the adapter sends no ACL), encrypt storage, and restrict the API
identity to its prefix. It needs GetObject, PutObject, DeleteObject, AbortMultipartUpload and
ListMultipartUploadParts for uploads/downloads and compensation. The maintenance identity also
needs ListBucket restricted to the object prefix and ListBucketMultipartUploads to inspect
unfinished uploads. These are requirements to validate on the selected provider, not an IAM
policy deployed by this repository. Do not grant the API bucket creation or policy changes.

Enable bucket versioning/retention and independent backups according to the environment's data
requirements. Configure expiration of abandoned **incomplete multipart uploads**, not expiration
of complete document objects. With bucket versioning, a compensating delete can retain old
provider versions: manage their retention independently; do not remove referenced current bytes.

Existing local files are not copied by changing the driver. Keep the old storage configuration
until a separately rehearsed migration preserves every recorded UUID key, size and SHA-256.
There is no fallback to local disk when S3 is unavailable.

## Reconcile without deleting

With `DATABASE_URL` and the S3 environment explicitly set:

```powershell
pnpm --filter @tradeflow/api storage:objects verify
```

JSON output contains the version count, missing/checksum failures and unreferenced UUID keys.
A nonempty report exits with status 1. Authorization/outage errors fail the command rather than
being classified as missing data. Stop writers before relying on the inventory: a just-uploaded
object can still be waiting for its SQL COMMIT. Unknown COMMIT outcomes are retained on purpose.
Investigate against the authoritative database and provider logs before any manual deletion.
Inspect incomplete multipart uploads separately using the provider's tooling.

## Paired offline backup

1. Stop **all** API instances, seed commands and other database/object writers. Keep them stopped
   until both exports and checks are finished. Do not run the seed as part of backup/recovery.
2. Run `storage:objects verify`; resolve every unexplained mismatch/orphan and incomplete upload.
3. Create a new private backup directory outside the repository. On Windows, restrict its ACL to
   the backup operator (POSIX mode flags alone do not set Windows ACLs). Use PostgreSQL 18 client
   tools. With the source `DATABASE_URL` set, create the database half:

   ```powershell
   pg_dump --dbname=$env:DATABASE_URL --format=custom --no-owner --no-acl --file=C:\Backups\tf-001\database.dump
   pnpm --filter @tradeflow/api storage:objects export C:\Backups\tf-001\objects
   ```

   The object directory must not exist; export refuses to overwrite it. Each UUID file is checked
   against the DB's size/SHA-256. `manifest.json` is written last. A failed export is incomplete;
   keep writers stopped, discard that backup attempt explicitly, and start with a new directory.

4. Record SHA-256 of `database.dump` and the manifest in the backup record, along with the source
   commit, schema migration level and snapshot time. Encrypt the complete backup and retain an
   independently protected copy. Never commit it or upload it as CI diagnostics.
5. Resume writers after successful verification. The recovery point is this maintenance snapshot;
   later writes are not part of it. Measure recovery time during each real environment rehearsal.

This baseline trades downtime for cross-store consistency. Online backups/PITR require a
separate protocol coordinating database recovery points and object retention.

## Restore into an empty environment

1. Verify the backup record/digests. Create an **empty** PostgreSQL database and a private bucket
   or an empty dedicated prefix. Point `DATABASE_URL` and S3 variables at these targets. Keep
   API/seed writers stopped; never restore over the current environment.
2. Restore the database with PostgreSQL 18 tools. Do not use `--clean` or the seed:

   ```powershell
   pg_restore --dbname=$env:DATABASE_URL --exit-on-error --no-owner --no-acl C:\Backups\tf-001\database.dump
   pnpm --filter @tradeflow/api storage:objects import C:\Backups\tf-001\objects
   pnpm --filter @tradeflow/api storage:objects verify
   ```

   Import requires the manifest to match **every** restored document-version row and refuses a
   nonempty object prefix. It checks bytes against recorded size/SHA-256 and conditionally creates
   original UUID keys. A failed import can leave a partial target; inspect it, then recreate the
   isolated target explicitly before retrying. It never overwrites a current object.

3. Require no missing/corrupt files and no unexplained orphans. Start the matching application
   version against the restored targets; authenticate both counterparties and download historical
   and current versions through the API. Check the audit history as well as byte hashes. A restored
   DB includes sessions: apply the environment's session-revocation policy before exposing it.
4. Switch traffic only after that validation. Keep the original environment and backup until the
   recovery is accepted. RPO/RTO and cloud-provider restore coverage have not been established.

## Automated rehearsal

```powershell
pnpm test:storage
```

This owns fresh loopback-only PostgreSQL 18 and digest-pinned SeaweedFS 4.17 containers with
random credentials. It never uses development `.env`, `DATABASE_URL` or cloud accounts. It runs
real HTTP document uploads/downloads, multipart failures, competing writes, certain rollback,
unknown COMMIT, corruption/missing bytes, then `pg_dump` and object export, `pg_restore` into an
empty database and object import into a new bucket. Every restored version downloads through
the real API with its original hash; reconciliation must be clean. Containers and temporary
backups are removed on success/failure. Requires a running Docker daemon and image downloads.

CI has a separate `storage` job for this command. Hosted results for this change are pending.
On 2026-10-31 the uncommitted increment passed all 14 storage tests locally on Windows,
including the paired restore and API downloads. The full `pnpm check`, existing 14-test Chromium
suite and one-test demo walkthrough also passed ([verification record](mvp-status.md#local-s3-increment-verification-2026-10-31)).
This exercises an authenticated S3-compatible server; AWS IAM/KMS, actual provider durability,
HTTPS and scheduled/offsite backup execution require verification in the future hosted environment.
