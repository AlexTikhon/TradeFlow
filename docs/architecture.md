# Architecture

This document describes how TradeFlow is built today and how it is meant to grow. Decisions with
meaningful alternatives are recorded as ADRs in [decisions/](decisions/).

## System context

```
 Browser ──▶ Web SPA (Vite build, static files)
                │ fetch /api/*  (same origin; Vite proxies in development)
                │ EventSource /api/voyages/:id/events  (server-sent events, same origin)
                ▼
            API (NestJS, single process) ──▶ PostgreSQL 18
                │
                └──▶ document storage (private local directory, or private S3-compatible bucket)
```

There is one deployable backend, one database and one static frontend. Uploaded document bytes
live behind a storage interface, in a private directory beside the API by default or an opt-in S3-compatible bucket
([ADR 0013](decisions/0013-documents.md)). Live updates are announced in the API's memory
([ADR 0015](decisions/0015-voyage-event-streams.md)), which is one reason it is a single process
today: a second instance would neither hear nor relay the first one's announcements. Nothing
else is needed for the current scope: no cache, no queue and no broker. Each of
those arrives with the feature that needs it (see [Evolution](#evolution)).

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
                                arrives), content-disposition.ts (attachment headers);
                                http-diagnostics.ts, request-context.ts, request-failure.ts
                                (request ids and lifecycle records, see HTTP diagnostics)
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
      audit-timeline.ts         AuditTimeline.page(db, scope, page): the only reader of
                                audit_events; the caller passes who may see what (TimelineScope);
                                identifiers-only entries, opaque cursors
    reference-data/
      reference-data.*.ts       GET /vessels, /commodities, /ports; id existence checks
    organizations/
      organizations.*.ts        GET /organizations?search=: operators only, at most 20
                                references (id, name, country), never the caller's own (ADR 0016)
    voyages/
      voyages.controller.ts     HTTP only: parse input, call service, map "missing" to 404
      voyages.service.ts        use cases (list, get, create), each taking the Principal
      voyage-access.ts          accessibleVoyages(principal): the one visibility predicate
      voyage-reference.ts       takeNextVoyageReference(tx): per-year counter, row-locked
      voyage.read-model.ts      Prisma select shapes + row → contract mapping
      trade-string.ts           domain rules for a linear trade string (pure functions)
      trade-string.read-model.ts  allowlisted select + stored contracts → topology
      trade-string-setup.ts     the candidate chain a setup would record; precondition rules
      trade-string.service.ts   findForVoyage(principal, id): one query, access predicate inside;
                                configure: the one-time setup of a new voyage (ADR 0016)
      trade-string.controller.ts  GET and POST /voyages/:voyageId/trade-string
      counterparty-contracts.ts   CounterpartyContracts: a contract as its seller or buyer sees
                                  it; exported, the only way other modules resolve a contract;
                                  listAcrossVoyages: every contract in scope (Action Center)
      counterparty-contracts.controller.ts  GET /voyages/:voyageId/my-contracts
      voyage-timeline.service.ts  the reader's scope (participation, contracts) and the page,
                                  from one REPEATABLE READ snapshot
      voyage-timeline.controller.ts  GET /voyages/:voyageId/timeline
      voyage-event-bus.ts       VoyageEventBus: in-process publish/subscribe of committed
                                changes per voyage; exported, best effort (ADR 0015)
      voyage-event-streams.ts   VoyageEventStreams: open streams, a check before every delivery,
                                periodic rechecks, coalesced and bounded queues
      voyage-events.controller.ts  GET /voyages/:voyageId/events (text/event-stream)
    notices/
      notice-rules.ts           deadline rules, overdue and lateness (pure functions)
      notice.read-model.ts      allowlisted select + row → contract mapping, overdue derived
      notices.service.ts        list, get, issue, acknowledge; role and side checked here;
                                announces each command after it committed
      notices.controller.ts     /voyages/:voyageId/notices[/:noticeId[/acknowledgement]]
      issued-notices.ts         IssuedNotices: ISSUED notices under given contracts; exported
    documentary-instructions/
      instruction-rules.ts      MVP content rules: what counts as an unchanged revision (pure)
      instruction.read-model.ts allowlisted select (all revisions, acknowledgements) + mapping
      instruction.writes.ts     the three conditional SQL statements that decide every write
      documentary-instructions.service.ts     list, get, put (create or revise), acknowledge
      documentary-instructions.controller.ts  preconditions (If-Match / If-None-Match), ETag
      instruction-revisions.ts  InstructionRevisions: the current revision and what a revision
                                requires; exported, share-locks the instruction for a commit
      current-revisions.ts      CurrentRevisions: each instruction's current revision and its
                                acknowledgement, under given contracts; exported
    documents/
      document-rules.ts         PDF signature, display file names, UploadInspection (size, hash)
      document.read-model.ts    allowlisted select (every version and its review, never the
                                storage key)
      document.writes.ts        the three conditional SQL statements that decide every upload
                                and every review
      documents.service.ts      list, upload (check, receive, keep, commit, compensate), review,
                                download
      documents.controller.ts   multipart upload, review, preconditions, ETag, attachment download
      latest-document-versions.ts  LatestDocumentVersions: latest file and review of each
                                document of given revisions; exported
    action-center/              (ADR 0017; owns no table)
      action-items.ts           which records ask what of an organization, keys, page order (pure)
      action-item-pages.ts      filters, keyset pages, opaque cursors (pure)
      contract-facts.ts         the owning modules' reader outputs → the rules' facts
      action-center.service.ts  scope and facts from one REPEATABLE READ snapshot, one clock
                                reading, the page cut in memory
      action-center.controller.ts  GET /action-items
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
  that the ids in a request exist), `AuditTrail` (to record what it did), `AuditTimeline` (to read
  the timeline within the scope it decided) and the auth module's `SessionPrincipals` (to re-read
  an event stream's session); it never touches `audit_events` itself. `notices` and
  `documentary-instructions` import `CounterpartyContracts` (to resolve the reader's contracts,
  with the access rule inside the query) and `AuditTrail`; neither queries `trade_contracts` or
  `voyage_participants`. `notices` also announces its committed commands through the voyages
  module's `VoyageEventBus`, and never learns who listens. `documents` imports
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
`@CurrentPrincipal()` / `@Public()` decorators and `requireOperator`. The `organizations` module
only searches the curated set of organizations; nothing creates or edits them. `audit` owns
`audit_events`; `reference-data` owns vessels, commodities and ports; `notices` owns `notices`;
`documentary-instructions` owns `documentary_instructions` and their revisions and
acknowledgements; `documents` owns `documents`, `document_versions` and the bytes in document
storage.

### Request pipeline

