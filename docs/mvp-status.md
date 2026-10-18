# MVP status: acceptance summary

TradeFlow's original MVP is complete: all eight areas below are implemented and covered by
automated tests that passed in Linux CI. Some are complete within deliberate limits, listed
under [Limitations](#limitations). A walkthrough of every flow: [demo](demo.md).

## Verified build

| Item           | Value                                                                                                                |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Commit         | `e0f698df1491ce00c7a5b1039608c641f7e3bd1b` on `main` (2026-10-18)                                                    |
| CI run         | [GitHub Actions run 39116071881](https://github.com/AlexTikhon/TradeFlow/actions/runs/39116071881): success          |
| `verify` job   | Success: format, lint, typecheck, `pnpm test`, build                                                                 |
| `e2e` job      | Success: `pnpm test:e2e`, 9 of 9 Chromium tests, no retries                                                          |
| Runners        | `ubuntu-latest`, which resolved to Ubuntu 24.04; Node.js 24 (`.nvmrc`); PostgreSQL 18 (`postgres:18-alpine`) service |
| Upload on fail | **Skipped** in this run, because nothing failed. See [Limitations](#limitations)                                     |

Tests that ran in that run:

| Layer                   | Where                          | Files | Tests |
| ----------------------- | ------------------------------ | ----- | ----- |
| Schemas                 | `packages/contracts`           | 8     | 141   |
| API unit                | `apps/api/src/**/*.spec.ts`    | 15    | 140   |
| API on PostgreSQL, HTTP | `apps/api/test/*.int-spec.ts`  | 12    | 414   |
| Web on MSW, jsdom       | `apps/web/src/**/*.test.ts(x)` | 14    | 285   |
| Chromium end to end     | `e2e/tests/*.spec.ts`          | 6     | 9     |
| **Total**               |                                | 55    | 989   |

Documentation committed after `e0f698d` does not change this evidence. Changes to code or tests
need a new run.

## What each test layer proves

- **PostgreSQL over HTTP** (API integration). The real Nest application, booted against a real
  PostgreSQL 18 database (`tradeflow_test`), is driven through HTTP. Every response is checked
  against the shared Zod contract. This is where authorization, transactions, audit rollback,
  database constraints (hit with plain SQL), real races on held row locks, multipart uploads to a
  real storage directory, and event streams over real HTTP connections are proven. It never runs
  a browser.
- **MSW on jsdom** (web). The real route tree, providers and query cache run in jsdom. Only the
  network is faked, by MSW, and an unhandled request fails the test. `EventSource` is a fake
  driven by hand. This layer proves UI behaviour: what each role is offered, what each request
  sends (`If-Match`, `If-None-Match`), conflicts, draft and file preservation, and identity
  changes mid-request. jsdom has no layout, no real cookies and no real `EventSource`.
- **Real Chromium** (end to end). A production web build and the built API run against a fresh
  PostgreSQL database through the same-origin proxy, with real sign-in, cookies and the
  browser's own `EventSource`. Each test proves from the browser's network log that a stream
  message, not polling, refreshed the other party's page. The suite is a smoke layer: 9 tests,
  Chromium only, plain HTTP. Faults come only from a labelled transport proxy (a 503, a held or
  dropped stream).

## The eight MVP areas

The repository does not number the original MVP scope. These eight areas are the scope named
when the project started: the Milestone 1 README's "next come notices, documentary
instructions, documents, approvals and an audit trail", its roadmap's identity and trade-string
steps, and the voyages delivered in Milestone 1. Live updates, from roadmap item 5, are listed
after them because the demo relies on them.

| #   | Area                               | Status                   | Implementation                                                                                                                                                                                                                                                                                                        | PostgreSQL / HTTP                                                                                                                      | MSW / jsdom                                                                                     | Chromium                                                                                                |
| --- | ---------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1   | Voyages                            | Done                     | List with status filter, details, creation by operators (`PLANNED`, server-assigned `TF-<year>-<n>`, creator's organization as exporter); `voyages` module, Zod contract ([ADR 0005](decisions/0005-shared-zod-api-contract.md))                                                                                      | `voyages.int-spec.ts` (18), `voyage-creation.int-spec.ts` (31, incl. concurrent references, audit rollback), `openapi.int-spec.ts` (8) | `VoyageListPage.test.tsx` (6), `VoyageDetailsPage.test.tsx` (12), `NewVoyagePage.test.tsx` (19) | Voyage details page only, opened by every journey; no list or creation journey                          |
| 2   | Identity, tenant isolation, roles  | Done                     | Email and password (argon2id), server-side sessions in an `HttpOnly`, `SameSite=Strict` cookie; participation-scoped queries; `VIEWER` and `OPERATOR` checked per command ([ADR 0006](decisions/0006-participation-based-access.md), [0007](decisions/0007-cookie-sessions.md), [0008](decisions/0008-user-roles.md)) | `auth.int-spec.ts` (17); an outsider-404 test and viewer refusals in every feature's file; unit: password, session cookie              | `auth-flow.test.tsx` (19), `session.test.ts` (32); a viewer test in each panel                  | `authentication.spec.ts` (sign-in, reload, cookie flags), `session-tabs.spec.ts` (two tabs, two users)  |
| 3   | Trade string                       | Done, read-only          | Sale contracts as edges with database row rules and domain chain rules; topology visible to every participant, never terms ([ADR 0010](decisions/0010-trade-string-visibility.md))                                                                                                                                    | `trade-string.int-spec.ts` (23); unit `trade-string.spec.ts` (24)                                                                      | Trade-string tests in `VoyageDetailsPage.test.tsx`                                              | None                                                                                                    |
| 4   | ETA notices                        | Done                     | Seller to buyer under one contract, counterparty-only; immutable once issued; acknowledged once by conditional update; overdue derived ([ADR 0011](decisions/0011-counterparty-notices.md))                                                                                                                           | `notices.int-spec.ts` (57, incl. a race on a held lock); unit `notice-rules.spec.ts` (11)                                              | `VoyageNotices.test.tsx` (32), `local-date-time.test.ts` (39, DST)                              | `live-notices.spec.ts`: issue and acknowledge across two contexts, live                                 |
| 5   | Documentary instructions           | Done                     | Buyer to seller under one contract; immutable revisions; acknowledgement of an exact revision; one conditional statement per write with `ETag`/`If-Match` (412, 428) ([ADR 0012](decisions/0012-documentary-instructions.md))                                                                                         | `documentary-instructions.int-spec.ts` (81, incl. four real races); unit `instruction-rules`, `preconditions`                          | `VoyageDocumentaryInstructions.test.tsx` (22: 412 and refresh conflicts, drafts kept)           | `live-instructions.spec.ts` (2): give, acknowledge, revise live; a pushed revision leaves a draft alone |
| 6   | Documents                          | Done, local storage      | PDF by content, at most 10 MiB while streaming; immutable versions with SHA-256; staged outside the transaction and compensated; counterparty-only attachment downloads ([ADR 0013](decisions/0013-documents.md))                                                                                                     | `documents.int-spec.ts` (71, files on disk checked after every failure); unit `document-rules`, `local-document-storage`               | `VoyageDocuments.test.tsx` (36)                                                                 | `live-documents.spec.ts`: upload through the form, download compared by SHA-256                         |
| 7   | Approvals (document review)        | Done                     | Buyer approves, or rejects with a reason, the latest version; one final decision per file version; one document version for uploads and decisions ([ADR 0014](decisions/0014-document-review.md))                                                                                                                     | `document-reviews.int-spec.ts` (48, incl. review against replacement in both orders), `document-review-migration.int-spec.ts` (2)      | `VoyageDocumentReviews.test.tsx` (20)                                                           | `live-documents.spec.ts`: approval, replacement, rejection, history                                     |
| 8   | Audit trail                        | Done, read-only timeline | Append-only `audit_events` written in the command's transaction; a cursor-paginated timeline, scoped per contract, identifiers only ([ADR 0009](decisions/0009-transactional-audit-events.md))                                                                                                                        | `voyage-timeline.int-spec.ts` (29); a forced audit failure rolls back each command, in each feature's file                             | `VoyageTimeline.test.tsx` (8)                                                                   | Timeline entries asserted in the three `live-*` tests                                                   |
| +   | Live updates (from roadmap item 5) | Done, best effort        | One SSE stream per voyage; type-only signals after commit, to current counterparties, re-checked before delivery and every 30 s; the page refetches over REST, and polls while disconnected ([ADR 0015](decisions/0015-voyage-event-streams.md))                                                                      | `voyage-events.int-spec.ts` (29, real HTTP streams); unit `voyage-event-streams`, `voyage-event-bus`                                   | `VoyageLiveUpdates.test.tsx` (30, fake `EventSource`)                                           | The three `live-*` tests; `stream-recovery.spec.ts` (3: drop, 503, catch-up); `session-tabs.spec.ts`    |

Numbers in brackets are test counts from the verified run. Not in the MVP, and not started:
recording trade strings or adding participants through the API, further notice types,
notifications, deadlines and tasks, amending decisions, object storage and AI-assisted
extraction ([README](../README.md#roadmap)).

## Limitations

- **Participants and contracts come from the seed.** No API or screen adds a participant,
  invites an organization or records a trade string. A voyage created in the app has only its
  creator's organization, as exporter, and therefore no contracts. Every bilateral flow (notices,
  instructions, documents, reviews) needs a seeded voyage, or rows written directly into the
  database, as the Chromium tests do for their own scenarios.
- **One API instance.** The event bus is in process. A second API instance would not receive the
  other's signals, and nothing coordinates several.
- **Best-effort live updates.** Signals are not stored, carry no ids and cannot be replayed. A
  signal lost while a stream is down is made up for by the refetch on every (re)connection and by
  30-second polling while disconnected. REST stays the source of truth.
- **Local document storage.** Bytes live in a private local directory (`DOCUMENT_STORAGE_DIR`).
  There are no backups, no object store and no virus scanning. Orphaned bytes are logged and
  removed by a manual procedure ([architecture](architecture.md#operational-concerns-current-state)).
- **Chromium over plain HTTP.** The end-to-end suite runs Chromium only, on `127.0.0.1` over
  HTTP. The production cookie's `Secure` attribute and `__Host-` name, other browsers' cookie and
  `EventSource` behaviour, layout, the native date-time and file pickers, and how the browser
  saves a download are not covered.
- **The failure-artifact upload has not been exercised.** CI is configured to upload
  `e2e/.output/` as `e2e-diagnostics` when the e2e suite fails (hidden files included, cookie- and
  trace-bearing paths excluded, a missing upload failing the step). In the verified run the suite
  passed, so the step was skipped. A green run says nothing about whether that upload works; only
  a failing run will.
- **Other known gaps:** no sign-in rate limiting or lockout, no SSO, no password reset
  ([ADR 0007](decisions/0007-cookie-sessions.md)). Seeded notice times are relative to when the
  seed ran, so their awaiting, overdue and acknowledged states drift until the next seed.
- **The demo was not run by hand** for this summary. Its steps were checked against the code and
  the tests above ([demo](demo.md)).
