# Architecture

This document describes how TradeFlow is built today and how it is meant to grow. Decisions with
meaningful alternatives are recorded as ADRs in [decisions/](decisions/).

## System context

```
 Browser ──▶ Web SPA (Vite build, static files)
                │ fetch /api/*  (same origin; Vite proxies in development)
                ▼
            API (NestJS, single process) ──▶ PostgreSQL 18
                │
                └──▶ document storage (a private directory on the API's filesystem)
```

There is one deployable backend, one database and one static frontend. Uploaded document bytes
live in a private directory beside the API, behind a storage interface
([ADR 0013](decisions/0013-documents.md)). Nothing else is needed for the current scope: no cache,
no queue and no object store. Each of those arrives with the feature that needs it (see
[Evolution](#evolution)).

## Monorepo

pnpm workspaces, three packages ([ADR 0002](decisions/0002-pnpm-monorepo.md)):

| Package              | Role                                                          |
| -------------------- | ------------------------------------------------------------- |
| `packages/contracts` | The HTTP contract: Zod schemas plus inferred TypeScript types |
| `apps/api`           | NestJS API, Prisma schema, migrations, seed                   |
| `apps/web`           | React SPA                                                     |

The dependency direction is strict: `api → contracts ← web`. The apps never import from each
other. `contracts` contains no domain logic, only the shape of the wire format.

**Build order.** `contracts` is compiled to `dist/` (ESM) and consumed like any package. The root
scripts run `pnpm codegen` first (build contracts, generate the Prisma client), so `typecheck`,
`lint`, `test` and `dev` work from a clean checkout.

**Module system.** Everything is ESM. NestJS 12 itself ships as ESM; the API compiles with
`module: NodeNext` and uses explicit `.js` import suffixes.

## Backend (apps/api)

```
src/
  main.ts                       bootstrap (loads .env in development only)
  app.module.ts                 composes modules
  app.setup.ts                  HTTP pipeline, shared by main.ts and integration tests
  config/app-config.ts          environment schema (Zod), fail fast on boot
  infrastructure/prisma/        PrismaService (driver adapter: node-postgres)
  infrastructure/storage/       DocumentStorage (stage, promote, discard, read, remove) and its
                                local-filesystem implementation (ADR 0013)
  common/http/                  ProblemDetailsFilter, ZodValidationPipe, OpenAPI wiring;
                                multipart-file.ts (one streamed file, limits enforced while it
                                arrives), content-disposition.ts (attachment headers)
  health/                       GET /api/health (readiness: DB answers SELECT 1)
  modules/
    auth/
      auth.controller.ts        sign-in, me, sign-out
      auth.service.ts           credential check, session create / validate / revoke
      auth.guard.ts             global default-deny guard; attaches the Principal
      same-origin.guard.ts      refuses cross-site unsafe requests (Fetch Metadata)
      auth.decorators.ts        @Public(), @CurrentPrincipal(), @ApiSessionAuth()
      session-cookie.ts         cookie name, attributes, parsing
      password.ts               argon2id hashing (PHC strings)
      session-token.ts          random tokens and their SHA-256 digests
      user-permissions.ts       requireOperator(principal, action): the role check (ADR 0008)
      session-principals.ts     SessionPrincipals.refresh: the session's principal read again,
                                for commands that commit long after the request arrived
    audit/
      audit-trail.ts            AuditTrail.record(tx, event): append-only, same transaction
    reference-data/
      reference-data.*.ts       GET /vessels, /commodities, /ports; id existence checks
    voyages/
      voyages.controller.ts     HTTP only: parse input, call service, map "missing" to 404
      voyages.service.ts        use cases (list, get, create), each taking the Principal
      voyage-access.ts          accessibleVoyages(principal): the one visibility predicate
      voyage-reference.ts       takeNextVoyageReference(tx): per-year counter, row-locked
      voyage.read-model.ts      Prisma select shapes + row → contract mapping
      trade-string.ts           domain rules for a linear trade string (pure functions)
      trade-string.read-model.ts  allowlisted select + stored contracts → topology
      trade-string.service.ts   findForVoyage(principal, id): one query, access predicate inside
      trade-string.controller.ts  GET /voyages/:voyageId/trade-string
      counterparty-contracts.ts   CounterpartyContracts: a contract as its seller or buyer sees
                                  it; exported, the only way other modules resolve a contract
      counterparty-contracts.controller.ts  GET /voyages/:voyageId/my-contracts
    notices/
      notice-rules.ts           deadline rules, overdue and lateness (pure functions)
      notice.read-model.ts      allowlisted select + row → contract mapping, overdue derived
      notices.service.ts        list, get, issue, acknowledge; role and side checked here
      notices.controller.ts     /voyages/:voyageId/notices[/:noticeId[/acknowledgement]]
    documentary-instructions/
      instruction-rules.ts      MVP content rules: what counts as an unchanged revision (pure)
      instruction.read-model.ts allowlisted select (all revisions, acknowledgements) + mapping
      instruction.writes.ts     the three conditional SQL statements that decide every write
      documentary-instructions.service.ts     list, get, put (create or revise), acknowledge
      documentary-instructions.controller.ts  preconditions (If-Match / If-None-Match), ETag
      instruction-revisions.ts  InstructionRevisions: the current revision and what a revision
                                requires; exported, share-locks the instruction for a commit
    documents/
      document-rules.ts         PDF signature, display file names, UploadInspection (size, hash)
      document.read-model.ts    allowlisted select (every version, never the storage key)
      document.writes.ts        the two conditional SQL statements that decide every version
      documents.service.ts      list, upload (check, receive, keep, commit, compensate), download
      documents.controller.ts   multipart upload, preconditions, ETag, attachment download
  common/http/preconditions.ts  If-Match / If-None-Match parsing, 428 (no comparison: the DB does it)
```

The trade string lives in the `voyages` module rather than a module of its own: its contracts
reference voyage participants by composite key, and reading it goes through
`accessibleVoyages`, which the module owns. It can move out once it has its own commands.

Notices are a module of their own: they have commands, their own table and their own visibility
rule ([ADR 0011](decisions/0011-counterparty-notices.md)). They reach contracts only through
`CounterpartyContracts`, which the voyages module exports. Documentary instructions follow the
same pattern in their own module ([ADR 0012](decisions/0012-documentary-instructions.md)): the
same visibility rule through the same provider, three tables of their own, and conditional
writes. Documents are the next module ([ADR 0013](decisions/0013-documents.md)): two tables and
the stored bytes of their own, the same visibility rule, and the instruction revisions they answer
read only through what the documentary-instructions module exports.

### Module boundaries

Each domain module owns its controller, services and persistence access. Rules that keep
extraction possible later:

- A module talks to another module only through that module's exported providers, never by
  querying the other module's tables directly. `voyages` imports `ReferenceDataService` (to check
  that the ids in a request exist) and `AuditTrail` (to record what it did); it never touches
  `audit_events` itself. `notices` and `documentary-instructions` import `CounterpartyContracts`
  (to resolve the reader's contracts, with the access rule inside the query) and `AuditTrail`;
  neither queries `trade_contracts` or `voyage_participants`. `documents` imports
  `CounterpartyContracts`, the documentary-instructions module's `InstructionRevisions` (which
  revision is current and what it requires; it never reads `documentary_instructions`), the auth
  module's `SessionPrincipals`, `AuditTrail` and `DocumentStorage`. Its read model reads the actors' names and
  organizations through the notice's own actor relations, as the voyage read model reads its
  participants' organizations. Its read model still joins vessel, commodity and port rows through
  relations, because those columns are part of what a voyage is.
- Shared code lives in `common/` (HTTP plumbing) or `infrastructure/` (technical adapters) and holds
  no domain rules.
- **No generic repository layer.** Prisma already is a typed data-access layer; wrapping it in
  `Repository<T>` would add indirection without isolating anything. Each module keeps its queries
  close to its use cases. The `*.read-model.ts` file plays that role for reads: it declares
  exactly which columns a query loads, so new columns are never exposed by accident.

The `auth` module owns identity: it reads `users` (with their organization and role) and owns
`sessions`. Other modules depend only on what it exports: the `Principal` type, the
`@CurrentPrincipal()` / `@Public()` decorators and `requireOperator`. There is still no
`organizations` module, because nothing manages organizations on their own yet. `audit` owns
`audit_events`; `reference-data` owns vessels, commodities and ports; `notices` owns `notices`;
`documentary-instructions` owns `documentary_instructions` and their revisions and
acknowledgements; `documents` owns `documents`, `document_versions` and the bytes in document
storage.

### Request pipeline

1. **Guards** ([ADR 0007](decisions/0007-cookie-sessions.md)). `SameOriginGuard` refuses unsafe
   methods that the browser marks as cross-site (403). `AuthGuard` then resolves the session
   cookie into a `Principal { sessionId, userId, organizationId }`, or answers 401, unless the
   route is `@Public()`. Guards run before pipes, so an unauthenticated caller gets 401 even for
   malformed input. The organization always comes from the database, never from the request.
2. **Validation.** `ZodValidationPipe` parses params, query and body with contract schemas. A
   failure becomes a `RequestValidationException` that carries field paths such as `query.status`
   or `param.voyageId`.
3. **Use case.** The controller delegates to a service, passing the principal. Controllers hold no
   business logic; mapping "not found" to HTTP 404 is the controller's job because it is an HTTP
   concern. Authorization is not a controller concern: voyage services `AND` the
   `accessibleVoyages(principal)` predicate into every query
   ([ADR 0006](decisions/0006-participation-based-access.md)), so "not yours" and "does not
   exist" are the same empty result and the same 404. Commands also check the user's role first
   thing in the service (`requireOperator`, [ADR 0008](decisions/0008-user-roles.md)), which
   answers 403. The role comes from the principal, read from the user row for this request.
4. **Errors.** `ProblemDetailsFilter` turns every exception into RFC 9457 Problem Details:

   ```json
   {
     "type": "/problems/validation-failed",
     "title": "Request validation failed",
     "status": 400,
     "detail": "The request is invalid.",
     "instance": "/api/voyages?status=SAILING",
     "errors": [{ "path": "query.status", "message": "Invalid option: ..." }]
   }
   ```

   Errors with status 5xx are logged with their stack trace and returned with a generic `detail`,
   so internals never leak. An integration test asserts this. An error can be answered before
   the request's body was read (an upload refused by a guard, or by its service before receiving
   the file); Node would then reset the connection under a client still sending, so the filter
   first reads and discards the rest of the body, up to 16 MiB (`unread-body.ts`), and closes the
   connection after the answer beyond that.

