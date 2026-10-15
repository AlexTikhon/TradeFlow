# Architecture

This document describes how TradeFlow is built today and how it is meant to grow. Decisions with
meaningful alternatives are recorded as ADRs in [decisions/](decisions/).

## System context

```
 Browser ──▶ Web SPA (Vite build, static files)
                │ fetch /api/*  (same origin; Vite proxies in development)
                ▼
            API (NestJS, single process) ──▶ PostgreSQL 18
```

There is one deployable backend, one database and one static frontend. Nothing else is needed for
the current scope: no cache, no queue and no object store. Each of those arrives with the feature
that needs it (see [Evolution](#evolution)).

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
  common/http/                  ProblemDetailsFilter, ZodValidationPipe, OpenAPI wiring
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
    voyages/
      voyages.controller.ts     HTTP only: parse input, call service, map "missing" to 404
      voyages.service.ts        use cases (queries today), each taking the Principal
      voyage-access.ts          accessibleVoyages(principal): the one visibility predicate
      voyage.read-model.ts      Prisma select shapes + row → contract mapping
```

### Module boundaries

Each domain module owns its controller, services and persistence access. Rules that keep
extraction possible later:

- A module talks to another module only through that module's exported providers, never by
  querying the other module's tables directly. (No cross-module calls exist yet.)
- Shared code lives in `common/` (HTTP plumbing) or `infrastructure/` (technical adapters) and holds
  no domain rules.
- **No generic repository layer.** Prisma already is a typed data-access layer; wrapping it in
  `Repository<T>` would add indirection without isolating anything. Each module keeps its queries
  close to its use cases. The `*.read-model.ts` file plays that role for reads: it declares
  exactly which columns a query loads, so new columns are never exposed by accident.

The `auth` module owns identity: it reads `users` (with their organization) and owns `sessions`.
Other modules depend only on what it exports: the `Principal` type and the
`@CurrentPrincipal()` / `@Public()` decorators. There is still no `organizations` module, because
nothing manages organizations on their own yet.

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
   exist" are the same empty result and the same 404.
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
   so internals never leak. An integration test asserts this.

5. **Caching.** Every `/api` response carries `Cache-Control: no-store`: responses depend on who
   is signed in, so no browser or proxy may keep them.

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
- Foreign keys use `RESTRICT` except voyage → participants (`CASCADE`), so reference data cannot be
  deleted out from under a voyage.

### Configuration

`loadConfig()` validates the environment with Zod at startup and lists every invalid variable at
once. Configuration is injected via the `APP_CONFIG` token; nothing else reads `process.env`.

## Frontend (apps/web)

```
src/
  app/          App, AppProviders, query-client, routes, layout, theme
  features/
    auth/
      api/          sign-in, sign-out, current user
      session.ts    session query, switchIdentity, protected-data purge
      session-sync.ts  cross-tab identity sync (BroadcastChannel)
      components/   RequireAuth (protected-route boundary), UserMenu
      pages/        SignInPage
    voyages/
      api/          fetch functions + query option factories (query keys live here)
      domain/       presentation rules for the domain (status labels, role grouping)
      components/   feature UI (table, filter, facts card, participants)
      pages/        route components; compose data hooks and components
      routes.tsx    the feature's routes; the app shell only composes them
  shared/
    api/        fetch wrapper: ApiError (Problem Details), ApiContractError
    auth/       identity context and identity-scoped query keys
    lib/        formatting (numbers, calendar dates, countries)
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
  (`['protected', '<userId>:<organizationId>', 'voyages', 'list', filters]`), so future
  mutations can invalidate precisely and data never crosses identities (see below).
- The details page validates the route parameter before fetching. A malformed id renders "not
  found" without a network request.

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
- **Sign-out** acts locally first (abort, purge, go to `/sign-in`) and then revokes the session on
  the server, so nothing from the old identity remains on screen even if the network is down.
- **Session end detected by the server.** A 401 on a query of the _current_ identity means the
  session expired or was revoked. The client signs out locally. A late 401 from an earlier
  identity's request is ignored.
- **Other tabs.** Tabs share cookies, so a sign-in or sign-out in one tab changes every tab's
  identity. Tabs notify each other on a `BroadcastChannel`. A receiving tab purges its protected
  data immediately and resets the session query to "unknown" until the server answers. The
  session is also re-checked whenever a tab regains focus.

### Presentation details that are correctness issues

- Quantities stay decimal strings end to end and are formatted with
  `Intl.NumberFormat.format(string)`; they never pass through a float.
- Calendar dates (`YYYY-MM-DD`) are formatted with `timeZone: 'UTC'`. Otherwise a user west of
  Greenwich sees the laycan start one day early. The web test suite runs in `America/Sao_Paulo` to
  keep this honest.

## Testing strategy

| Layer            | Tool                       | Fakes                          | Purpose                                      |
| ---------------- | -------------------------- | ------------------------------ | -------------------------------------------- |
| Contract schemas | Vitest                     | none                           | Wire-format rules                            |
| API unit         | Vitest                     | none (pure functions)          | Mapping, ordering, precision, config         |
| API integration  | Vitest + supertest         | none: real Nest, real Postgres | Endpoints, auth, authorization, errors, docs |
| Web              | Vitest + RTL + MSW (jsdom) | network only                   | Pages through real router, cache and client  |
| End-to-end       | Playwright (planned)       | none                           | Critical user journeys                       |

Prisma is not mocked: a mocked ORM tests the mock. API tests are serialized against a dedicated
`*_test` database that is truncated between tests. Authorization tests sign in through the real
endpoint and assert the participation rules against real rows: shared and private voyages,
status filters, client-supplied organization ids, removed participation, and expired or revoked
sessions.

Web tests use a stateful fake of the auth endpoints, so sign-in, sign-out, identity switches and
cross-tab changes run through the real router, query client and cache. They assert, among other
things, that an in-flight request is aborted on sign-out and that a previous user's data never
appears in the DOM after a switch (a `MutationObserver` watches for it).

## Operational concerns (current state)

| Concern      | Today                                                                                     | Planned                                          |
| ------------ | ----------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Health       | `GET /api/health` checks DB connectivity                                                  | Split liveness and readiness when deployed       |
| Logging      | Nest logger; 5xx logged with stack                                                        | Structured JSON logs, request ids, OpenTelemetry |
| Config       | Validated env, fail fast                                                                  | Secrets manager in cloud environments            |
| Shutdown     | `enableShutdownHooks`; Prisma disconnects on destroy                                      | —                                                |
| Supply chain | Exact versions, lockfile, pnpm install-script allowlist, release-age quarantine respected | Renovate, pinned action SHAs                     |

## Evolution

How later requirements land on the current structure:

| Requirement              | Where it goes                                                                                                                                                                                                                           |
| ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Authentication           | **Done (M2)**: `auth` module, cookie sessions ([ADR 0007](decisions/0007-cookie-sessions.md)). Next: OIDC for SSO, rate limiting on sign-in, password reset                                                                             |
| Tenant isolation         | **Done (M2)**: every voyage query `AND`s `accessibleVoyages(principal)` ([ADR 0006](decisions/0006-participation-based-access.md)). Next: Postgres RLS as defence in depth                                                              |
| Write authorization      | **Not started.** Arrives with the first business write: participant-role rules in the domain service plus user permissions on an organization membership ([domain model](domain-model.md#6-user-permissions-are-not-participant-roles)) |
| Optimistic concurrency   | `version` column on mutable aggregates; `UPDATE ... WHERE id = ? AND version = ?`; HTTP `If-Match`/ETag                                                                                                                                 |
| Idempotency              | `Idempotency-Key` header persisted with the response for unsafe requests                                                                                                                                                                |
| Audit trail              | `audit_events` written in the same transaction as the change                                                                                                                                                                            |
| Real-time                | SSE endpoint per voyage; the client invalidates TanStack Query keys on events                                                                                                                                                           |
| Background jobs / outbox | Outbox table written transactionally; a relay publishes to BullMQ (Redis)                                                                                                                                                               |
| Documents                | S3-compatible storage, pre-signed URLs, versions in Postgres                                                                                                                                                                            |
| AI extraction            | `ai` module that produces _proposals_; a human approves before any business object changes                                                                                                                                              |