Before any of the steps below, the first middleware (`HttpDiagnostics.middleware`, registered
first in `app.setup.ts`, ahead of the body parsers) gives the request a server-generated id and
context and watches for its end ([HTTP diagnostics](#http-diagnostics)).

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

   Errors with status 5xx are returned with a generic `detail`, so internals never leak, and
   described by bounded fields on the request's lifecycle record
   ([HTTP diagnostics](#http-diagnostics)). Integration tests assert both. An error can be answered before
   the request's body was read (an upload refused by a guard, or by its service before receiving
   the file); Node would then reset the connection under a client still sending, so the filter
   first reads and discards the rest of the body, up to 16 MiB (`unread-body.ts`), and closes the
   connection after the answer beyond that.

5. **Caching.** Every `/api` response carries `Cache-Control: no-store`: responses depend on who
   is signed in, so no browser or proxy may keep them. Express's automatic `ETag` (a body hash)
   is switched off: entity tags appear only where writes are conditional, and mean an aggregate
   version ([ADR 0012](decisions/0012-documentary-instructions.md)).

### HTTP diagnostics

An operator can find the server's account of a failed request from what the client saw, without
any credential, business content or document byte being logged.

**Request ids.** Every response, from any route, guard, pipe, filter, stream or 404, carries
`X-Request-ID`: a fresh `randomUUID()` made by the server when the request arrives. A caller's
`X-Request-ID` is never read, so clients can neither choose nor inject log identifiers. The id is
returned whether or not records are written.

**Context.** `HttpDiagnostics.middleware` is the first middleware, so its context covers body
parsing, guards, pipes, handlers and the exception filter. The rest of the pipeline runs inside
`AsyncLocalStorage.run` (`currentRequestContext()`), and the context is also bound to the
response object (`requestContextOf(response)`) for callbacks whose async context is not the
request's: stream error handlers, and event-stream work driven by a shared timer or by another
request's publication. Nothing keeps a "current request" in mutable shared state; long-lived
work started during a request (the event streams' recheck timer, bus deliveries) runs under
`outsideRequestContext`, so it never carries that request's context.

**Lifecycle records.** With `HTTP_REQUEST_LOG=enabled` (the default, in every environment) each
request ends with exactly one single-line JSON record, handed to a best-effort writer for
standard output that may drop it (**Writer**, below). These are all the fields
there are:

| Field        | Value                                                                                   |
| ------------ | --------------------------------------------------------------------------------------- |
| `timestamp`  | When the request ended, ISO 8601 UTC                                                    |
| `level`      | `error` (a 5xx, or a noted failure), `warn` (`aborted`), otherwise `info`               |
| `event`      | Always `http.request`                                                                   |
| `requestId`  | The id returned as `X-Request-ID`                                                       |
| `method`     | `GET`, `HEAD`, `POST`, `PUT`, `PATCH`, `DELETE`, `OPTIONS`, or `OTHER`                  |
| `route`      | The matched route template, e.g. `/api/voyages/:voyageId/events`; `unmatched` otherwise |
| `status`     | The status sent; `null` when the connection ended before any response headers were sent |
| `durationMs` | Arrival to end, from the monotonic clock (`performance.now()`), to 0.1 ms               |
| `outcome`    | `completed`, `aborted` or `stream_failed` (below)                                       |
| `error`      | Only on 5xx answers and failed streams: `{ source, name, code?, frames? }`              |

- `completed`: the whole response was handed to the connection, whatever its status.
  `aborted`: the connection closed first and no server-side failure was noted (the client left).
  `stream_failed`: a download or event stream that had started was ended early by the server
  (unreadable bytes mid-download, a failed access check, a stream bound).
- One record per request: the first of the response's `finish` and `close` events builds it,
  hands it to the sink and removes both listeners (Node emits `close` after `finish` too). Never
  two; zero when the writer drops it. Streams are not buffered and
  nothing is recorded per chunk, event or heartbeat; the record is written when they end.
- `error.source` is `exception` (the exception filter, 5xx only), `download_stream` (the
  download's byte stream failed) or `event_stream`. `name` is the error's class name from its
  constructor (never the assignable `error.name`) or a fixed reason (`PendingSignalLimit`,
  `ClientNotReading`); `code` is a library code matching `[A-Za-z0-9_]{1,64}` (`ECONNREFUSED`,
  `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `P2002`, `23505`); `frames` are up to 5 stack frames,
  each validated as a code location and read only after the stack's message header. An error's
  message, properties and cause are never read. The filter, the download error handler and the
  event streams note the failure on the context instead of logging it themselves, so a failure
  has one record.
- Not recorded: URLs, query strings, path parameter values, headers (cookies, `Authorization`),
  request or response bodies, file names, PDF bytes, SQL or its parameters, connection strings,
  signed storage URLs. Values are built from an allowlist and serialized with `JSON.stringify`,
  so no field can break a line. Client-facing answers are unchanged: Problem Details
  (`instance` still echoes the request path) and generic 5xx `detail`s.
- The sink is injectable (`HTTP_DIAGNOSTICS_SINK`; tests capture records with their own). A
  sink that throws loses that record and changes nothing else: the response, its cleanup and
  later requests are unaffected.

**Writer.** The production sink, `StreamSink` on `process.stdout`
(`common/http/diagnostics-sink.ts`), is bounded and best effort. Records are diagnostics, not an
audit trail: **records can be lost**, and the output does not say when.

- It hands each record, with its line break, to `process.stdout.write()` and never awaits it.
  Handlers, response callbacks and event streams never wait for logging or for `drain`. There is
  no queue, retry, timer or promise.
- **Bounds, in UTF-8 bytes.** A record over `MAX_RECORD_BYTES` (8 KiB) is dropped; real records
  are under about 3.5 KiB (a 256-character route template and five stack frames). Record bytes
  handed to the stream and not yet reported written by its write callback (in flight, including
  Node's own buffer) are at most `MAX_BUFFERED_BYTES` (64 KiB, a few hundred records): a record
  that would go past it is dropped. Records are dropped whole, never truncated.
- **Backpressure.** When `write()` returns false the sink is `blocked`: it drops every record
  until the stream emits `drain` (one `once` listener), then writes again. Node signals this at
  the stream's high-water mark: 64 KiB for a Linux stdout pipe on Node 24, the same as the byte
  bound, so there the bound usually trips first; 16 KiB for a Windows pipe (measured). Either
  way, writing resumes by itself once the reader catches up.
- **Failure is permanent.** A write callback error, a synchronous throw from `write()`, or the
  stream's `error` or `close` event (EPIPE when the reader of the pipe is gone) moves the sink to
  `failed`: every later record is dropped until the process restarts. It reports nothing: it
  never logs its own failure, so it cannot recurse, and it installs no process-wide handlers.
  Its `error` listener is on `process.stdout` itself, so while attached it also absorbs a
  stdout error that a Nest `Logger` write would raise; no other errors are touched.
- **Shutdown.** `HttpDiagnostics.onApplicationShutdown` closes the sink after Nest has closed the
  HTTP server, so requests that were draining still get their record. Afterwards every record
  is dropped. Closing never ends or destroys `process.stdout` and waits for nothing: writes in
  flight are left to the stream.
- **Listeners.** The sink keeps one `error` and one `close` listener on `process.stdout`, plus
  `drain` only while blocked. Once failed or closed, it removes them when no write is in flight
  and the stream has no error left to emit (Node calls the failed write's callback before it
  emits `error`, and a listener removed in between would leave that error uncaught). Writes a
  stalled reader never settles keep those two listeners until the process exits.
- **Not non-blocking everywhere.** `write()` returns at once only where Node writes
  asynchronously. Node writes synchronously to files, to POSIX terminals and to Windows pipes:
  measured on Windows (Node 24.11.1), with the reader of a stdout pipe paused, a write blocked
  the whole process for 2.95 s until the reader resumed. In the mock and the intended hosts the
  API's standard output is a Docker log pipe on Linux, which Node writes asynchronously. A
  reader that stops there costs dropped records, not a stalled API; redirected to a file or a
  terminal, a slow disk or terminal can still stall it.

**Troubleshooting with a request id.** A client reports a failed download; its response carried
`X-Request-ID: 9e33e7a5-bb80-422d-9af4-d0d1c6058371`. Search the API's output for the id:

```sh
docker logs <api-container> 2>&1 | grep 9e33e7a5-bb80-422d-9af4-d0d1c6058371
```

```json
{
  "timestamp": "2026-11-26T07:26:09.154Z",
  "level": "error",
  "event": "http.request",
  "requestId": "9e33e7a5-bb80-422d-9af4-d0d1c6058371",
  "method": "GET",
  "route": "/api/voyages/:voyageId/contracts/:contractId/documentary-instructions/revisions/:revisionNumber/documents/:documentType/versions/:versionNumber/content",
  "status": 500,
  "durationMs": 14.6,
  "outcome": "completed",
  "error": {
    "source": "download_stream",
    "name": "Error",
    "code": "EIO",
    "frames": [
      "at Readable.read (node:internal/streams/readable:737:12)",
      "at resume_ (node:internal/streams/readable:1260:12)",
      "at process.processTicksAndRejections (node:internal/process/task_queues:89:21)"
    ]
  }
}
```

The stored bytes failed with `EIO` before the first byte was sent, so the client got a generic
500 (`completed`, not `stream_failed`). Which voyage and document it was is deliberately not in
the record: the client knows the URL it requested; the server-side cause is in the storage
provider's own logs and the reconciliation tools ([runbook](storage-recovery.md)). (This record
was captured from the integration suite, which injects that failure.)

**Remaining unstructured logs.** Only the HTTP lifecycle is structured. Nest's own startup lines
(`main.ts`, Nest's bootstrap) and these service-level `Logger` calls remain plain Nest text
lines without a request id, unchanged: `DocumentsService` (a staged upload that could not be
discarded, bytes kept after a commit with an unknown outcome or a failed removal: orphans to
reconcile), `S3DocumentStorage` (a failed upload's object that could not be removed),
`NoticesService`, `DocumentaryInstructionsService` and `DocumentsService` ("Could not announce",
a publication that failed after commit) and `VoyageEventBus` (a listener that throws). They may
contain error messages, stacks, voyage ids and storage keys. They describe secondary facts
(orphans, lost signals), not the request's own failure, which is on its record; correlate them
with a request by time only. The failures that used to be logged as well as answered (the
exception filter's 5xx, a download's stream error, an event stream's failed check or bound, the
write budget's unavailable store) are now on the request's record only.

**Tests.** Unit tests drive the middleware with a fake response (`finish`/`close` races, listener
release, failing sink, spoofed id, route and method allowlist, monotonic duration) and the
classifier with hostile errors. `test/http-diagnostics.int-spec.ts` goes through the real
pipeline with a capturing sink and a test-only probe controller: success, guard and validation
rejections, a 5xx, 40 concurrent requests whose handlers read their own context after timers and
body parsing, spoofed ids, unmatched routes, a client abort, downloads (completed, failed before
the first byte, cut off after it, abandoned by the client), event streams (client gone, ended
normally, a failed check attributed to its own stream), a failing sink and `HTTP_REQUEST_LOG`
disabled. Every record must be one line of JSON with only the fields above and none of the
synthetic secrets sent in headers, query strings, paths, bodies, file names and errors, nor the
run's session tokens. `pnpm deploy:verify` checks ids and records through the HTTPS edge
([results](deployment-mock.md#http-diagnostics-local-verification-2026-11-26)).

The writer has its own tests. `diagnostics-sink.spec.ts` drives it with a `Writable` whose
writes settle only when the test says: backpressure, drop and resume on `drain`, the byte bound
on a stream that never pushes back, oversized records (counted in UTF-8 bytes), asynchronous
write errors and `error`/`close` events (with no uncaught error), a throwing `write()`,
shutdown idle and blocked, and listener release, including the tick between a failed write's
callback and its `error` event. `diagnostics-sink.process.spec.ts` starts a child process
running the production `HttpDiagnosticsModule` behind a `node:http` server, with its standard
output a real pipe, and sends it real HTTP requests. It closes the pipe's read end and checks
that the child keeps answering. It stops reading (POSIX only, since Windows pipes block) and
checks that 6,000 requests are answered while held bytes stay within the bound, then resumes
and checks that records flow again and that records received plus records dropped equal
requests made. The child process is reaped after each test
([results](deployment-mock.md#http-diagnostics-writer-local-verification-2026-11-26)).

**Limitations.** Records go to standard output only: there is no retention, shipping, sampling or
rate limit here, which is the runtime's job (Docker's log driver in the mock). Records are lost
while standard output's reader falls behind (beyond 64 KiB in flight), after it fails, and after
shutdown, with nothing in the output to say so. A request id with no record does not mean the
request never reached the API. Where Node writes standard output synchronously (files, POSIX
terminals, Windows pipes), a stalled reader stalls the process. A process killed
mid-request writes no record for it. Requests rejected by Node's HTTP parser before Express sees
them (malformed request lines, oversized headers) get neither an id nor a record. `route` is
`unmatched` for everything no controller route matched, including Swagger UI's static assets
under `/api/docs`. Durations end when the response is handed to the connection, not when the
client has received it. No metrics, traces or OpenTelemetry.

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
- Document reviews ([ADR 0014](decisions/0014-document-review.md)): one per file version (unique,
  with a foreign key to that exact version), only of the document's latest file under the current
  revision (a trigger share-locks the document and the instruction), never updated; a CHECK pairs
  a rejection with a bounded, non-blank reason. Every change advances the document's `version`
  by exactly one, and a deferred constraint trigger on both tables requires it to equal uploads
  plus reviews at commit.

### Reads scoped below the voyage: the trade string

`GET /api/voyages/:voyageId/trade-string` is the first read of a voyage child:

1. Guards and the UUID parameter check, as for the voyage itself.
2. **One query** loads the voyage by id `AND accessibleVoyages(principal)`, selecting only its
   contracts' positions and the counterparties' organizations and roles. No match (missing or not
   a participant) is the same 404 as `GET /voyages/:voyageId`.
3. The stored contracts go through the domain rules (`toLinearTradeString`). A chain that breaks
   them is a data error: it is answered with a generic 500 and recorded on the request's
   lifecycle record, never shown as valid.
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
version = ANY($expected)`, on the document's version, which counts reviews too), the version row,
   the audit event and the response.
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
damage to the directory; a download then answers a recorded 500, and the version must be restored
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

### Document review: decisions on exact file versions

Operators of the buyer approve or reject the latest file of a document
([ADR 0014](decisions/0014-document-review.md)). A review carries no file, so it is a plain
transaction in the documents service:

1. Guards, path parameters, the closed body (`ReviewDocumentVersionRequestSchema`: approve, or
   reject with a reason) and `If-Match` (428 without one, or with `*`).
2. The role (403), the contract through `CounterpartyContracts` (404), the buyer side (403), then
   `InstructionRevisions.lock`: the instruction is share-locked until commit, so a revision cannot
   supersede the one being reviewed meanwhile, and one given while the review waited is seen (409).
3. One conditional statement, `advanceForReview`: `UPDATE documents SET version = version + 1`
   where the version is the one the client read, the file version is still the latest, and it has
   no review yet. Nothing changed? Only then is the document read, to say why: 404 (no such
   document or version), 412 (it changed), 409 (replaced, or already decided).
4. The review row, `DOCUMENT_VERSION_REVIEWED` with the file's SHA-256 and the new version, and
   the response, read before commit so its `ETag` is exactly the version this review produced.

The document's `version` is the entity tag of both uploads and reviews: any upload or review
moves it, so a replacement chosen before a decision, a decision on a replaced file, and two
decisions on the same file all end in one success and one 412. Integration tests make each race
real by holding the document's row lock (or the instruction's, or a table lock on
`document_reviews` to stop a review between its share lock and its insert) until every contender
is blocked in PostgreSQL.

### The voyage timeline: audit events, read

`GET /api/voyages/:voyageId/timeline` serves the audit trail
([ADR 0009](decisions/0009-transactional-audit-events.md)) as a read-only timeline, newest
first, a page at a time:

1. Guards, the voyage id, and the query (`limit` 1–50, default 20; `cursor` only as the API
   issued it, else 400 before anything is read, whatever the voyage).
2. In one `REPEATABLE READ` transaction, the voyages module resolves the reader's scope
   (`CounterpartyContracts.listForVoyage`: no participation is the voyage's 404) and the audit
   module reads the page within it (`AuditTimeline.page`). Visibility and events therefore come
   from one snapshot.
3. The scope is applied in the `WHERE` clause: `VOYAGE_CREATED` and
   `VOYAGE_TRADE_STRING_CONFIGURED` (without its parties) for every participant, notice,
   instruction and document events only when their payload's `contractId` is one of the reader's
   contracts now. Hidden events never shorten a page, decide whether another exists, or end up in
   a cursor. An action without a rule (a future one) stays hidden.
4. Each entry is built from an allowlist per action (Zod objects that drop every other key):
   who acted, for which organization, when, and identifiers. Instruction contents, file names,
   checksums and rejection reasons stay in the panels that own them. The cursor is the last
   served `(occurredAt, id)`, base64url; a hand-made one moves only within the bearer's scope.

### The Action Center: what each organization owes

`GET /api/action-items` serves the organization's open actions across voyages, derived on every
request and never stored ([ADR 0017](decisions/0017-action-center.md)):

1. Guards, then the query (`type`, `overdue=true`, `limit` 1–50, default 20; `cursor` only as the
   API issued it, else 400 before anything is read). The organization comes from the session
   alone; viewers and operators read the same queue.
2. In one `REPEATABLE READ` transaction: the contracts in scope on every voyage
   (`CounterpartyContracts.listAcrossVoyages`), then one statement per kind of fact, each from
   the module that owns it (`IssuedNotices`, `CurrentRevisions`, `LatestDocumentVersions`), with
   history excluded in SQL. The clock is read once, after the reads.
3. `contract-facts.ts` adapts the readers' outputs; the pure rules project them and cut the page
   in memory. The response is bounded by `limit`; the loading grows with the organization's
   current work. No total.

The web page that reads it, and the links into voyage pages, are described under
[Data access](#data-access).

### Live updates: voyage event streams

`GET /api/voyages/:voyageId/events` is a server-sent-event stream that tells the voyage page
_that_ something changed, never _what_ ([ADR 0015](decisions/0015-voyage-event-streams.md)).
Today it carries `NOTICE_ISSUED`, `NOTICE_ACKNOWLEDGED`, `DOCUMENTARY_INSTRUCTION_REVISED` (the
first instructions and every revision), `DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED`,
`DOCUMENT_VERSION_UPLOADED` (a first file or a replacement) and `DOCUMENT_VERSION_REVIEWED` (an
approval or a rejection).

- **Opening.** Guards (401), the voyage id (400), participation through
  `CounterpartyContracts.listForVoyage` (the voyage's 404). The stream then subscribes to
  `VoyageEventBus` and only after that writes `READY`, so a client that reads after `READY`
  misses nothing. Headers: `text/event-stream`, `no-store`, `X-Accel-Buffering: no`; `retry` is
  5 s.
- **Publishing.** `NoticesService`, `DocumentaryInstructionsService` and `DocumentsService`
  publish `{ type, voyageId, contractId }` after `$transaction` resolved, never inside it:
  rollbacks, refusals, failed preconditions (412) and the 409 or 412 of a lost race publish
  nothing. `publish` only schedules deliveries and is wrapped, so a failure is logged and the
  committed command still answers 201/200. An upload publishes once its commit step has
  returned, outside the compensation around it: a failure to publish never removes the bytes a
  committed version names, and an upload whose commit has an unknown outcome (kept for
  reconciliation) publishes nothing.
- **Delivering.** Before writing to a stream, `VoyageEventStreams` re-reads its session
  (`SessionPrincipals.refresh`) and the organization's contracts on the voyage. A session that
  expired or was revoked, a user now in another organization, or an organization no longer in
  the voyage closes the stream; a change under a contract the organization is not a party to
  now is dropped for it. Only `{"type": ...}` is written.
- **Idle streams** are re-checked the same way every 30 s and sent a heartbeat comment. That is
  the revocation window: a stream whose session ends while nothing is delivered stays open, with
  heartbeats only, for up to 30 s plus one round of checks.
- **Bounds.** Pending signals are coalesced per contract and type while a check runs; a stream
  that would hold more than 32 contracts' worth, or whose client stops reading (socket buffer
  full), is closed. Client disconnects unsubscribe at once; shutdown ends every stream.
- **Diagnostics.** A stream's one lifecycle record is written when it ends: `aborted` when the
  client left, `completed` when the server ended it normally (session or participation gone,
  shutdown), `stream_failed` when a check failed or a bound above cut it off
  (`PendingSignalLimit`, `ClientNotReading`). Nothing is recorded per event or heartbeat. Each
  stream keeps its own request's context: the shared recheck timer and bus deliveries run
  outside any request's context, so a failure is never attributed to the request that started
  the timer or published the change.
- **Best effort.** The bus is in this process's memory: no durable replay, no `Last-Event-ID`,
  and no delivery across instances. Clients reconcile through REST on every `READY` and poll
  while disconnected.

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

### Setting up a trade string (`POST /api/voyages/:voyageId/trade-string`)

The one-time setup of a new voyage's chain ([ADR 0016](decisions/0016-initial-voyage-setup.md)),
offered on the trade-string card to operators of the exporter (`TradeStringSetup`,
`useConfigureTradeString`: one plain POST, never retried, its outcome ignored once its session
has ended; 200 and 409 refresh the voyage's detail prefix and the lists). The body names
organizations in order, exporter first; no version header is
needed. After the guards, the closed body schema and a malformed-header check (400), and the
role (403), one interactive transaction:

1. reads the voyage scoped by `accessibleVoyages` (404), then locks its row `FOR NO KEY UPDATE`,
   so competing setups queue;
2. reads the session again (`SessionPrincipals.refresh`, 401) and checks the role (403) and the
   current organization's participation (404, or 403 when it is not the exporter) as they are
   now. The lock serializes setups only, not sign-outs or role changes;
3. refuses, in this order, a voyage with any contract (409 "already set up", also for the loser
   of a race), one not `PLANNED` (409), one with participants besides its exporter (409);
4. evaluates `If-Match` / `If-None-Match` only if sent (412; the trade string always exists and
   has no entity tag);
5. checks the chain (400 per field: exporter first, known organizations, `validateTradeString`),
   inserts the participants and contracts, reads the string back through the read model and
   records `VOYAGE_TRADE_STRING_CONFIGURED`.

`200` with the `TradeString`. Any failure rolls everything back. A partial unique index allows
one setup event per voyage. Nothing is published to event streams.

### Configuration

`loadConfig()` validates the environment with Zod at startup and lists every invalid variable at
once. Configuration is injected via the `APP_CONFIG` token; nothing else reads `process.env`.
`DOCUMENT_STORAGE_DIR` (where document bytes are kept) defaults to `var/documents` under the
working directory outside production and is required in production.
`PORTFOLIO_DEMO_WRITE_PROTECTION` (`disabled` by default) and `PORTFOLIO_DEMO_WRITE_ALLOWANCE`
(default 200, only valid when enabled) turn on the portfolio demo's write budget
([ADR 0021](decisions/0021-portfolio-demo-write-budget.md)): every business command's service
calls `DemoWriteBudget.admit()` once, after its access and precondition checks and before its
first write or storage staging; one conditional upsert on `demo_write_budget`, on a pool of its
own, admits it or answers 429 (`/problems/demo-write-budget-exhausted`). Only the portfolio
launcher sets them. `HTTP_REQUEST_LOG` (`enabled` by default, or `disabled`; anything else is a
startup error) turns the HTTP lifecycle records on or off; `X-Request-ID` is returned either way
([HTTP diagnostics](#http-diagnostics)). The demo launchers drop a caller's value, so their API
always keeps the default.

## Frontend (apps/web)

```
src/
  app/          App, AppProviders, query-client, routes, layout, theme
  features/
    auth/
      api/          sign-in, sign-out, current user
      session.ts    session query, sign-in/sign-out transitions, protected-data purge,
                    session epochs and transition listeners
      session-sync.ts  cross-tab identity sync (BroadcastChannel)
      components/   RequireAuth (protected-route boundary), UserMenu
      pages/        SignInPage
    voyages/
      api/          fetch functions + query option factories (query keys live here),
                    including reference data (vessels, commodities, ports) for the form, and
                    the voyage's event stream (EventSource)
      domain/       presentation rules for the domain (status labels, role grouping,
                    trade-string steps in contract order, notice states, timeline wording),
                    what to offer whom
      hooks/        useCreateVoyage, useIssueNotice, useAcknowledgeNotice,
                    useSubmitInstruction, useAcknowledgeRevision, useUploadDocument,
                    useReviewDocument, useDownloadDocument: mutations and what happens after
                    them; useVoyageLiveUpdates: the event stream, invalidation and polling;
                    useRevealLinkedRecord: reveal requests and focus for a record link
      components/   feature UI (table, filter, facts card, trade string, notices, participants,
                    timeline, the linked record's status)
      navigation/   record links (ADR 0017): recordLinkPath/parseRecordLink (the address),
                    resolveRecordLink (against fetched records), the linked-record and
                    reveal-request contexts, useDisclosure (history that opens per request)
      pages/        route components; compose data hooks and components
      routes.tsx    the feature's routes; the app shell only composes them
    action-center/  (ADR 0017)
      api/          GET /action-items + query factories: the first page (refreshed) and the
                    later pages of one walk (keys under the scope)
      domain/       action labels, URL filters (parse, ignore unknown), item wording
      hooks/        useActionQueue: the first page kept current, later pages restarted by
                    every refresh, window focus
      components/   queue (states, pages), item card, filters
      pages/        ActionCenterPage (/actions)
  shared/
    api/        fetch wrapper: ApiError (Problem Details), ApiContractError; JSON, one-file
                multipart uploads and blob downloads
    auth/       identity context and identity-scoped query keys
    cache/      the Action Center queue's key and its invalidation, for voyage commands
    lib/        formatting (numbers, calendar dates, countries), saving a downloaded file
    ui/         generic UI: PageHeader, QueryErrorAlert, NotFoundState
  test/         MSW server, typed fixtures, renderRoute helper
```

**Rule of thumb:** code lives in a feature until a second feature needs it, and only then moves to
`shared/`. `shared/` never imports from `features/`. A feature may use another feature's
`domain/` and `navigation/` modules, never its components, and only one way: the Action Center
builds record links and names documents with the voyages feature's modules, and nothing in
`voyages/` imports `action-center/`. Voyage commands reach the queue through
`shared/cache/action-queue.ts` (its key and `invalidateActionQueue`), which both features use.

### State ([ADR 0003](decisions/0003-frontend-server-state.md))

| Kind of state       | Where it lives                                                                    |
| ------------------- | --------------------------------------------------------------------------------- |
| Server data         | TanStack Query cache (`voyageQueries.*`, `actionItemQueries.*` factories)         |
| Who is signed in    | TanStack Query too: `['session']` from `/auth/me`                                 |
| Shareable UI state  | URL (`?status=LOADING`, queue filters, record links), validated with the contract |
| Ephemeral UI state  | Component state                                                                   |
| Global client state | None yet; Zustand when a real case appears                                        |

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
  request (`postFile`). Like an instruction draft, a chosen file remembers the document as it was
  (its basis: the document's version, sent as `If-Match`, and its latest file; `If-None-Match: *`
  when there was none); a 412, or a refresh showing a change, keeps the file, says what changed
  (a new file someone uploaded, or the buyer's decision on the latest one, with its reason) and
  disables the upload until the user chooses to replace what is there now. Any failure keeps the
  chosen file and nothing is re-sent on its own; a 409 (the revision was superseded) refreshes
  the instructions. Every version shows its decision (approved or rejected, by whom, when, and
  the reason) or that it is pending or was never reviewed; both sides and both roles see them.
  Buyer operators decide on the latest file with a small form (approve, or reject with a reason
  checked by the contract's schema before sending). Choosing a decision fixes its basis the same
  way; if the document moves on, nothing is sent, the draft is kept, and the form says whether a
  new file arrived (the draft can move onto it) or someone else decided (final: the draft can
  only be dismissed). A 412 or 409 on a review refreshes the documents, a 409 the instructions
  too. The cache keeps the newest document by its version, never by its file number: a decision
  changes the document without adding a file.
  Downloads are `fetch`ed through `sendForCurrentSession` and handed to the browser as a blob
  (`saveFile`), so a 401 signs out as elsewhere, and a download that arrives after the identity
  changed is not saved. The section degrades on its own: the revision above it stays readable.
- **Timeline** (a card at the end of the details page). An infinite query nested under the
  voyage's detail key; **Load more** passes the previous page's `nextCursor` unchanged, and every
  page request carries the query's abort signal, so an identity change cancels a page still on
  its way. A failed older page keeps what is shown and offers a retry. Read-only: entries name
  the action, when (in the viewer's zone), who and for which organization, and the contract's
  position.
- **Live updates** (`useVoyageLiveUpdates`, [ADR 0015](decisions/0015-voyage-event-streams.md)).
  Once the voyage has loaded, the page opens the voyage's event stream with `EventSource`
  (same origin, so the browser sends the session cookie). Each signal reads again exactly the
  queries of the current identity scope it concerns (`REFRESHED_BY`): a notice signal the
  voyage's notices and its timeline, an instruction signal its documentary instructions and its
  timeline, a document signal its documents and its timeline. Requests are sent after the
  signal: a read already on its way is cancelled rather than joined, since it may have been
  answered from before the change (on the first load, invalidating alone would join it). At most
  one refresh runs; signals arriving meanwhile add what they concern to one pending set, read by
  a single refresh after it, so mixed signals lose nothing and each resource is read once. Every
  connection starts with `READY`, which reads all four: that is how the page catches up after a
  reconnect, since nothing is replayed. Refreshes only replace cached data: an open instruction
  draft, a chosen file and a decision being made keep their content and their basis (the
  document version sent in `If-Match`, and for a decision the exact file version), the form shows
  what changed beside it, and nothing is written, retried or downloaded from the stream (while
  the draft's own write is on its way, its response, not a refresh, decides). The document list
  is replaced as read; the commands' own cache writes still keep the newest document version. The connection belongs to the voyage and to the session
  epoch it was opened in: unmounting or moving to another voyage closes it, and so does the
  first transition that ends the epoch (`subscribeToSessionTransitions` in `session.ts`, called
  synchronously as the transition starts). Every callback checks the epoch too, so a late event
  from a closed stream does nothing, including after the same user signed out and back in, or
  after session checks went to someone else and back. The auth boundary remounts the page for
  the new session, which connects anew. While no stream is live (connecting, the browser
  reconnecting, no `EventSource`), notices, instructions, documents and timeline are polled every 30 s through
  `refetchInterval` (paused while the tab is hidden; `staleTime` alone never refetches). If the
  browser gives up on a stream (the server refused it), a new one is opened after 5 s, 15 s,
  then every 60 s; one timer at most.
- **Action Center** (`/actions`, [ADR 0017](decisions/0017-action-center.md#the-web-slice)). Per
  set of filters, under the identity scope: a first-page query (`actionItemQueries.list`, under
  `actionQueueKey`) and, after it, a walk of later pages (`actionItemQueries.page`, keyed by the
  walk's number and cursor), each page validated with `ActionItemPageSchema` and sent with the
  query's abort signal (`useActionQueue`). Filters live in the URL (`?type=…&overdue=true`),
  parsed with the contract's enum: unknown or repeated values are ignored and reported, with a
  way to remove them from the address. A filter change is a new key, so it starts from the first
  page and never shows another filter's items. **Load more** sends `nextCursor` unchanged; a
  failed page keeps the items shown. Nothing is cached once unobserved (`gcTime: 0`), so coming
  back to the page starts from the first page. No count is shown. Items link to their exact
  record; nothing on the page sends a command, and viewers read the same queue.
  **Freshness:** only the first page is ever read again: every 30 s through `refetchInterval`
  (skipped while the tab is hidden; offline, the read waits and nothing is sent), when the tab
  becomes visible or the window regains focus, when the connection returns, on **Refresh**, and
  when a voyage command succeeds in the same session (`invalidateActionQueue`, active queries
  only). Triggers share a read already on its way; a command's invalidation replaces it, since its
  answer may predate the command, even during the first page's load (the queue's reads on screen
  are cancelled explicitly, synchronously, before invalidating: TanStack shares an in-flight read
  of a query without data otherwise). Each successful read is a page of its own
  (`structuralSharing: false`) and ends the walk from the previous one: later pages disappear,
  and a page still on its way loses its observer, is cancelled, and is never appended. A failed
  read keeps the items shown, with an error and "last updated" at the API's time of the last
  successful read (`generatedAt`); the offline state is said too. No stream: SSE stays per voyage.
- **Record links** (`features/voyages/navigation/`). `/voyages/:voyageId?open=…&contract=…`
  plus the target's identifiers. The voyage page parses them with the contract's target schemas
  (a malformed link names nothing), then resolves them against the records it fetched once the
  queries the kind needs have answered; every identifier must match, and no newer revision or
  file is chosen in place of the one named. A status above the sections says what the record is
  now (waiting, done since, superseded or replaced history, not found, malformed, or waiting for
  a failed section's retry). The section holding it marks its container through a context
  (`LinkedRecordContext`). Revealing it is a numbered request (`useRevealLinkedRecord`): a link
  not seen before, or **Show it**. While a request is pending (`RevealRequestContext`), every
  collapsed history holding the record opens for it once (`useDisclosure`), however the user left
  it; focus then moves to the container, but only once no collapsed history (`data-collapsed`)
  encloses it and focus has actually landed there, which fulfils the request. Refreshes are not
  requests: history the user folded stays folded, even when a refresh moves the record into it,
  and focus stays where it is. Opening a link sends nothing and starts no decision; drafts and
  their bases are untouched.

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

| Layer            | Tool                       | Fakes                          | Purpose                                                          |
| ---------------- | -------------------------- | ------------------------------ | ---------------------------------------------------------------- |
| Contract schemas | Vitest                     | none                           | Wire-format rules                                                |
| API unit         | Vitest                     | none (pure functions)          | Mapping, ordering, precision, chain rules, config                |
| API integration  | Vitest + supertest         | none: real Nest, real Postgres | Endpoints, auth, roles, transactions, docs                       |
| Web              | Vitest + RTL + MSW (jsdom) | network only                   | Pages through real router, cache and client                      |
| End-to-end       | Playwright (Chromium)      | injected transport faults only | Smoke: sign-in, live updates, tabs, stream faults, Action Center |

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
Document reviews are tested the same way: approval and rejection with server-side actors and
times, closed bodies (no reason on an approval, none missing, blank or over 1000 characters on a
rejection, no client-chosen reviewer or time), who may decide (403 for viewers and the seller,
equal 404s for everyone else) and who reads decisions, every precondition outcome, replaced and
already-decided versions, superseded revisions, a replacement after a rejection and the history
it leaves (decisions on their versions, events numbered by the document version), a forced audit
failure (nothing recorded, version unchanged), and real races: two reviews, a review and a
replacement in both orders (the losing upload's bytes removed), and a revision of the instructions
before and during a review. The migrations are tested against a populated scratch database: every
earlier migration, documents with several versions written as the API wrote them, the backfill,
reviews and replacements on the migrated rows, and no drift from the Prisma schema.
The timeline is tested against events written through the API: who sees which events (each
counterparty its own contracts', service providers only the creation, viewers as their
operators, outsiders the voyage's 404, current participation only), exactly the fields each
entry carries and none of the payload's contents, pages that stay full however many hidden
events lie between, events with equal times split across pages without loss or repetition,
cursors that stay within the bearer's scope, and malformed queries.
Voyage event streams are tested over real HTTP connections (a small SSE client in
`test/support/event-stream.ts` that sends the session cookie as a header), asserting the bytes
each connection received: who is told (both counterparties, operators and viewers alike; not a
party to the voyage's other contract, a service provider, or the same organizations on another
voyage), nothing for refused commands, nothing when the audit write rolls the command back,
exactly one acknowledgement when two race on a held row lock, a committed command that still
succeeds when publishing fails (a bus made to throw), streams closed without a signal after a
sign-out, and closed while idle once their session is revoked or expires, their user changes
organization or their organization leaves the voyage, server-side cleanup on client disconnect,
and every stream ended on shutdown. Proving that a stream received _nothing_ uses barriers: a
later signal the stream does receive (signals arrive in publication order), or, for a stream
that can receive none, two heartbeats after the command was answered. Unit tests cover what is
hard to provoke over HTTP: coalescing while a check runs, the pending-signal limit, a client
that stops reading, and a check that fails.

A small end-to-end suite (`e2e/`, `pnpm test:e2e`, never part of `pnpm check`) runs Chromium
against the production web build served by `vite preview` (whose same-origin `/api` proxy is the
development one), the compiled API and a dedicated `tradeflow_e2e` database, all started by the
run on ports of their own and released afterwards, on failure too. It signs in through the form
and survives a reload on the HttpOnly cookie; carries a notice and its acknowledgement between
two browser contexts over the browser's own `EventSource`; signs two tabs of one context out
and back in (the same user, then another), checking that both tabs follow, protected content
disappears, and each old stream is closed by the page and at the API before a new one opens; and
recovers from transport faults. Causality is read off the browser's own network log (DevTools
protocol, observation only): the refetch follows the stream message, nothing was refetched
between a quiet point and the message, and moving the page's timers past the 30 s fallback poll
interval sends nothing while the stream is live. Faults are injected only by a transport proxy
between the web server and the API, labelled as such: a 503 it answers itself, stream requests
it holds, and streams it ends cleanly. EventSource, authentication, data and stream messages
are never faked. A probe on the browser's native `EventSource` records what Chromium actually
does: a 503 leaves it `CLOSED` (so the page must reconnect itself), and a dropped stream reports
`CONNECTING` and reconnects by itself after the server's `retry`, sending the cookie again.
The Action Center (`action-center.spec.ts`, [ADR 0017](decisions/0017-action-center.md#browser-coverage))
is driven between a seller's and a buyer's contexts through the voyage page's own forms: each
queue learns of the other organization's command by its 30-second interval (the page's clock
moved past it, the read confirmed in the network log, never Refresh), each item opens its exact
record focused below the sticky header without sending a write, a kept link to a replaced file
version opens it as history (and **Show it** reopens every fold around it), and viewers, a
surveyor on the voyage and an outside organization get no command or no action.

What that suite does not establish: anything over HTTPS (the run is plain HTTP on `127.0.0.1`,
so the `Secure` attribute and the `__Host-` cookie name production uses are never exercised),
other browsers (Firefox and WebKit, whose `EventSource` and cookie handling may differ), layout
beyond the Action Center's checks (focus in the viewport and clear of the header, no horizontal
scrolling at 390 px; the responsive trade string is not checked), real window focus and
visibility changes, the browser's own `datetime-local` and file pickers,
downloads, or anything beyond notices that the stream does not carry yet.

The demo walkthrough (`e2e/demo/`, `pnpm demo:verify`) is a separate Playwright project with
one test, not part of the suite: it starts a demo with the same code as `pnpm demo` (its own
PostgreSQL container, all migrations, the real seed, production sign-in admission) and drives
the fresh-voyage walkthrough through the UI. CI runs it as the `demo` job, beside `verify` and
`e2e`; [MVP status](mvp-status.md) records which commits each job has passed on.

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
else. Reviews add: what each side and role is offered, the decision and `If-Match` each review
sends, a rejection refused before sending without a reason, conflicts that tell a new file from
someone else's decision (for the reviewer, whose draft is kept, and for the seller, whose chosen
file is kept), a superseded revision, the cache keeping the newest document by version, and
decisions answered (200, 409, 412 or 401) after the same user signed out and back in, after
session checks went to someone else and back, or after another tab did. jsdom's own `File` and `FormData` cannot be sent by Node's `fetch`, so the test setup puts
Node's on the global object (a `FormData` built from a `<form>` stays jsdom's).
The timeline card is tested for every kind of event and its wording, the empty state, pages
loaded with the previous cursor, a failed first load and a failed older page, and pages still on
their way when another tab signs in as someone else (aborted, never shown, never used as a
cursor). Live updates drive a fake `EventSource`: the stream opens only once the voyage has
loaded (never for a voyage that answered 404), `READY` and each change refetch the notices and
timeline of the current identity only (nothing else, and not another identity's cached data),
with reads of their own even while the first reads are still on their way,
the buyer sees the seller's new notice and its acknowledgement appear, unknown messages are
ignored, signals arriving during a refresh cause one more refresh rather than one each, polling
runs while the stream is not live and stops once it is (and pauses while the page is hidden), a
reconnect reads again, a stream the browser gave up on is reopened after growing delays, the
stream closes on unmount and moves with the voyage, and late events from a closed stream do
nothing after a sign-out, after the same user signs back in, and after session checks went to
someone else and back. `session.ts`'s transition listeners are unit-tested on their own.
The Action Center is tested through the same route tree: the protected route and its navigation
item, all four kinds of action and the fields each shows or leaves out, filters through the URL
(reload, back and forward, unknown and repeated values), the filters and cursor each request
sends, a filter change that starts from the first page without showing the previous filter's
items, loading, empty, first-page and next-page failures, Refresh from the first page, viewers,
malformed first and later pages, and pages still on their way when another tab signs in as
someone else. Its freshness is tested on controlled timers with request barriers: polling, its
pause while hidden or offline, reads on visibility, focus and reconnection, triggers that share a
read on its way, nothing left reading after the page is left or the session replaced (another
identity, or the same user signed back in), a refresh that restarts the walk and continues from
the new cursor, a page asked for before a refresh that answers after it and is not appended, a
deadline passing with nothing written (overdue, and the overdue filter), a failed refresh and its
recovery, an invalidation that replaces a read on its way without fetching another filter, and a
command that succeeds after the queue is shown. Each command's tests check that a success
invalidates its session's queue without fetching it, and that a completion for an ended session
(signed out and back in, or session checks to someone else and back) leaves it alone. Record
links are tested on the voyage page: located after delayed loading, the
status for each state of each kind, superseded revisions, replaced files and documents of
superseded revisions opened as history, mismatched, missing and malformed links that open
nothing in their place, a failed section retried, focus moved once per link (and kept through a
refresh with a draft open), history the user folds again, history reopened for another earlier
revision or version on the same page and by Show it (both folds around a replaced file of a
superseded revision, and only the folds a new target needs), with a draft kept on its version,
the path from the queue, and no command sent from any link. The link codec and URL filters are
unit-tested.

## Operational concerns (current state)

**S3 increment (2026-10-31):** `DOCUMENT_STORAGE_DRIVER=s3` selects the private object adapter;
the default remains local. Logical promotion, failure compensation and the paired recovery
protocol are recorded in [ADR 0019](decisions/0019-s3-document-storage.md). The
[runbook](storage-recovery.md) provides read-only reconciliation and object export/import.
Backup execution, private bucket provisioning and a hosted-provider rehearsal are operational
responsibilities; no cloud environment is configured here. Older filesystem-specific descriptions
above still describe the default adapter.

| Concern      | Today                                                                                        | Planned                                              |
| ------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------- |
| Health       | `GET /api/health` checks DB; `/api/health/live` checks process liveness                      | Hosted readiness/liveness monitoring                 |
| Logging      | `X-Request-ID`; one JSON record per HTTP request; service logs still plain Nest text         | Request ids in service logs, log shipping, OTel      |
| Config       | Validated env, fail fast                                                                     | Secrets manager in cloud environments                |
| Shutdown     | `enableShutdownHooks`; open event streams ended; Prisma disconnects on destroy               | —                                                    |
| Real-time    | SSE per voyage from one process; best effort, no replay; idle streams re-checked every 30 s  | Shared bus (outbox + broker) for several instances   |
| File storage | Local or private S3; reconciliation and offline paired backup/restore; manual orphan cleanup | Hosted-provider rehearsal, scheduled/offsite backups |
| Supply chain | Exact versions, lockfile, pnpm install-script allowlist, release-age quarantine respected    | Renovate, pinned action SHAs                         |

## Evolution

How later requirements land on the current structure:

| Requirement              | Where it goes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication           | **Done (M2)**: `auth` module, cookie sessions ([ADR 0007](decisions/0007-cookie-sessions.md)). In-process sign-in admission ([ADR 0018](decisions/0018-sign-in-admission.md)). Next: OIDC for SSO, a shared sign-in limit, password reset                                                                                                                                                                                                                                                                                                                                                      |
| Tenant isolation         | **Done (M2)**: every voyage query `AND`s `accessibleVoyages(principal)` ([ADR 0006](decisions/0006-participation-based-access.md)). Next: Postgres RLS as defence in depth                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Trade string             | **Started (M4)**: `trade_contracts` as edges, chain rules in the domain, topology readable by every participant ([ADR 0010](decisions/0010-trade-string-visibility.md)). Counterparty-only contract ids since M5. Next: recording it through the API (validated and audited in one transaction); counterparty-only contract details                                                                                                                                                                                                                                                            |
| Notices                  | **Started (M5)**: ETA notices, counterparty-only, `ISSUED → ACKNOWLEDGED` by conditional update, overdue derived ([ADR 0011](decisions/0011-counterparty-notices.md)). Next: further notice types, then notifications of new and overdue notices (outbox + jobs)                                                                                                                                                                                                                                                                                                                               |
| Write authorization      | **Started (M3)**: `VIEWER` / `OPERATOR` on the user, checked in the command service ([ADR 0008](decisions/0008-user-roles.md)). Next: participant-role rules for commands on existing voyages; a membership table when users act for several organizations                                                                                                                                                                                                                                                                                                                                     |
| Documentary instructions | **Started (M6)**: one per contract, immutable revisions, per-revision acknowledgement by the seller, counterparty-only ([ADR 0012](decisions/0012-documentary-instructions.md)). Documents presented against them since M7. Next: presentation deadlines                                                                                                                                                                                                                                                                                                                                       |
| Optimistic concurrency   | **Started (M6)**: `version` on documentary instructions; one conditional `UPDATE ... WHERE version = ANY(...)`; `ETag`, `If-Match` (412), `If-None-Match: *`, 428 without a precondition ([ADR 0012](decisions/0012-documentary-instructions.md)). Documents since M8: one version for uploads and reviews ([ADR 0014](decisions/0014-document-review.md)). Next: the same for recording the trade string                                                                                                                                                                                      |
| Idempotency              | `Idempotency-Key` header persisted with the response for unsafe requests                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Audit trail              | **Started (M3)**: append-only `audit_events`, written in the same transaction ([ADR 0009](decisions/0009-transactional-audit-events.md)). A read-only voyage timeline, scoped per contract. Next: more actions                                                                                                                                                                                                                                                                                                                                                                                 |
| Real-time                | **Started**: an SSE stream per voyage signals notice, documentary instruction and document changes after commit, only to the contract's current counterparties, re-checked before each delivery; the client invalidates what each signal concerns and the timeline, and polls while disconnected ([ADR 0015](decisions/0015-voyage-event-streams.md)). Next: a shared bus (outbox) for several API instances                                                                                                                                                                                   |
| Background jobs / outbox | Outbox table written transactionally; a relay publishes to BullMQ (Redis)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Documents                | **Started (M7)**: PDF versions per required document of an exact revision, counterparty-only, uploaded by the seller with `If-Match`; bytes staged outside the transaction in a private local directory, compensated on failure ([ADR 0013](decisions/0013-documents.md)). Buyer review since M8: one final decision per file version, a rejection with its reason ([ADR 0014](decisions/0014-document-review.md)). Opt-in S3 storage and offline paired recovery ([ADR 0019](decisions/0019-s3-document-storage.md)). Next: hosted-provider rehearsal, pre-signed uploads, amending decisions |
| AI extraction            | `ai` module that produces _proposals_; a human approves before any business object changes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

## Production edge and AWS mock

The next increment adds non-root production containers, a Caddy same-origin HTTPS edge, explicit
proxy-address trust and separate process liveness. The local AWS mock uses private PostgreSQL
and an authenticated S3-compatible service, including a private TLS object endpoint.
[ADR 0020](decisions/0020-production-edge-and-aws-mock.md) records the design and
[deployment mock](deployment-mock.md) gives commands and limits. No AWS resources are provisioned.
