# MVP status: acceptance summary

TradeFlow's original MVP is complete: all eight areas below are implemented and covered by
automated tests that passed in Linux CI. Some are complete within deliberate limits, listed
under [Limitations](#limitations). The [demo](demo.md) walks through every area. Its walkthrough
on a seeded voyage has been driven end to end once in a real browser by a script, but not yet by
a person. Its second walkthrough, on a voyage created and set up in the app
([ADR 0016](decisions/0016-initial-voyage-setup.md)), is written but has not been performed.
The Action Center, added since, is verified only locally so far
([local verification](#local-verification-2026-10-23)).

## Verified build

| Item           | Value                                                                                                                                          |
| -------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| Commit         | `5baf03935d08291cdc032f71fa1146614d2d626f` on `main` (2026-10-18), which includes ADR 0016                                                     |
| CI run         | [GitHub Actions run 39139518806](https://github.com/AlexTikhon/TradeFlow/actions/runs/39139518806): success, triggered by the push of that SHA |
| `verify` job   | Success: format, lint, typecheck, `pnpm test`, build                                                                                           |
| `e2e` job      | Success: `pnpm test:e2e`, 10 of 10 Chromium tests, one worker, no retries                                                                      |
| Runners        | `ubuntu-latest`, which resolved to Ubuntu 24.04; Node.js 24.21.0 (`.nvmrc`: 24); PostgreSQL 18 (`postgres:18-alpine`) service                  |
| Upload on fail | **Skipped** in this run, because nothing failed. See [Limitations](#limitations)                                                               |

Tests that ran in that run, counted from its job logs (Vitest's per-file lines and summaries,
Playwright's list reporter). Every test passed; none was skipped.

| Layer                   | Where                          | Files | Tests |
| ----------------------- | ------------------------------ | ----- | ----- |
| Schemas                 | `packages/contracts`           | 9     | 160   |
| API unit                | `apps/api/src/**/*.spec.ts`    | 16    | 176   |
| API on PostgreSQL, HTTP | `apps/api/test/*.int-spec.ts`  | 14    | 488   |
| Web on MSW, jsdom       | `apps/web/src/**/*.test.ts(x)` | 15    | 311   |
| Chromium end to end     | `e2e/tests/*.spec.ts`          | 7     | 10    |
| **Total**               |                                | 61    | 1,145 |

Against the previous verified run ([39116071881](https://github.com/AlexTikhon/TradeFlow/actions/runs/39116071881),
commit `e0f698d`, 55 files and 989 tests), the new files are `organizations.spec.ts`,
`trade-string-setup.spec.ts`, `organizations.int-spec.ts`, `trade-string-setup.int-spec.ts`,
`VoyageTradeStringSetup.test.tsx` and the Chromium `trade-string-setup.spec.ts`; existing files
gained tests too (for example `preconditions.spec.ts`, now 42).

The API's test log contains one `ERROR [VoyageEventBus] A listener failed on NOTICE_ISSUED`
line. It is expected: the unit test "keeps a failing listener from reaching the publisher or the
other listeners" in `voyage-event-bus.spec.ts` makes a listener throw on purpose, and it passed.

Documentation committed after `5baf039` does not change this evidence. Changes to code or tests
need a new run.

## Local verification, 2026-10-23

**Not CI evidence.** The Action Center ([ADR 0017](decisions/0017-action-center.md)) was added
after the CI run above, and no CI run has verified it yet. These are the results of one local run,
on the uncommitted working tree on top of `0c9fb64` (the Action Center, its initial-load
invalidation fix, its Chromium tests and the seed's reference-counter fix), run in sequence on
Windows 11 with Node.js 24.11.1, against a disposable PostgreSQL 18.6 container with explicit
`TEST_DATABASE_URL` (`…/tradeflow_test`) and `E2E_DATABASE_URL` (`…/tradeflow_e2e`).

| Command            | Result                                                             |
| ------------------ | ------------------------------------------------------------------ |
| `pnpm check`       | Passed: format, lint, typecheck, every Vitest suite, build         |
| `pnpm test:e2e`    | Passed: 14 of 14 Chromium tests in 8 files, one worker, no retries |
| `git diff --check` | No whitespace errors                                               |

| Layer                   | Where                          | Files | Tests |
| ----------------------- | ------------------------------ | ----- | ----- |
| Schemas                 | `packages/contracts`           | 10    | 193   |
| API unit                | `apps/api/src/**/*.spec.ts`    | 19    | 234   |
| API on PostgreSQL, HTTP | `apps/api/test/*.int-spec.ts`  | 15    | 531   |
| Web on MSW, jsdom       | `apps/web/src/**/*.test.ts(x)` | 19    | 459   |
| Chromium end to end     | `e2e/tests/*.spec.ts`          | 8     | 14    |
| **Total**               |                                | 71    | 1,431 |

The ten earlier Chromium tests all still pass; the four new ones are in `action-center.spec.ts`
([ADR 0017, browser coverage](decisions/0017-action-center.md#browser-coverage)). The Action
Center was also inspected in Chromium screenshots at 1280 × 800, 390 × 844 and 360 × 740 (queue
with a long rejection reason, a historical deep link, loading, load failure and refresh failure):
no horizontal scrolling at any width, the linked record focused below the sticky header. At 360 px
the header's **Sign out** label wraps onto two lines inside its button; nothing overflows or is
hidden. Its [three-minute walkthrough](demo.md#walkthrough-3-the-action-center-in-three-minutes)
was driven once by a script, not by a person ([record](demo.md#record-of-walkthrough-3)).

## What each kind of verification proves

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
- **Real Chromium, automated suite** (end to end, in CI). A production web build and the built API
  run against a fresh PostgreSQL database through the same-origin proxy, with real sign-in,
  cookies and the browser's own `EventSource`. Each test proves from the browser's network log
  that a stream message, not polling, refreshed the other party's page. The suite is a smoke
  layer: 10 tests, Chromium only, plain HTTP, each with generated organizations. Nine write a
  voyage with one contract straight into the database; `trade-string-setup.spec.ts` creates its
  voyage and sets up its trade string through the UI. Faults come only from a labelled transport
  proxy (a 503, a held or dropped stream).
- **Real Chromium, scripted demo walkthrough** (once, locally, on 2026-10-18;
  [record](demo.md#walkthrough-record)). A Playwright script drove all six demo steps through
  the UI of the development servers (Vite dev server, API in watch mode). It used two isolated
  browser contexts, on a throwaway database with all migrations and the real seed. This covers
  what the suite does not: the seeded multi-contract voyage, the stale draft caused by a pushed
  acknowledgement, the server's PDF signature refusal, and the outsider and viewer checks in a
  browser. It is not a test in the repository, did not run in CI, and is not a human run of the
  demo. It predates ADR 0016, so it did not create a voyage or set up a trade string.
- **Fresh-voyage walkthrough, by a person** ([demo, steps F1 to F8](demo.md#walkthrough-2-a-fresh-voyage)):
  **not yet performed.** It is written to be run by hand in two browser profiles, from voyage
  creation through setup, the buyer's access, instructions, documents and the timeline, on
  seeded organizations only. Until someone runs it and fills in its record, it proves nothing.

## The eight MVP areas

The "Walkthrough" column names the [demo](demo.md) steps in which the scripted browser run
exercised each area. The fresh-voyage walkthrough (steps F1 to F8) has not been performed, so it
appears in no column.

| #   | Area                           | Status                            | Implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | PostgreSQL / HTTP                                                                                                                                                                                                                                           | MSW / jsdom                                                                                                    | Chromium suite                                                                                                                     | Walkthrough                     |
| --- | ------------------------------ | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| 1   | Organizations, users and RBAC  | Done; seeded accounts             | Organizations are the tenancy boundary, and each user belongs to one. Email and password (argon2id), server-side sessions in an `HttpOnly`, `SameSite=Strict` cookie. Voyage access follows participation. `VIEWER` reads; `OPERATOR` reads and acts, read on every request and checked in the service performing each command ([ADR 0006](decisions/0006-participation-based-access.md), [0007](decisions/0007-cookie-sessions.md), [0008](decisions/0008-user-roles.md))                                                                                                                                                                                                   | `auth.int-spec.ts` (17); an outsider-404 test in every feature's file; viewers refused with 403 in voyage creation, notices, instructions, documents and reviews; unit: password, session cookie                                                            | `auth-flow.test.tsx` (19), `session.test.ts` (32); a viewer test in each panel and in `NewVoyagePage.test.tsx` | `authentication.spec.ts` (sign-in, reload, cookie flags), `session-tabs.spec.ts` (two tabs, two users)                             | Setup, 1, 6 (outsider, viewer)  |
| 2   | Voyages                        | Done                              | List with status filter, details, creation by operators (`PLANNED`, server-assigned `TF-<year>-<n>`, creator's organization as exporter); `voyages` module, Zod contract ([ADR 0005](decisions/0005-shared-zod-api-contract.md))                                                                                                                                                                                                                                                                                                                                                                                                                                             | `voyages.int-spec.ts` (18), `voyage-creation.int-spec.ts` (31, incl. concurrent references, audit rollback), `openapi.int-spec.ts` (10)                                                                                                                     | `VoyageListPage.test.tsx` (6), `VoyageDetailsPage.test.tsx` (12), `NewVoyagePage.test.tsx` (19)                | `trade-string-setup.spec.ts`: creation through the form, then the voyage in the buyer's list; every journey opens the details page | 1, 6 (lists); creation not run  |
| 3   | Trade-string visualization     | Done; set up once, then read-only | Sale contracts stored as edges, with row rules in the database and chain rules in the domain. Every participant sees the topology, never terms ([ADR 0010](decisions/0010-trade-string-visibility.md)). The voyage page draws the parties in contract order, marks the viewer's own organization, and keeps service providers out of the string. Beyond the MVP: the one-time setup of a new voyage's chain by its exporter's operators, and an operator-only organization search ([ADR 0016](decisions/0016-initial-voyage-setup.md)), from the voyage page                                                                                                                 | `trade-string.int-spec.ts` (23), `trade-string-setup.int-spec.ts` (60, incl. two races, revalidation after the lock, audit rollback), `organizations.int-spec.ts` (12); unit `trade-string.spec.ts` (24), `trade-string-setup.spec.ts` (11)                 | Trade-string tests in `VoyageDetailsPage.test.tsx`; `VoyageTradeStringSetup.test.tsx` (26)                     | `trade-string-setup.spec.ts`: create, set up, buyer gives instructions                                                             | 1                               |
| 4   | Notices                        | Done; ETA notices only            | ETA notices from the seller to the buyer under one contract, counterparty-only; immutable once issued; acknowledged once by conditional update; overdue derived ([ADR 0011](decisions/0011-counterparty-notices.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                         | `notices.int-spec.ts` (57, incl. a race on a held lock); unit `notice-rules.spec.ts` (11)                                                                                                                                                                   | `VoyageNotices.test.tsx` (32), `local-date-time.test.ts` (39, DST)                                             | `live-notices.spec.ts`: issue and acknowledge across two contexts, live                                                            | 2                               |
| 5   | Documentary instructions       | Done                              | Buyer to seller under one contract; immutable revisions; acknowledgement of an exact revision; one conditional statement per write with `ETag`/`If-Match` (412, 428); a draft kept until the user re-bases it ([ADR 0012](decisions/0012-documentary-instructions.md))                                                                                                                                                                                                                                                                                                                                                                                                       | `documentary-instructions.int-spec.ts` (81, incl. four real races); unit `instruction-rules`, `preconditions`                                                                                                                                               | `VoyageDocumentaryInstructions.test.tsx` (22: 412 and refresh conflicts, drafts kept)                          | `live-instructions.spec.ts` (2): give, acknowledge, revise live; a pushed revision leaves a draft alone                            | 3, 4                            |
| 6   | Documents: upload and approval | Done; local storage               | Per document an exact revision requires: PDF upload, accepted when declared `application/pdf`, non-empty, at most 10 MiB (enforced while streaming) and starting with `%PDF-` (a signature check, not a structural one). Immutable versions with SHA-256. Bytes staged outside the transaction, removed after a certain rollback, kept and logged when the commit outcome is unknown. Counterparty-only attachment downloads. The buyer approves, or rejects with a reason, the latest version: one final decision per file version, and one document version for uploads and decisions ([ADR 0013](decisions/0013-documents.md), [0014](decisions/0014-document-review.md)) | `documents.int-spec.ts` (71, files on disk checked after every failure), `document-reviews.int-spec.ts` (48, incl. review against replacement in both orders), `document-review-migration.int-spec.ts` (2); unit `document-rules`, `local-document-storage` | `VoyageDocuments.test.tsx` (36), `VoyageDocumentReviews.test.tsx` (20)                                         | `live-documents.spec.ts`: upload through the form, download compared by SHA-256, approval, replacement, rejection, history         | 5 (incl. a refused fake PDF)    |
| 7   | Audit timeline                 | Done; read-only                   | Append-only `audit_events` written in the command's transaction; a cursor-paginated timeline, newest first, scoped per contract, identifiers only ([ADR 0009](decisions/0009-transactional-audit-events.md))                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | `voyage-timeline.int-spec.ts` (29); a forced audit failure rolls back each command, in each feature's file                                                                                                                                                  | `VoyageTimeline.test.tsx` (8)                                                                                  | Timeline entries asserted in the three `live-*` tests                                                                              | 2 to 6                          |
| 8   | Real-time updates              | Done; best effort                 | One SSE stream per voyage; type-only signals after commit, to current counterparties, re-checked before delivery and every 30 s; the page re-reads what a signal concerns over REST, everything on (re)connection, and polls while disconnected ([ADR 0015](decisions/0015-voyage-event-streams.md))                                                                                                                                                                                                                                                                                                                                                                         | `voyage-events.int-spec.ts` (29, real HTTP streams); unit `voyage-event-streams`, `voyage-event-bus`                                                                                                                                                        | `VoyageLiveUpdates.test.tsx` (30, fake `EventSource`)                                                          | The three `live-*` tests; `stream-recovery.spec.ts` (3: drop, 503, catch-up); `session-tabs.spec.ts`                               | 2 to 5 (no reconnection tested) |

Numbers in brackets are test counts from the verified run, ADR 0016's files included. Not in the
MVP, and not started: editing a
recorded chain or adding participants any other way, further notice types,
notifications, deadlines and tasks, amending decisions, object storage and AI-assisted
extraction ([README](../README.md#roadmap)).

## Limitations

- **Organizations and users come from the seed.** No API or screen creates an organization or
  a user or invites an organization. A voyage created in the app has only its creator's
  organization, as exporter, until an operator of it sets up its chain once on the voyage page
  (ADR 0016), which adds the named organizations as participants; a recorded chain cannot be
  changed, and nobody else can be added. Most Chromium tests still write their voyage and
  contract directly into the database; `trade-string-setup.spec.ts` creates and sets up its
  own through the UI.
- **One API instance.** The event bus is in process. A second API instance would not receive the
  other's signals, and nothing coordinates several.
- **Best-effort live updates.** Signals are not stored, carry no ids and cannot be replayed. A
  signal lost while a stream is down is made up for by the refetch on every (re)connection and by
  30-second polling while disconnected. REST stays the source of truth.
- **Local document storage.** Bytes live in a private local directory (`DOCUMENT_STORAGE_DIR`).
  There are no backups, no object store and no virus scanning. The PDF check is a signature
  check: a file that starts with `%PDF-` but is otherwise broken is accepted. Orphaned bytes (a
  crash between keeping a file and committing it, a failed removal, an unknown commit outcome)
  are logged and removed by a manual procedure
  ([architecture](architecture.md#operational-concerns-current-state)).
- **Chromium over plain HTTP.** The end-to-end suite and the scripted walkthrough ran Chromium
  only, over HTTP. The production cookie's `Secure` attribute and `__Host-` name, other browsers'
  cookie and `EventSource` behaviour, and the native date-time, file and download dialogs are not
  covered. The walkthrough looked at the full page, but no test checks layout.
- **The failure-artifact upload has not been exercised.** CI is configured to upload
  `e2e/.output/` as `e2e-diagnostics` when the e2e suite fails (hidden files included, cookie- and
  trace-bearing paths excluded, a missing upload failing the step). In the verified run the suite
  passed, so the step was skipped. A green run says nothing about whether that upload works; only
  a failing run will.
- **The demo has not been run by a person.** The [walkthrough record](demo.md#walkthrough-record)
  is of a scripted Chromium session on the seeded voyage. It found one cosmetic defect: after an
  upload, the emptied upload form's disabled button shows a stale version number. A bounded fix
  is proposed there. The [fresh-voyage walkthrough](demo.md#walkthrough-2-a-fresh-voyage) has
  not been run at all, by a script or a person. In a browser, voyage creation and setup have run
  only in the one Chromium test, which stops at the buyer's first instructions.
- **Other known gaps:** sign-in is limited only in process, per client address (no lockout, no
  limit shared between instances, [ADR 0018](decisions/0018-sign-in-admission.md)), no SSO, no password reset
  ([ADR 0007](decisions/0007-cookie-sessions.md)). Seeded notice times are relative to when the
  seed ran, so their awaiting, overdue and acknowledged states drift until the next seed.