5. **Caching.** Every `/api` response carries `Cache-Control: no-store`: responses depend on who
   is signed in, so no browser or proxy may keep them. Express's automatic `ETag` (a body hash)
   is switched off: entity tags appear only where writes are conditional, and mean an aggregate
   version ([ADR 0012](decisions/0012-documentary-instructions.md)).

### OpenAPI

Nest's Swagger module discovers routes from controller metadata. Schemas are **not** written as
decorator DTOs: they are generated from the Zod contract registry (`z.toJSONSchema`,
OpenAPI 3.0 target) and merged into `components.schemas`. A test asserts that every `$ref`
resolves. The session cookie is declared as the `session` security scheme, and protected
operations reference it through `@ApiSessionAuth()`. Docs are served at `/api/docs`, JSON at
`/api/docs/openapi.json`.

### Persistence

PostgreSQL 18 with Prisma 7 and the `node-postgres` driver adapter
([ADR 0004](decisions/0004-postgresql-and-prisma.md)). Conventions:

- `snake_case` tables and columns (`@@map` / `@map`), so the schema is pleasant in raw SQL.
- Primary keys are **UUIDv7, generated by Postgres** (`uuidv7()`). They are time-ordered, so they
  index well, and the database generates them for every writer, not only Prisma.
- `timestamptz` for instants, `date` for calendar dates (laycan), `DECIMAL(14,3)` for quantities.
- **Invariants the database must guarantee are CHECK constraints**, added by hand to the migration
  because Prisma's schema language cannot express them: positive quantity, ordered laycan, distinct
  load and discharge ports, IMO / UN/LOCODE / country-code formats, lowercase emails.
