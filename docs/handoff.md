# Handoff: picking TradeFlow up again

A practical note for whoever restarts work, written at the end of the planned implementation
(2026-10-28), updated for S3 storage on 2026-10-31. What was verified, where and on which commit is kept in one place:
[MVP status, at a glance](mvp-status.md#verification-at-a-glance). Read that first; this page
does not repeat its numbers.

## What the product does today

A shared workspace for the post-trade execution of one bulk commodity shipment, sold along a
chain of organizations. Signed-in users of seeded organizations can:

- list and open the voyages their organization takes part in, and create one (operators);
- set up a new voyage's trade string once (exporter's operators), which adds the named
  organizations as participants;
- issue and acknowledge ETA notices (seller to buyer, per contract);
- give, revise and acknowledge documentary instructions (buyer to seller, per contract);
- upload PDF document versions against an exact instruction revision, download them, and
  approve or reject (with a reason) the latest version;
- read a timeline of who did what, see notices, instructions, documents and the timeline update
  live, and work from an Action Center queue whose items open the exact record.

Organizations and users exist only through the seed. Scope and deliberate gaps:
[README](../README.md#status-original-mvp-complete), [MVP status](mvp-status.md#limitations).

## Boundaries that must hold

[Architecture](architecture.md) and the [ADRs](decisions/) have the detail. The ones a change is
most likely to break:

- **Shape.** One NestJS modular monolith (Prisma 7, PostgreSQL 18), one React SPA, one Zod
  contract in `packages/contracts` used by both and by the OpenAPI document.
- **Consistency.** Each command and its audit event commit in one transaction. Contended writes
  are single conditional statements with `ETag`/`If-Match` (412 when stale, 428 without a
  precondition). Revisions, file versions, decisions and audit events are immutable, enforced by
  the database. Document bytes are written outside the transaction and compensated on failure;
  bytes whose commit outcome is unknown are kept and logged, and removed by hand.
- **Privacy.** Access follows participation: a voyage you do not take part in answers the same
  404 as a missing one. Notices, instructions and documents are visible only to the contract's
  two counterparties. The timeline carries identifiers, never contents. Live-update signals carry
  only a change type, go only to current counterparties, and are re-checked before delivery.
  Sessions are opaque, hashed, `HttpOnly`, `SameSite=Strict` cookies.
- **Live updates are best effort.** In process, one API instance, no replay; REST is the source
  of truth, and pages refetch on every (re)connection and poll while disconnected.

## Prerequisites

Node.js ≥ 24.11 (`.nvmrc`: 24), pnpm 11.9.0 (`corepack enable` picks up the pinned version), a
running Docker daemon, and once per machine Playwright's Chromium:

```bash
pnpm install --frozen-lockfile
pnpm --filter @tradeflow/e2e exec playwright install chromium
```

## Commands

### Demo: temporary, nothing kept

```bash
pnpm demo           # fresh PostgreSQL container, migrations, seed, built apps on 127.0.0.1
pnpm demo:verify    # the same demo, driven through walkthrough 2 (F1 to F8) in Chromium
```

`pnpm demo` prints the address (a new port every run), the accounts (password `tradeflow-demo`)
and what it owns. It ignores `DATABASE_URL` and `.env` files. Details:
[Starting the demo](demo.md#starting-the-demo-pnpm-demo).

### Development: persistent

```bash
cp apps/api/.env.example apps/api/.env
pnpm db:up          # docker compose: PostgreSQL 18 on localhost:5433, volume tradeflow_postgres-data
pnpm db:migrate
pnpm db:seed        # re-running removes instructions and documents on the seeded voyages
pnpm dev            # API on :3000, web on :5173
```

**Check port 5433 first.** On the machine this was written on, `127.0.0.1:5433` belonged to
another project's PostgreSQL. `pnpm db:up` would fail to bind, and `apps/api/.env` would point
the API at that other server. Change the port in `docker-compose.yml` and `apps/api/.env` if
it is taken.

### Verification: against isolated PostgreSQL only

The test commands fall back to `localhost:5433` when their variables are unset. Never rely on
that: start a throwaway server and pass both URLs explicitly. The integration tests truncate
`TEST_DATABASE_URL` (its name must end in `_test`); the E2E run drops and recreates
`E2E_DATABASE_URL` (its name must end in `_e2e`).

```bash
# Git Bash on Windows: export MSYS_NO_PATHCONV=1 first, or --tmpfs gets a Windows path.
docker run --detach --name tradeflow-verify \
  --env POSTGRES_USER=tradeflow --env POSTGRES_PASSWORD=<password> \
  --env POSTGRES_DB=tradeflow_test --tmpfs /var/lib/postgresql \
  --publish 127.0.0.1::5432 postgres:18-alpine
docker port tradeflow-verify 5432/tcp           # prints 127.0.0.1:<port>

export TEST_DATABASE_URL=postgresql://tradeflow:<password>@127.0.0.1:<port>/tradeflow_test
export E2E_DATABASE_URL=postgresql://tradeflow:<password>@127.0.0.1:<port>/tradeflow_e2e

pnpm check          # CI's verify job: format, lint, typecheck, Vitest, build
pnpm test:e2e       # CI's e2e job: 14 Chromium tests
pnpm demo:verify    # CI's demo job; uses its own container, neither variable
git diff --check

docker rm --force --volumes tradeflow-verify
```

In PowerShell, set the variables with `$env:TEST_DATABASE_URL = '…'`. Wait for the server to
accept TCP connections (`docker exec tradeflow-verify pg_isready -h 127.0.0.1 -U tradeflow`)
before the first check. A local pass is not a CI pass: confirm the hosted run for the pushed commit.

## Temporary and persistent data

| Where                           | Lives in                                                                       | Kept?                                                              |
| ------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------------------ |
| `pnpm demo`, `pnpm demo:verify` | `tradeflow-demo-<random>` container (tmpfs) and temp directory                 | No: removed on stop, pass or fail                                  |
| `pnpm test:e2e`                 | `tradeflow_e2e` on `E2E_DATABASE_URL`; a temp directory for builds and uploads | Database dropped after the run; logs and reports in `e2e/.output/` |
| API integration tests           | `tradeflow_test` on `TEST_DATABASE_URL`                                        | Truncated by every run                                             |
| Development (`pnpm dev`)        | Volume `tradeflow_postgres-data`; uploads in `apps/api/var/documents`          | **Yes, and nothing backs it up**                                   |

`e2e/.output/` (ignored by Git) holds server logs, failure screenshots and reports; it may be
deleted at any time.

## Stopping safely, and recovery

- **Demo.** Ctrl+C, or `q` and Enter, in its terminal; it removes its container, directory and
  servers. If it was killed first, follow the commands its banner printed, or
  [the recovery steps](demo.md#starting-the-demo-pnpm-demo). Never stop `node` processes by
  name, and never use Windows PowerShell's `Remove-Item -Recurse` on the run's directory while
  its `api/node_modules` link exists.
- **Development.** Ctrl+C stops `pnpm dev`. `pnpm db:down` stops the database and keeps the
  volume; `docker compose down -v` deletes the development data, so use it only on purpose.
  Uploaded files in `apps/api/var/documents` belong with that database: delete or keep both.
- **Verification.** Remove the throwaway container by its name. An interrupted `pnpm test:e2e`
  can leave `tradeflow_e2e` behind; the next run drops and recreates it.

## Known operational limitations

- One API instance: the event bus and the sign-in admission limits are in process.
- Document bytes use the local disk by default, or opt-in private S3-compatible storage.
  [Paired backup, restore and reconciliation](storage-recovery.md) are explicit maintenance
  operations; no scheduled/offsite backup or cloud-provider recovery is configured. There is no
  virus scan; the PDF check is a signature check. Orphan removal remains manual.
- No hosted deployment. The [local AWS mock](deployment-mock.md) exercises production mode,
  HTTPS and `Secure`/`__Host-` cookies. It uses a private mock CA and local services, so AWS
  IAM/RDS, public DNS, ACME and cloud backups remain unverified. The regular demo still runs
  `NODE_ENV=development` over plain HTTP on loopback.
- Only seeded organizations and users, with a public demo password. No password reset, SSO or
  lockout. Seeded notice times are relative to the seed, so their states drift.
- Browser coverage is Chromium only, and no person has run any walkthrough
  ([records](demo.md#record-of-walkthrough-2)).
- CI's `verify`, `e2e` and `demo` jobs passed on `d00635f` on Linux
  ([run 40710589366](https://github.com/AlexTikhon/TradeFlow/actions/runs/40710589366)). Both
  failure-artifact uploads were skipped. The new `storage` job has no hosted result yet.

## Return-to-work checklist

1. `git status` and `git log --oneline origin/main..main`: note anything uncommitted or unpushed.
2. `gh run list --limit 5`: for the latest pushed commit, confirm `verify`, `e2e`, `demo`, `storage` and `deploy`
   all succeeded, then update [at a glance](mvp-status.md#verification-at-a-glance) with the run.
   If a job failed, its diagnostics artifact is kept for seven days.
3. `node --version`, `pnpm --version`, `docker version`: Node 24.11 or later, pnpm 11.9.0, a
   running daemon.
4. `pnpm install --frozen-lockfile`.
5. Run [verification](#verification-against-isolated-postgresql-only) against a throwaway
   server, then remove it. Also run `pnpm test:storage` and `pnpm deploy:verify`, which own
   their database/object servers and cleanup.
6. Before `pnpm db:up`, check who owns port 5433.
7. Re-read [Limitations](mvp-status.md#limitations) and the directions below before choosing
   work.

## Future directions

Not release blockers for the local demo. In order, each only when its trigger occurs.

1. **Durable document storage, with a tested recovery procedure.** The adapter, maintenance tools
   and isolated rehearsal are implemented in [ADR 0019](decisions/0019-s3-document-storage.md);
   hosted-provider verification remains. _Trigger:_ before the first
   hosted environment that holds data anyone would miss. _Done when:_ document bytes live in an
   S3-compatible object store behind the existing storage interface, with the private-access and
   compensation guarantees of [ADR 0013](decisions/0013-documents.md) unchanged; and a written
   backup-and-restore procedure for the database and the object store together has been
   rehearsed into an empty environment, after which every stored document version downloads
   with its recorded SHA-256 and the orphan check reports nothing unexplained.
2. **Durable delivery across API instances.** _Trigger:_ a requirement to run more than one API
   instance, or notifications that must not be lost. _Done when:_ events are written to an
   outbox in the command's transaction and relayed through a shared bus; a test with two API
   instances shows a command on one reaching streams on the other; and the stream's privacy
   rules (type-only signals, counterparties only, re-checked before delivery) still hold.
3. **AI document assistance.** _Trigger:_ a concrete user need, such as checking a bill of
   lading against its instructions, with examples to measure against. _Done when:_ an `ai`
   module produces proposals only; a person approves before any business record changes, and
   the approval is audited; results are measured on a labelled set of documents; and document
   contents go only where the counterparty-only rules allow.
