# Hosted deployment verification and recovery rehearsal

The operator runbook for roadmap step 9: deploy the [AWS foundation](aws-infrastructure.md) once,
verify it through its public HTTPS origin, restart the API between two checkpoints, and rehearse
the [paired recovery](storage-recovery.md) into separate empty targets. Record the results in
the [results template](hosted-verification-results.md).

> **Status, 2026-11-26.** Tooling, this runbook and a local rehearsal against the
> [deployment mock](deployment-mock.md) only. No AWS account, credential, image registry or DNS
> zone was used. No real `terraform plan`/`apply`/`destroy` ran, and the suite has never run
> against a remote environment. Every AWS command below is unrehearsed. **Step 9 stays pending
> until a real hosted run and a restore rehearsal in the account have passed.** Local evidence:
> [Local rehearsal](#local-rehearsal).

## What is verified, and what is not

| Concern                       | How                                                                                                                                                                                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Public TLS                    | Node and Chromium use the platform's public roots and normal hostname verification. No CA file, pin or `ignoreHTTPSErrors` exists on the hosted path. An IP address or `localhost` as `--origin` is refused.                                                            |
| Edge                          | HTTP answers 308 to the same path on HTTPS; the SPA, deep links, immutable hashed assets, Problem Details for unknown API paths                                                                                                                                         |
| Production cookies            | `__Host-tradeflow_session` is `Secure`, `HttpOnly`, `SameSite=Strict`, `Path=/`, host-only, unreadable from page script, and no unprefixed cookie exists                                                                                                                |
| Same origin                   | Every request the signed-in app makes stays on the origin. A signed-in cross-site write (`Sec-Fetch-Site: cross-site`) answers 403. A foreign `Origin` gets no CORS headers                                                                                             |
| Ordinary authentication       | Seller, buyer and outsider sign in through the form, each in a separate Chromium context, and sign out through the app. The signed-out cookie then answers 401                                                                                                          |
| Participation-based access    | Before the trade string exists, the buyer and outsider get the same 404 as for a missing voyage, and the event stream answers 404. Afterwards the outsider still gets 404 for the voyage's documents and the download; an anonymous download answers 401                |
| Request ids                   | A spoofed `X-Request-ID` is replaced with a fresh server id. The results record request ids (`api.request-id`, uploads, downloads) so the operator can find each one's record in the API log                                                                            |
| SSE                           | The web app's own `EventSource` is observed in the page (times and message types only). The buyer's instructions and the seller's upload arrive as stream messages at the counterparty. REST polling is never accepted as a substitute                                  |
| Document bytes                | A fictional, randomly padded PDF of about 6 MiB (above the 5 MiB multipart part size) is uploaded, then downloaded by both counterparties and hashed in the browser. Size, SHA-256 and `Repr-Digest` must all match                                                     |
| Restart                       | [Below](#restart): sessions, rows and bytes are unchanged, and both app streams drop and reconnect. A change made afterwards arrives over the reconnected stream                                                                                                        |
| Recovery                      | [Below](#recovery-rehearsal): reconciled paired backup, identity-guarded restore into separate empty targets, restored documents verified through the API                                                                                                               |
| **Not verified by the suite** | Server-side log contents (an operator step), IAM policy behavior beyond what the API exercises, RDS/S3 durability, multi-AZ failure, load, browsers other than Chromium, the portfolio write budget, ACME renewal. No availability or RPO/RTO guarantee follows from it |

The suite is repeatable. Each full run creates its own voyage (server-assigned reference),
contract, instruction revision, document and decision with the fixture accounts. It needs no
empty environment and resets nothing, and existing data is only read through the same API.
Each run adds about 6 MiB of document bytes and a handful of rows, which stay until someone
decides to remove them.

## Deployment gate: inputs still needed

Nothing below has been chosen. Provisioning cannot start without items 1–6.

1. **AWS account and operator role:** the account ID and the IAM identity (SSO role) that runs
   Terraform. Also a separate **maintenance identity** for recovery that has the prefix-scoped
   `s3:ListBucket`/`ListBucketMultipartUploads` the instance role deliberately lacks.
2. **Region.**
3. **Domain and DNS control:** the hostname, and who can create its A record pointing at the
   Elastic IP (ACME issuance needs it).
4. **Resource sizes and architecture:** `instance_type` and `instance_architecture`, and with them
   the image build platform and builder (arm64 needs emulation or an arm64 builder). Also
   `db_instance_class` and `db_allocated_storage_gib`.
5. **Budget:** a monthly ceiling and alert recipients ([cost worksheet](aws-cost-worksheet.md)).
   Also the extra cost of a rehearsal restore database, if one is used.
6. **Retention decisions:**
   - RDS backup retention (default 7 days);
   - document version retention (versioning keeps every version indefinitely by default);
   - registry image cleanup ([manual](aws-infrastructure.md#image-retention-and-cleanup));
   - the secret recovery window (30 days);
   - where the rehearsal backup is kept, how it is encrypted, and for how long;
   - when the restore database and prefix are deleted after acceptance;
   - whether the verification fixture accounts and their voyages stay after step 9.
7. Confirmation of the remaining Terraform defaults (`environment`, `document_prefix`, sizes) and
   that `PORTFOLIO_DEMO_WRITE_PROTECTION` stays unset for this step.

## Prerequisites, in order

Nothing below migrates, seeds or creates accounts automatically. Each step is an explicit
operator action.

1. **Infrastructure:** bootstrap and apply as in
   [AWS infrastructure, State](aws-infrastructure.md#state). Record `terraform output` (instance
   ID, `database_address`, bucket, prefix, secret ARNs, `image_platform`).
2. **Images:** build `api`, `web` and `tools` from the commit under test for `image_platform` and
   push them ([Images and architecture](aws-infrastructure.md#images-and-architecture)). Record
   the three digests. They go in the results.
3. **Database roles and secrets:** the one-time SQL and the two secret values
   ([Database TLS and roles](aws-infrastructure.md#database-tls-and-roles)).
4. **Migrations**, explicitly, with the tools digest
   ([Explicit operator operations](aws-infrastructure.md#explicit-operator-operations)). Record
   the latest migration name.
5. **Release:** write the release parameter, then restart both units
   ([Release](aws-infrastructure.md#release)). Create the DNS A record. Wait until Caddy has
   issued a publicly trusted certificate (`curl -sI https://<domain>/` with the system trust
   store succeeds).
6. **Controlled fixture preparation:** the three verification accounts and the reference data a
   voyage needs, through `scripts/verification-fixtures.ts` in the tools image (next section).
   **Never run `prisma/seed.ts` here.** It creates users with the published demo password.

### Verification fixtures

`verification-fixtures.ts` upserts three fictional organizations, one user in each, and one
vessel, one commodity and two ports. Reference rows are matched by IMO number, commodity code or
UN/LOCODE, so existing rows are reused. The users are `seller@verification.tradeflow.example`
and `buyer@verification.tradeflow.example` (operators) and
`outsider@verification.tradeflow.example` (viewer). Passwords arrive as JSON on standard input:
at least 16 characters, all different, never the demo password. They are never printed. The tool
refuses to write unless `--confirm-database` names exactly the `host:port/database` of its
`DATABASE_URL`. A rerun sets new passwords and revokes the accounts' earlier sessions. Nothing
else is touched.

On the instance, in an SSM session, with the operator's own credentials (unrehearsed):

```sh
umask 077
# A node-postgres URL for the migrator role (verify-full + the RDS CA, as check-database-url
# requires), written by hand from the migrator secret into a root-only tmpfs file:
sudo install -d -m 0700 /run/tradeflow
sudo tee /run/tradeflow/fixtures.env > /dev/null   # DATABASE_URL=postgresql://tradeflow_migrator:…@<database_address>:5432/tradeflow?sslmode=verify-full&sslrootcert=/etc/tradeflow/rds-ca.pem
# Generate the three passwords into a root-only file; keep them in the operator's password manager.
sudo sh -c 'printf "{\"seller\":\"%s\",\"buyer\":\"%s\",\"outsider\":\"%s\"}" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" "$(openssl rand -hex 24)" > /run/tradeflow/fixture-passwords.json'
sudo docker run --rm -i --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges=true \
  --env-file /run/tradeflow/fixtures.env --env DOCUMENT_STORAGE_DRIVER=local --env DOCUMENT_STORAGE_DIR=/tmp/unused \
  --mount type=bind,source=/etc/tradeflow/rds-ca.pem,target=/etc/tradeflow/rds-ca.pem,readonly \
  <registry>/tradeflow-portfolio/tools@sha256:<digest> \
  node --import tsx scripts/verification-fixtures.ts --confirm-database <database_address>:5432/tradeflow \
  < /run/tradeflow/fixture-passwords.json
sudo cat /run/tradeflow/fixture-passwords.json   # copy into the password manager, then:
sudo rm /run/tradeflow/fixtures.env /run/tradeflow/fixture-passwords.json
```

## Running the suite

From an operator workstation, never from the instance: Node 24.11+, pnpm 11.9.0, `pnpm install
--frozen-lockfile` and Playwright Chromium, on a checkout of the commit under test. Credentials
come only from the environment. Read them without echo, so they reach neither the shell
history nor a process listing:

```sh
for name in SELLER BUYER OUTSIDER; do
  read -r  -p "$name email: "    email;    export "TRADEFLOW_VERIFY_${name}_EMAIL=$email"
  read -rs -p "$name password: " password; export "TRADEFLOW_VERIFY_${name}_PASSWORD=$password"; echo
done
pnpm hosted:verify --origin https://<domain> --results ~/tradeflow-evidence/<date>-full.json
```

- `--origin` is required and must be `https://<DNS name>` with no path. There is no default
  target, and no fallback to localhost.
- A missing variable, an unknown argument or an existing `--results` file stops the run before
  anything is contacted (exit 2). A failed check stops the run (exit 1), and every later check is
  listed as `not-run`, never silently skipped.
- The results file is new (never overwritten). It holds statuses, timings, request ids, voyage
  and contract identifiers and the document's SHA-256. It never holds emails, passwords,
  cookies, document bytes, browser storage, traces or screenshots: the browsers keep nothing on
  disk and are closed at the end.
- At `CHECKPOINT before-restart: passed`, the suite waits up to `--restart-timeout` minutes
  (default 15) for a line on its standard input: `restarted` or `abort`.
- `unset` the six variables afterwards.

Repeat with `--mode restored --expect <full results>` only during the
[recovery rehearsal](#recovery-rehearsal).

## Restart

The suite never restarts anything. At the checkpoint it has recorded the sessions, the voyage,
instructions, document metadata, timeline and both app streams. The operator then restarts
exactly the API service on exactly this environment's instance, in a second terminal:

```sh
aws sts get-caller-identity                       # the intended account and operator role
aws ssm start-session --region <region> --target <instance_id from terraform output>
# on the instance:
sudo systemctl show tradeflow-api -p MainPID -p ActiveEnterTimestamp
sudo docker ps --filter name='^/tradeflow-api$' --format '{{.ID}} {{.Status}}'   # exactly one
sudo systemctl restart tradeflow-api
sudo systemctl is-active tradeflow-api
sudo docker ps --filter name='^/tradeflow-api$' --format '{{.ID}} {{.Status}}'   # exactly one, new ID
```

`systemctl restart` stops the container (`docker stop --time 20`) before the unit starts a new
one, so there is never a second API process. Do not use `docker restart` (systemd owns the
container), `systemctl restart docker` (it also restarts the edge), or a reboot or instance
replacement (different tests). Once the new container is ready (`docker ps` shows it up and
`https://<domain>/api/health` answers 200), type `restarted` in the suite's terminal. The suite
then requires:

- both app streams dropped after the checkpoint and received a new `READY`;
- all three session cookies unchanged and still accepted, and a reload still signed in;
- the voyage, instructions, document metadata and timeline identical to the checkpoint;
- the document downloading with the same SHA-256;
- the buyer's approval, made after the restart, arriving at the seller over the reconnected
  stream.

If no stream drop was observed, the check fails: the API probably was not restarted.

Correlate one request id from the results with the API's own record:
`sudo docker logs tradeflow-api 2>&1 | grep <requestId>`. The record shows the route template,
status and outcome, never a URL, header or body. The container log restarts with the container,
so check ids from after the restart, or use `journalctl -u tradeflow-api`.

## Recovery rehearsal

The [paired offline procedure](storage-recovery.md) with the existing tools: `pg_dump`/`pg_restore`
(PostgreSQL 18 client) and `storage:objects verify | export | restore-check | import` from the
tools image. It runs in one maintenance window, during which the public site serves either
nothing (API stopped) or the restored copy. Unrehearsed on AWS. Record every time in UTC.

**Identities.** Before the first write, write down and compare: `aws sts get-caller-identity`
(account and maintenance role); `terraform output` (`instance_id`, `database_address`,
`documents_bucket`, `document_prefix`); the source database `tradeflow`. The restore targets are
a **new empty database** `tradeflow_restore_<yyyymmdd>` (same RDS instance, or a separate one if
the budget allows) and a **new empty prefix** `tradeflow/restore-<yyyymmdd>/` in the document
bucket. A sibling under `tradeflow/` is a separate object key space (`tradeflow/restore-…/objects/`
versus `tradeflow/objects/`), so the instance role, scoped to `tradeflow/*`, can read it for
the API check. Never restore into `tradeflow` or into `tradeflow/` itself. The tools refuse
both.

**Maintenance environment files.** Root-only, on tmpfs:

- `/run/tradeflow/source.env` and `/run/tradeflow/restore.env`: `DATABASE_URL` (migrator role,
  node-postgres form as above, database `tradeflow` or the restore database),
  `DOCUMENT_STORAGE_DRIVER=s3`, `S3_BUCKET`, `S3_REGION`, `S3_PREFIX` (`tradeflow/` or the
  restore prefix), and the maintenance identity's temporary credentials
  (`aws configure export-credentials --format env-no-export`). The IMDS guard keeps the tools
  container from using the instance role.
- `/run/tradeflow/pg-source.env` and `/run/tradeflow/pg-restore.env`: libpq variables for the
  same roles (`PGHOST`, `PGPORT=5432`, `PGDATABASE`, `PGUSER=tradeflow_migrator`, `PGPASSWORD`,
  `PGSSLMODE=verify-full`, `PGSSLROOTCERT=/etc/tradeflow/rds-ca.pem`).

`tools` below stands for
`sudo docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges=true --mount type=bind,source=/etc/tradeflow/rds-ca.pem,target=/etc/tradeflow/rds-ca.pem,readonly`,
followed by an `--env-file` and the tools image by digest. `pg` stands for the same with
`postgres:18` and a `pg-*.env` file.

| #   | Step                   | Command (on the instance)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Record                                    |
| --- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- |
| 1   | Stop writers           | `sudo systemctl stop tradeflow-api`. Then `docker ps` shows no `tradeflow-api`. No seed, migration or fixture command may run until step 14                                                                                                                                                                                                                                                                                                                                                                                        | writers stopped at                        |
| 2   | Reconcile source       | `tools --env-file /run/tradeflow/source.env <tools> node --import tsx scripts/document-objects.ts verify`. It must print `"problems": [], "orphans": []`. An unexplained orphan or incomplete multipart upload stops the rehearsal                                                                                                                                                                                                                                                                                                 | report                                    |
| 3   | Backup directory       | `sudo install -d -o 1000 -g 1000 -m 0700 /var/lib/tradeflow-backups/<id>`                                                                                                                                                                                                                                                                                                                                                                                                                                                          | backup id                                 |
| 4   | Export database        | `pg --env-file /run/tradeflow/pg-source.env postgres:18 pg_dump --format=custom --no-owner --no-acl > /var/lib/tradeflow-backups/<id>/database.dump` (as root)                                                                                                                                                                                                                                                                                                                                                                     | start/end                                 |
| 5   | Export objects         | `tools --env-file /run/tradeflow/source.env --mount type=bind,source=/var/lib/tradeflow-backups/<id>,target=/backup <tools> node --import tsx scripts/document-objects.ts export /backup/objects`. It writes `source.json` (source identity and recovery point) before `manifest.json`                                                                                                                                                                                                                                             | start/end                                 |
| 6   | Checksums              | `sha256sum database.dump objects/manifest.json objects/source.json`                                                                                                                                                                                                                                                                                                                                                                                                                                                                | three digests                             |
| 7   | Recovery point         | `jq .recoveryPoint objects/source.json`: the latest audit event time, the audit event and document version counts, and the latest migration. **This is the actual recovery point**, not the clock time                                                                                                                                                                                                                                                                                                                             | recovery point                            |
| 8   | Create targets         | As `tradeflow_admin`: `CREATE DATABASE tradeflow_restore_<yyyymmdd>`, then the per-database part of the [role SQL](aws-infrastructure.md#database-tls-and-roles) in it (`REVOKE … FROM PUBLIC`, `GRANT CONNECT`, schema owner, default privileges). Default privileges are per database. The restore prefix needs no creation, but must be empty                                                                                                                                                                                   | restore started at                        |
| 9   | Guards                 | `restore-check /backup/objects` with `source.env` **must refuse** (source database, not empty, overlapping objects). With `restore.env` it must print `"refusals": []`. Compare both identities it prints with the ones written down                                                                                                                                                                                                                                                                                               | both outputs                              |
| 10  | Restore database       | `pg --env-file /run/tradeflow/pg-restore.env -i postgres:18 pg_restore --dbname="$PGDATABASE" --exit-on-error --no-owner --no-acl < database.dump`. Never `--clean`, never the seed                                                                                                                                                                                                                                                                                                                                                | end                                       |
| 11  | Import objects         | `tools --env-file /run/tradeflow/restore.env --mount …,target=/backup,readonly <tools> … import /backup/objects`. It refuses the source prefix and database, a manifest or recovery point that differs from the restored database, a non-empty prefix, and any file that fails its checksum, all before the first write                                                                                                                                                                                                            | end                                       |
| 12  | Reconcile restored     | `verify` with `restore.env`: no problems, no orphans                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | report                                    |
| 13  | API on restored stores | With the unit still stopped, start **one** API container exactly like `/usr/local/libexec/tradeflow/run api`, with the same name, address and alias, plus `--env-file /run/tradeflow/api-restore.env` (the app role's URL for the restore database, checked with `check-database-url`) and `--env S3_PREFIX=tradeflow/restore-<yyyymmdd>/` after `/etc/tradeflow/api.env`, and `--detach`. Then, from the workstation: `pnpm hosted:verify --origin https://<domain> --mode restored --expect <full results> --results <new file>` | restore verified at; **elapsed = 13 − 8** |
| 14  | Return                 | `sudo docker stop tradeflow-api`, then `sudo systemctl start tradeflow-api` (the source stores), `https://<domain>/api/health` 200, and a sign-in. Keep the source environment and the backup until the rehearsal is accepted. Remove the restore database and prefix only by an explicit later decision                                                                                                                                                                                                                           | writers resumed at                        |

The restored database contains the source's sessions, so cookies from before the backup are
valid against it. The window keeps the public site on that copy only briefly. A real
recovery would apply the environment's session-revocation policy before opening it.

**What the timing means.** Record the measured restore time (step 8 to the restored-mode pass),
the writer downtime (1 to 14) and the recovery point (step 7). They describe this rehearsal, at
this data size, done by hand. They are not an RTO, an RPO or an availability commitment, and
none has been established. RDS automated backups and point-in-time restore exist, but this
procedure does not use them, and they cannot be paired with S3 objects at a chosen instant
([ADR 0019](decisions/0019-s3-document-storage.md)).

## Local rehearsal

```powershell
pnpm hosted:rehearse-mock                         # prints a non-secret evidence summary
pnpm hosted:rehearse-mock --evidence <new-file>   # also writes it
```

`e2e/hosted/mock-rehearsal.ts` performs the runbook against a disposable
[deployment mock](deployment-mock.md), with local substitutes:

1. The mock starts **without the demo seed**: migrations only. The fixture tool creates the
   three accounts with random passwords. Its refusal of an unconfirmed target is checked, and
   the database is checked to hold exactly those three users.
2. The suite runs as a separate process, exactly as above. The only difference is
   `--local-mock-trust`, a file holding this run's CA, its CA-verified leaf key and the HTTP
   port. It is accepted only for `https://localhost:<port>`, and the hosted path never reads
   one. At the checkpoint the rehearsal restarts this run's one API container, found by its
   Compose labels (`docker restart`, the mock's equivalent of the systemd unit). It checks that
   the same single container is running and ready, then answers `restarted`.
3. Recovery uses the steps above. The API is stopped, then reconciled. `pg_dump` runs in the
   database container, and the object export runs in the tools image, which writes
   `source.json`. Checksums are recorded. Then come a new empty database and bucket,
   `restore-check` refusing the source and accepting the targets, `pg_restore`, the import, and
   reconciliation. The one API is recreated against the restored stores
   (`MOCK_DATABASE_NAME`/`MOCK_S3_BUCKET`) and the suite runs in restored mode.
4. Everything is in the run's random Compose project and temporary directories, and is removed
   at the end. On failure, the [mock's sanitized diagnostics](deployment-mock.md#failure-diagnostics)
   are kept first.

The mock proves the tooling and the sequence. It does not prove ACME or public certificates,
AWS IAM/IMDS, RDS TLS or roles, S3 behavior, systemd or the instance's timing. The restore time
it prints is a laptop measurement, not an AWS one.

## Verification record, 2026-11-26

Local evidence on the working tree committed after `e2f9063`, on Windows 11 with Docker Desktop
29.9.3 (WSL2 backend), Node 24.11.1, pnpm 11.9.0 and Playwright 1.63.0 (Chromium). **No AWS
verification was performed.** No account, credential, registry, DNS zone or remote environment
was used.

| Check                                | Result                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm hosted:rehearse-mock`          | Passed on the first run, about 4 minutes including image builds. The mock started without the demo seed. The fixture tool refused an unconfirmed target, then created exactly three users                                                                                                                                                                                                           |
| Hosted suite, full run (local trust) | 22 of 22 checks passed. The upload was 6,292,267 bytes, and both counterparties' downloads matched its SHA-256 and `Repr-Digest`. The instruction and upload messages arrived on the app's streams 342 ms and 1,268 ms after each action                                                                                                                                                            |
| Restart (outside the suite)          | `docker restart` of the run's one API container, `15693c7824a6`, found by its Compose labels. It answered through the edge after 4.5 s, and the same single container was running afterwards. Both app streams dropped about 0.65 s after the checkpoint and received `READY` 5.1 s later. Sessions, rows and bytes were unchanged, and the approval made after the restart arrived over the stream |
| Paired backup                        | The API was stopped (writers stopped at 14:26:56Z). The source reconcile found 1 version, no problems and no orphans. Then `pg_dump` and the object export ran. The recovery point in `source.json`: latest audit event 14:26:55.264Z, 5 audit events, 1 document version, migration `20261125100000_demo_write_budget`. Checksums of the dump, the manifest and `source.json` were recorded        |
| Guards                               | `restore-check` on the source refused with all four reasons: source database, not empty, overlapping objects, prefix not empty. On the new database and bucket it printed `"refusals": []`                                                                                                                                                                                                          |
| Restore                              | `pg_restore` into `tradeflow_restore` and the import into `tradeflow-restore` succeeded, and the restored reconcile was clean. The one API was recreated on the restored stores. Restored mode passed 8 of 8 checks: the voyage, both downloads by SHA-256, the review decision, the timeline and the outsider's 404                                                                                |
| Measured restore time                | 25.4 s from creating the targets to the restored-mode pass (one 6 MiB document, local Docker). A laptop measurement of this procedure, not an AWS figure, an RTO or an availability guarantee                                                                                                                                                                                                       |
| Cleanup                              | Containers, volumes, networks and image tags were identical to the pre-run snapshot, and no rehearsal temporary directory remained. The log and the evidence summary hold no password, cookie, key or account email                                                                                                                                                                                 |
| `pnpm test:storage`                  | Passed, 14 tests. The paired restore test now also covers `source.json`, `restore-check` refusals and acceptance, and import refusing the source                                                                                                                                                                                                                                                    |
| `pnpm deploy:verify`                 | Passed: 1 test, 8 steps, no retries, with the refactored TLS pin, the optional seed and the compose defaults. Docker state was identical afterwards                                                                                                                                                                                                                                                 |
| Unit tests, static checks            | The `e2e` input tests passed 7 of 7 (`node --test`). `pnpm lint`, `pnpm typecheck`, `pnpm format:check` and `git diff --check` passed. Without a target or credentials, the CLI exits 2 before any request                                                                                                                                                                                          |
| **Not performed**                    | Anything on AWS: provisioning, image publishing, DNS/ACME, the suite against a public origin, the `systemctl` restart, the RDS/S3 recovery rehearsal, and every command in [Recovery rehearsal](#recovery-rehearsal). Also not run: the rehearsal on a Linux host (its `--user` branch for the tools container), the full `pnpm check`, and hosted CI                                               |