- Foreign keys use `RESTRICT` except voyage → participants and voyage → trade contracts
  (`CASCADE`), so reference data cannot be deleted out from under a voyage, and audited rows cannot
  be deleted from under their events.
- **Composite foreign keys keep children inside their voyage.** A trade contract references its
  seller and buyer as `(voyage_id, participant_id)` → `voyage_participants(voyage_id, id)`, so a
  contract cannot name a participant of another voyage, whoever writes it. Those keys are
  `NO ACTION` (checked at the end of the statement): a voyage deletion cascades to participants
  and contracts together, while deleting a participant a contract names is refused.
- `audit_events` is append-only for every writer: a trigger refuses `UPDATE` and `DELETE`.
- A notice references its contract as `(voyage_id, trade_contract_id)` →
  `trade_contracts(voyage_id, id)`, so it cannot name another voyage's contract. A trigger keeps
  issued content immutable and an acknowledged notice unchangeable, for every writer.
- Instants that business rules compare (`issued_at`, `acknowledged_at`) are set by the API from
  one clock reading per command, so the CHECK constraints between them hold.
- Documentary instructions: one per contract (unique), inside the contract's voyage (composite
  key). Triggers keep revisions and acknowledgements immutable, accept them only for the current
  revision, and let the aggregate change only by advancing its version by one; a deferred
  constraint trigger requires the current revision to exist at commit. A CHECK validates the
  requirements JSON through an immutable function.
- Documents: one per (contract, revision, document type), pinned by composite keys to their
  contract's voyage, to the instruction under that contract and to an existing revision (none
  cascades). Triggers accept a document and each new version only for the instruction's current
  revision and a type it requires, share-locking the instruction; versions are numbered without
  gaps and never updated; a deferred constraint trigger requires the current version at commit.
  CHECKs hold the storage-key format (a UUID), the file name (display text: no separators or
  control characters), `application/pdf`, 1 byte to 10 MiB and a 32-byte SHA-256.

### Reads scoped below the voyage: the trade string

`GET /api/voyages/:voyageId/trade-string` is the first read of a voyage child:

1. Guards and the UUID parameter check, as for the voyage itself.
2. **One query** loads the voyage by id `AND accessibleVoyages(principal)`, selecting only its
   contracts' positions and the counterparties' organizations and roles. No match (missing or not
   a participant) is the same 404 as `GET /voyages/:voyageId`.
3. The stored contracts go through the domain rules (`toLinearTradeString`). A chain that breaks
   them is a data error: it is logged and answered with a generic 500, never shown as valid.
4. The response is the topology only, `{ parties, edges }`
   ([ADR 0010](decisions/0010-trade-string-visibility.md)). An integration test pins its exact
   field set, so participant ids, contract ids or later columns cannot slip in.

### Counterparty-scoped reads and commands: notices

Notices are visible only to the two counterparties of their contract
([ADR 0011](decisions/0011-counterparty-notices.md)). Every notice request goes through the same
two steps, inside the database:

1. `CounterpartyContracts.listForVoyage(principal, voyageId)` loads the voyage by id `AND
accessibleVoyages(principal)`, with only those of its contracts whose seller or buyer is the
   principal's organization (`counterpartyContracts(principal)`). No voyage: 404. No contracts
   (a service provider, or a trader outside this part of the string): an empty list.
2. Notices are loaded `WHERE voyage_id = :voyageId AND trade_contract_id IN (those contracts)`.
   A notice of another voyage, under someone else's contract, or that does not exist is the same
   empty result and the same 404.

`GET /voyages/:voyageId/my-contracts` serves step 1 to the client (ids, positions, both
parties, the reader's side), so the issue form can name a contract; the trade-string response
stays free of ids.

Commands run in one interactive transaction each, resolving the contract inside it:

- **Issue** (`POST /notices`): contract validation (400), `requireOperator` (403), the contract as
  the principal sees it (404 `Contract was not found.`), the seller side (403), the deadline
  against the API's clock (400), then the insert and `NOTICE_ISSUED`. `201` with `Location`.
- **Acknowledge** (`POST /notices/:id/acknowledgement`, empty or no body): `requireOperator`, the
  notice as the principal sees it (404), the buyer side (403), then
  `updateMany({ where: { id, status: 'ISSUED' } })`, a single conditional `UPDATE`. Zero rows
  means another acknowledgement won: `409`, and the transaction (with no event) rolls back.
  Otherwise `NOTICE_ACKNOWLEDGED` is recorded and the notice returned.

`overdue` is computed by the read model from the deadline and the time of the response
(`notice-rules.ts`), never stored.

### Conditional writes: documentary instructions

Documentary instructions are the first aggregate that is edited after it is created
([ADR 0012](decisions/0012-documentary-instructions.md)). Reads and visibility work exactly as for
notices (`CounterpartyContracts`, opaque 404). What is new is how writes avoid lost updates:

- The aggregate carries a **version** that advances on every change (a revision or an
  acknowledgement), separate from the **revision number** that counts content. Its entity tag is
  `"<version>"`, sent as `ETag` and in the body.
- `PUT /voyages/:voyageId/contracts/:contractId/documentary-instructions` creates with
  `If-None-Match: *` (201) or writes the next revision with `If-Match` (200).
  `POST .../revisions/:n/acknowledgement` requires `If-Match`. The controller turns the headers
  into a precondition (`common/http/preconditions.ts`): none is 428, `If-Match: *` is 428,
  malformed or both is 400. It never compares versions itself.
- Order of checks: guards, then param and body validation (400), the precondition headers (428 or
  400), the role (403), the contract as the principal sees it (404), its side (403), and finally
  the **conditional statement** in the database (`instruction.writes.ts`): `INSERT ... ON CONFLICT
DO NOTHING` or `UPDATE ... WHERE version = ANY($expected) ... RETURNING`. No row means the
  precondition failed (412), or for an acknowledgement, a superseded or already acknowledged
  revision (409), or no such revision (404). The service reads the row after a failed statement
  only to choose that answer.
- The new revision or acknowledgement row, the audit event and the response read happen in the
  same transaction, so the returned `ETag` is the version this write produced.
- A read (`GET` of one instruction, or the list) runs its queries in one `REPEATABLE READ`
  transaction: the contract's visibility, the version, the revisions and their acknowledgements
  come from one snapshot, so a change committed part-way through cannot mix two versions.

Integration tests make every race real: a test holds the contested row's lock (the instruction,
or for creation the contract row that each insert's foreign-key check needs), waits until both
requests are blocked on it in PostgreSQL, then releases them. Two creations, two revisions, two
acknowledgements, and a revision against an acknowledgement each end with exactly one success,
one 412, and the matching rows and audit events.

### Documents: files outside the transaction

Documents are the first writes that carry a file ([ADR 0013](decisions/0013-documents.md)). The
bytes cannot go into the database transaction, so an upload runs in steps, and each step knows
what to undo:

1. **Check before reading.** Guards and path parameters, the precondition headers (428/400),
   `multipart/form-data` and the declared length (415/413, the connection closed unread), then in
   the service the role (403), the contract through `CounterpartyContracts` (404), the seller side
   (403), the revision through `InstructionRevisions.find` (404, or 409 when superseded), the
   document type it requires (404) and the precondition against the document as it is (412).
2. **Receive** (`common/http/multipart-file.ts`, busboy): exactly one part, the file, streamed
   into `DocumentStorage.stage` through `UploadInspection`, which counts and hashes it. Every
   limit holds while the bytes arrive: the declared length, the bytes actually read, the file's
   size, one part. A refusal or an aborted connection destroys the stream, and the staged file
   with it; the error response reads and discards the rest of the body first (see
   [Errors](#request-pipeline)), so the client still gets its answer.
   Then the bytes must start with `%PDF-` (415) and not be empty (400).
3. **Keep**: `promote` renames the staged file to `objects/<new uuid>`.
4. **Commit** in one transaction: `SessionPrincipals.refresh` (the upload took time: 401 if the
   session ended, 403 if the role went, 404 if the user changed organization), the contract again,
   `InstructionRevisions.lock` (`SELECT ... FOR SHARE` on the instruction, then the revision's
   requirements), the conditional write (`INSERT ... ON CONFLICT DO NOTHING`, or `UPDATE ... WHERE
current_version_number = ANY($expected)`), the version row, the audit event and the response.
5. **Compensate** on failure: staged bytes are discarded; kept bytes are removed once the
   transaction has certainly rolled back (it failed before `COMMIT` was sent). A failure while
   committing leaves the bytes, since the commit may have happened; so does a removal that fails.
   Both are logged as orphans.

The only leftover any failure produces is bytes no row names; never a row whose bytes are
missing. The two stores do not commit atomically, and nothing here claims they do.

**Orphan recovery.** After a crash, or when the log reports an orphan, run this by hand (there
is no job yet). It is safe while the API runs, because of the age threshold: an object becomes
named only when its upload commits, and no upload outlives the server's five-minute request
timeout.

1. List `objects/` under `DOCUMENT_STORAGE_DIR` with each file's modification time.
2. Keep the names older than one hour, and look them up:
   `SELECT storage_key FROM document_versions WHERE storage_key = ANY($names)`.
3. Delete the files no row named. Delete files in `staging/` older than one hour as well.

The reverse (a row whose object is missing) can only follow a power loss right after a rename, or
damage to the directory; a download then answers a logged 500, and the version must be restored
from a backup of the directory. Downloads check every file against its size and SHA-256 before
serving it, so damaged bytes are never served as if they were the upload.

**Concurrency.** Two uploads of the same version end in one 201 and one 412, and the loser's kept
bytes are removed. A revision given while an upload is checking or receiving makes the upload's
commit refuse it (409): the commit's share lock waits for the revision and then sees it. A revision
given while an upload commits waits for the upload and supersedes it afterwards. The triggers hold
the same rules for writers other than the API.

**Downloads** stream the version after the check above, as an attachment
(`Content-Disposition` with the uploaded name, ASCII fallback and exact UTF-8), with `nosniff`, a
sandboxing CSP, `Repr-Digest` and `no-store`. Nest's default stream-error handler (a 400 carrying
the error message) is replaced: a generic 500 before the first byte, a cut connection after it.

### Writes (first one: `POST /api/voyages`)

The order of checks, and who decides what:

1. **Guards:** cross-site requests are refused (403), and a request without a session gets 401
   before its body is looked at.
2. **Contract:** `CreateVoyageRequestSchema` (a closed object, `additionalProperties: false` in
   OpenAPI) accepts only shipment facts. Quantities are decimal strings that must fit
   `DECIMAL(14,3)`; excess precision is a 400, never rounded. Ordered laycan and distinct ports
   are checked here too, and again by CHECK constraints.
3. **Service:** the role check (403), then `ReferenceDataService.unknownReferences` turns ids
   that name nothing into field errors (400, same Problem Details shape as contract failures).
4. **One interactive transaction:** take the next reference from the year's counter row (the
   upsert locks it, so concurrent creations queue and a rollback returns the number), insert the
   voyage (`PLANNED`) with the principal's organization as `EXPORTER`, and record
   `VOYAGE_CREATED` with the principal as actor ([ADR 0009](decisions/0009-transactional-audit-events.md)).
   Any failure rolls back all of it and returns a generic 500.
5. **Response:** `201` with the `VoyageDetail` and a `Location` header.

Integration tests run all of this against PostgreSQL: concurrent creations get consecutive,
unique references; a forced audit failure (a temporary trigger) leaves no voyage, participation
or reference behind; spoofed organization ids in the body, headers or query change nothing.

### Configuration

`loadConfig()` validates the environment with Zod at startup and lists every invalid variable at
once. Configuration is injected via the `APP_CONFIG` token; nothing else reads `process.env`.
`DOCUMENT_STORAGE_DIR` (where document bytes are kept) defaults to `var/documents` under the
working directory outside production and is required in production.

## Frontend (apps/web)

```
src/
  app/          App, AppProviders, query-client, routes, layout, theme
  features/
    auth/
      api/          sign-in, sign-out, current user
      session.ts    session query, sign-in/sign-out transitions, protected-data purge
      session-sync.ts  cross-tab identity sync (BroadcastChannel)
      components/   RequireAuth (protected-route boundary), UserMenu
      pages/        SignInPage
    voyages/
      api/          fetch functions + query option factories (query keys live here),
                    including reference data (vessels, commodities, ports) for the form
      domain/       presentation rules for the domain (status labels, role grouping,
                    trade-string steps in contract order, notice states), what to offer whom
      hooks/        useCreateVoyage, useIssueNotice, useAcknowledgeNotice,
                    useSubmitInstruction, useAcknowledgeRevision, useUploadDocument,
                    useDownloadDocument: mutations and what happens after them
      components/   feature UI (table, filter, facts card, trade string, notices, participants)
      pages/        route components; compose data hooks and components
      routes.tsx    the feature's routes; the app shell only composes them
  shared/
    api/        fetch wrapper: ApiError (Problem Details), ApiContractError; JSON, one-file
                multipart uploads and blob downloads
    auth/       identity context and identity-scoped query keys
    lib/        formatting (numbers, calendar dates, countries), saving a downloaded file
    ui/         generic UI: PageHeader, QueryErrorAlert, NotFoundState
  test/         MSW server, typed fixtures, renderRoute helper
```

**Rule of thumb:** code lives in a feature until a second feature needs it, and only then moves to
`shared/`. `shared/` never imports from `features/`.

### State ([ADR 0003](decisions/0003-frontend-server-state.md))

| Kind of state       | Where it lives                                       |
| ------------------- | ---------------------------------------------------- |
| Server data         | TanStack Query cache (`voyageQueries.*` factories)   |
| Who is signed in    | TanStack Query too: `['session']` from `/auth/me`    |
| Shareable UI state  | URL (`?status=LOADING`), validated with the contract |
| Ephemeral UI state  | Component state                                      |
| Global client state | None yet; Zustand when a real case appears           |

### Data access

- `getJson(path, schema)` validates every response against the contract. If the frontend and
  backend are deployed out of sync, the request fails with an `ApiContractError` and an error
  message, instead of rendering `undefined` deep in a component.
- Retry policy: 4xx responses are never retried (they are deterministic); network errors and 5xx get
  two retries.
- Query keys are hierarchical and, for protected data, start with the identity scope
  (`['protected', '<userId>:<organizationId>', 'voyages', 'list', filters]`), so mutations can
  invalidate precisely and data never crosses identities (see below). Reference data is the same
  for everyone but is fetched with a session, so it lives under the scope too.
- The details page validates the route parameter before fetching. A malformed id renders "not
  found" without a network request.
- **Trade string.** The details page fetches the voyage and its trade string in parallel; the
  string's key nests under the voyage's detail key. The client additionally checks that every edge
  connects listed parties (a failure is an `ApiContractError`). The card orders parties by the
  contracts' positions, never by name, and degrades on its own: loading, an error with retry, or
  "Trade string not configured" for a voyage without contracts, while the rest of the page stays.
  It is an ordered list (`role="list"`, since list styling would drop the semantics in Safari)
  with each sale read out as "Sells to … under Contract n"; parties stack vertically with
  downward arrows on phones and sit in a row with arrows in the gaps from the `md` breakpoint.
  Surveyors and shipping agents stay in the participant directory below it.
- **Creating a voyage** (`/voyages/new`, offered only to operators; the API checks again). The
  form validates with the same `CreateVoyageRequestSchema` as the API and shows its messages per
  field; server field errors (400) land on the same fields, other failures in one alert, and the
  input is kept. The quantity is sent as the string typed. On success, `useCreateVoyage` stores
  the returned voyage as its detail, invalidates **that identity's** voyage lists, and opens the
  details page. The response is checked against the identity the form was rendered for when it
  arrives: if that identity is no longer signed in (signed out, replaced from another tab), the
  response writes nothing to the cache and does not navigate. Navigation also happens only while
  the form is still mounted, so a user who has moved on is not pulled back.
- **Notices** (a card on the details page, between the trade string and the participants). The
  page fetches the organization's contracts and its notices in parallel with the voyage; both
  keys nest under the voyage's detail key. The card degrades on its own like the trade string,
  and explains itself to a participant that is a party to no contract. Operators of a seller see
  **Issue ETA notice**, a form offering only contracts their organization sells under; times are
  entered as wall-clock time in the viewer's zone (`datetime-local`), named on the form, and sent
  as UTC instants. Operators of a buyer see **Acknowledge receipt** on notices waiting for them.
  Instants are always shown in the viewer's zone with its offset. Every write goes through
  `sendForCurrentSession` (`features/auth/session.ts`), shared with voyage creation: a 401 for the
  session the request was sent under signs out locally, a late 401 for a replaced session changes
  nothing, and nothing is retried automatically. A success writes to the cache only if the
  identity it was sent for is still signed in. A 409 on acknowledging reports the conflict and
  refreshes the list, so the user sees who acknowledged first.
- **Documentary instructions** (a card after the notices, one panel per contract the organization
  is a party to). The list carries each instruction's `version`; requests send it back as
  `If-Match` (`putJson`/`postJson` take headers). The panel shows the current revision, its
  documents and acknowledgement, and earlier revisions in a collapsed section. Buyer operators
  get a form that starts from the current revision; seller operators get **Acknowledge receipt
  of revision n**, which sends the version of the revision on screen. The form keeps the version
  its draft started from (its _basis_), never the latest cached one, so a background refresh can
  never turn a stale draft into a valid write. When the instructions moved on (a 412, or a
  refresh that shows a newer version) the draft stays as typed, the newer revision is shown
  beside it, and **Send** is disabled until the user chooses **Base my draft on revision n**. A
  412 does not refresh anything by itself; the user asks for the latest version. Once loaded,
  the card stays mounted through a failed refresh, so an open draft is not lost to a network
  error. Writes go through `sendForCurrentSession`, are never retried, and write to the cache
  only for the identity that sent them.
- **Documents** (inside each contract's instruction panel, under the revision they answer). The
  page fetches the document list alongside the instructions, under the voyage's detail key. The
  current revision lists every document it requires: presented or not, the current version and
  earlier ones, each with a download; earlier revisions show only what was presented against them.
  Seller operators choose a PDF per document; the choice is checked with the contract's
  `DocumentFileSchema` before anything is sent, and the upload is a real `multipart/form-data`
  request (`postFile`). Like an instruction draft, a chosen file remembers the version it would
  replace (its basis) and sends it as `If-Match` (`If-None-Match: *` when there was none); a 412,
  or a refresh showing someone else's version, keeps the file, shows that version and disables
  the upload until the user chooses to replace it. Any failure keeps the chosen file and nothing
  is re-sent on its own; a 409 (the revision was superseded) refreshes the instructions.
  Downloads are `fetch`ed through `sendForCurrentSession` and handed to the browser as a blob
  (`saveFile`), so a 401 signs out as elsewhere, and a download that arrives after the identity
  changed is not saved. The section degrades on its own: the revision above it stays readable.

### Authentication in the browser

The session cookie is HttpOnly: the SPA never sees a token. It asks `GET /api/auth/me` who is
signed in and keeps the answer as the `['session']` query ([ADR 0007](decisions/0007-cookie-sessions.md)).

- **Protected routes** render inside `RequireAuth`. It shows a spinner until the server answers,
  redirects to `/sign-in` (remembering the page) when there is no session, and otherwise provides
  the identity through `IdentityContext`, keyed by identity. A change of identity therefore
  discards the whole protected component tree.
- **Identity-scoped cache.** Every protected query key starts with `useProtectedScope()`, i.e.
  `['protected', '<userId>:<organizationId>']`. A component can only build keys for the identity
  it renders under, so a previous identity's cached data is unreachable by construction, even for
  a single frame and regardless of cleanup timing.
- **Identity changes** all go through `switchIdentity`: sign-in, sign-out, a 401 on protected data,
  or `/auth/me` reporting someone new. It first cancels every in-flight protected request (fetches
  are made with the query's `AbortSignal`) and removes protected data nothing displays. It then
  publishes the new identity. Queries still observed by the outgoing tree are removed the moment
  that tree unmounts, by a query-cache subscription; they are not removed earlier, because a last
  render would rebuild and refetch them.
- **Ordering.** Each explicit transition starts a new _generation_ (kept per query client in
  `session.ts`) and cancels session checks in flight. A check's answer counts only if no
  transition started while it was on its way; a stale answer neither publishes an identity nor
  purges data. Requests that change the cookie (sign-in, sign-out) run one at a time, so a slow
  sign-out response cannot clear the cookie of a newer sign-in. The sign-in form stays disabled
  ("Finishing sign-out…") until the previous sign-out is answered.
- **Sign-in owns the session** from the moment it starts until it resolves. Starting it begins a
  generation (outdating checks already on their way), drops any previous identity's data and
  sets the session to "nobody", so no protected content renders meanwhile. Checks made while it
  is pending answer "nobody" without asking the server. Only the _latest_ sign-in intent may
  publish an identity: an earlier queued sign-in that completes meanwhile publishes nothing, and
  a sign-out overtakes every pending sign-in. Outcomes of the latest intent:
  - _Success_: its identity is published (written to the cache directly, so cache and cookie
    agree even when nothing observes the session).
  - _Refused_ (or failed): the server is asked who is signed in and its answer is published,
    then the error is reported. After an earlier queued sign-in succeeded that is that identity
    (a refused sign-in revokes nothing); otherwise it is usually nobody. An unconfirmed sign-out
    stays in force, so the answer is then "nobody" without asking.
  - _Another tab changed the session_ while it was on its way: once its own response has set
    the cookie, the server is asked again and its answer published.

  These reconciliations fetch `/auth/me` directly and write the result; they do not rely on
  invalidation, which leaves an unobserved session query stale instead of refreshed. If the
  server cannot be reached, the session becomes "unknown" and is checked again by whatever
  displays it next.

- **Sign-out** acts locally first (abort, purge, go to `/sign-in`) and then revokes the session on
  the server, so nothing from the old identity remains on screen even if the network is down. If
  the server does not confirm, the sign-in page says so and offers a retry. Until then the tab
  stays signed out: session checks answer "nobody" without restoring the old identity. Signing
  in also clears this state (sign-in revokes the session the browser presented). The state lives
  in memory, so a reload asks the server again.
- **Session end detected by the server.** A 401 on a query of the _current_ identity means the
  session expired or was revoked. The client signs out locally. A late 401 from an earlier
  identity's request is ignored.
- **Other tabs.** Tabs share cookies, so a sign-in or sign-out in one tab changes every tab's
  identity. Tabs notify each other on a `BroadcastChannel` after a sign-in or a confirmed
  sign-out. A receiving tab starts a new generation, purges its protected data immediately and
  resets the session query to "unknown" until the server answers. The session is also re-checked
  whenever a tab regains focus. Cookie requests are ordered within a tab, not across tabs.

### Presentation details that are correctness issues

- Quantities stay decimal strings end to end and are formatted with
  `Intl.NumberFormat.format(string)`; they never pass through a float.
- Calendar dates (`YYYY-MM-DD`) are formatted with `timeZone: 'UTC'`. Otherwise a user west of
  Greenwich sees the laycan start one day early. The web test suite runs in `America/Sao_Paulo` to
  keep this honest.

## Testing strategy

| Layer            | Tool                       | Fakes                          | Purpose                                           |
| ---------------- | -------------------------- | ------------------------------ | ------------------------------------------------- |
| Contract schemas | Vitest                     | none                           | Wire-format rules                                 |
| API unit         | Vitest                     | none (pure functions)          | Mapping, ordering, precision, chain rules, config |
| API integration  | Vitest + supertest         | none: real Nest, real Postgres | Endpoints, auth, roles, transactions, docs        |
| Web              | Vitest + RTL + MSW (jsdom) | network only                   | Pages through real router, cache and client       |
| End-to-end       | Playwright (planned)       | none                           | Critical user journeys                            |

Prisma is not mocked: a mocked ORM tests the mock. API tests are serialized against a dedicated
`*_test` database that is truncated between tests. Authorization tests sign in through the real
endpoint and assert the participation and role rules against real rows: shared and private
voyages, status filters, client-supplied organization ids, removed participation, viewer versus
operator (re-read on every request), atomic creation with its audit event, concurrent reference
numbering, and expired or revoked
sessions. The trade string is tested there too: topology for every participant and a 404 for
outsiders, the exact response fields, a stored chain that breaks the domain rules, and the
`trade_contracts` constraints, exercised with plain SQL inserts (cross-voyage counterparties,
duplicate positions, self-sales, branches) so that the database alone is shown to refuse them.
Notices are tested the same way: seller and buyer operators and viewers, every other participant
and outsiders (equal 404s), cross-voyage and foreign contract and notice ids, spoofed actors in
bodies, headers and query strings, deadline validation, derived and late states, immutability
and the table's constraints with plain SQL, a forced audit failure on each command, and two
acknowledgements that genuinely race: the test holds the notice's row lock until both requests
are blocked on their conditional update, then releases it and expects one 200, one 409 and one
audit event. Another test pins that the trade-string response is byte-for-byte unchanged.
Documentary instructions add the four races described [above](#conditional-writes-documentary-instructions),
every precondition outcome (428, 412, 409, 400 for malformed headers), immutability and the
aggregate's transition rules with plain SQL, the requirements CHECK, a forced audit failure on
each command (nothing written, version unchanged), and a role removed or an organization changed
between reading and writing.
Documents are tested with real multipart uploads and downloads against a temporary storage
directory (the production `LocalDocumentStorage`, wrapped so a test can make one operation fail):
byte-for-byte round trips with their checksum and headers, refusals by a guard, a check or the stream that still reach a client sending a large file, exactly 10 MiB accepted and one byte
more refused while streaming, a declared oversize body refused unread, files that only claim to be
PDFs, empty files, extra parts and fields, malformed bodies, file names with paths, control
characters and non-ASCII letters; who may upload, list and download (opaque 404s for everyone
else); preconditions; superseded revisions before the upload and at commit (the test holds the
instruction row while the upload's bytes are kept, then gives revision 2); a revision that waits
for an upload's commit; two first versions and two replacements racing (one 201, one 412, the
loser's bytes removed); an upload abandoned part-way (nothing staged, nothing written); a session
revoked, a role removed and an organization changed while the bytes arrive (sent by hand, byte by
byte); staging, promotion, audit and compensation failures (rows, staged files and kept objects
asserted after each); missing, unreadable and tampered bytes never served; and the tables'
triggers and constraints with plain SQL.

No test runs in a real browser yet: web tests render in jsdom, so layout (the responsive trade
string included) is not covered automatically. Playwright is the planned answer.

Web tests use a stateful fake of the auth endpoints, so sign-in, sign-out, identity switches and
cross-tab changes run through the real router, query client and cache. They assert, among other
things, that an in-flight request is aborted on sign-out and that a previous user's data never
appears in the DOM after a switch (a `MutationObserver` watches for it). Voyage creation is tested
the same way: success, client and server validation, failures, a viewer, and a creation response
that arrives after a sign-out or after another tab signed in as someone else. The notice panel
gets the same treatment: issuing (with local times converted to instants) and acknowledging,
validation, refusals, failures without retries, a 409, expiry, and responses that arrive after
the identity changed. The documentary-instruction card is tested for both sides and both roles,
the preconditions each write sends, client and server validation, a 412 on revising and on
creating (draft kept, nothing re-sent until the user rebases), a newer version brought in by a
refresh while editing, a failed refresh with a draft open, an acknowledgement overtaken by a
revision, expiry, and responses that arrive after the identity changed. Documents are tested
through the same route tree: what each side and role is offered, the multipart request an upload
sends (field, file name, type, bytes, precondition), files refused before sending, server refusals
and failures that keep the chosen file without re-sending it, a 412 and a refresh that bring in
someone else's version, a superseded revision, downloads saved under their name, 401s, and upload
and download responses that arrive after a sign-out or after another tab signed in as someone
else. jsdom's own `File` and `FormData` cannot be sent by Node's `fetch`, so the test setup puts
Node's on the global object (a `FormData` built from a `<form>` stays jsdom's).

## Operational concerns (current state)

| Concern      | Today                                                                                     | Planned                                          |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Health       | `GET /api/health` checks DB connectivity                                                  | Split liveness and readiness when deployed       |
| Logging      | Nest logger; 5xx logged with stack                                                        | Structured JSON logs, request ids, OpenTelemetry |
| Config       | Validated env, fail fast                                                                  | Secrets manager in cloud environments            |
| Shutdown     | `enableShutdownHooks`; Prisma disconnects on destroy                                      | —                                                |
| File storage | Private local directory; orphans logged, removed by a manual procedure; no backups        | Object store, lifecycle rules, scheduled sweep   |
| Supply chain | Exact versions, lockfile, pnpm install-script allowlist, release-age quarantine respected | Renovate, pinned action SHAs                     |

## Evolution

How later requirements land on the current structure:

| Requirement              | Where it goes                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication           | **Done (M2)**: `auth` module, cookie sessions ([ADR 0007](decisions/0007-cookie-sessions.md)). Next: OIDC for SSO, rate limiting on sign-in, password reset                                                                                                                                                                                                                                  |
| Tenant isolation         | **Done (M2)**: every voyage query `AND`s `accessibleVoyages(principal)` ([ADR 0006](decisions/0006-participation-based-access.md)). Next: Postgres RLS as defence in depth                                                                                                                                                                                                                   |
| Trade string             | **Started (M4)**: `trade_contracts` as edges, chain rules in the domain, topology readable by every participant ([ADR 0010](decisions/0010-trade-string-visibility.md)). Counterparty-only contract ids since M5. Next: recording it through the API (validated and audited in one transaction); counterparty-only contract details                                                          |
| Notices                  | **Started (M5)**: ETA notices, counterparty-only, `ISSUED → ACKNOWLEDGED` by conditional update, overdue derived ([ADR 0011](decisions/0011-counterparty-notices.md)). Next: further notice types, then notifications of new and overdue notices (outbox + jobs)                                                                                                                             |
| Write authorization      | **Started (M3)**: `VIEWER` / `OPERATOR` on the user, checked in the command service ([ADR 0008](decisions/0008-user-roles.md)). Next: participant-role rules for commands on existing voyages; a membership table when users act for several organizations                                                                                                                                   |
| Documentary instructions | **Started (M6)**: one per contract, immutable revisions, per-revision acknowledgement by the seller, counterparty-only ([ADR 0012](decisions/0012-documentary-instructions.md)). Documents presented against them since M7. Next: presentation deadlines                                                                                                                                     |
| Optimistic concurrency   | **Started (M6)**: `version` on documentary instructions; one conditional `UPDATE ... WHERE version = ANY(...)`; `ETag`, `If-Match` (412), `If-None-Match: *`, 428 without a precondition ([ADR 0012](decisions/0012-documentary-instructions.md)). Next: the same for recording the trade string                                                                                             |
| Idempotency              | `Idempotency-Key` header persisted with the response for unsafe requests                                                                                                                                                                                                                                                                                                                     |
| Audit trail              | **Started (M3)**: append-only `audit_events`, written in the same transaction ([ADR 0009](decisions/0009-transactional-audit-events.md)). Next: a voyage timeline, more actions                                                                                                                                                                                                              |
| Real-time                | SSE endpoint per voyage; the client invalidates TanStack Query keys on events                                                                                                                                                                                                                                                                                                                |
| Background jobs / outbox | Outbox table written transactionally; a relay publishes to BullMQ (Redis)                                                                                                                                                                                                                                                                                                                    |
| Documents                | **Started (M7)**: PDF versions per required document of an exact revision, counterparty-only, uploaded by the seller with `If-Match`; bytes staged outside the transaction in a private local directory, compensated on failure ([ADR 0013](decisions/0013-documents.md)). Next: S3-compatible storage behind the same interface, pre-signed uploads, a scheduled orphan sweep, buyer review |
| AI extraction            | `ai` module that produces _proposals_; a human approves before any business object changes                                                                                                                                                                                                                                                                                                   |
