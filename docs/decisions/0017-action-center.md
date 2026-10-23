# 0017. Action Center: a read-only projection of what each organization owes, across voyages

- **Status:** Proposed. The projection rules (`apps/api/src/modules/action-center/`), the wire
  contract (`packages/contracts/src/action-items.ts`) and `GET /api/action-items` are implemented;
  the rules are unit-tested and the endpoint is tested over HTTP against PostgreSQL. The web
  page (`/actions`, `apps/web/src/features/action-center/`) and exact-record links into the
  voyage page (`apps/web/src/features/voyages/navigation/`) are implemented and tested through
  the real route tree ([the web slice](#the-web-slice)). The page keeps its queue current
  ([freshness](#freshness)): polling, visibility, focus, reconnection and the voyage commands'
  invalidation, all tested on controlled timers. Browser end-to-end coverage is still to come.
- **Date:** 2026-10-22 (freshness: 2026-10-23)

## Context

Every bilateral workflow so far waits on one side of a sale contract: the buyer acknowledges an
ETA notice ([ADR 0011](0011-counterparty-notices.md)), the seller acknowledges a revision of the
documentary instructions ([ADR 0012](0012-documentary-instructions.md)), the buyer decides on a
presented file and the seller replaces a rejected one ([ADR 0013](0013-documents.md),
[ADR 0014](0014-document-review.md)). Each is visible only on its voyage's page. An organization
on many voyages, often trading on both sides of a string, has no single place that says what is
waiting for it.

The forces:

- **The records already say it.** Whether something is waiting follows from rows that exist: a
  notice's status, a revision's acknowledgement, a file's review. A second store of "tasks" would
  have to be kept in step with them by every command, and could disagree with them.
- **Confidential to the contract.** Everything these actions concern is visible only to the
  contract's two counterparties. Voyage participation is not enough: service providers
  participate and are party to nothing, and a trader sees the whole string's topology
  ([ADR 0010](0010-trade-string-visibility.md)) but only its own contracts.
- **History is not work.** Superseded revisions, replaced files and the decisions on them stay
  readable for good; none of them can be acted on, and none may look as if it could.
- **Only notices have deadlines.** Instructions and documents have none
  ([ADR 0012](0012-documentary-instructions.md) rule 1); laycan is a voyage fact, not a deadline
  any of these commands answer to.
- **No new infrastructure** ([architecture](../architecture.md#evolution)): no jobs, no queue.

## Decision

### A projection, not a store

**`GET /api/action-items` returns the signed-in organization's open actions, computed on every
request from the records as they are.** Nothing is written: no table, no status, no
assignment, no completion. An action disappears when the command that answers it commits; the
command, not the Action Center, decides who may run it.

The rules are pure functions over facts, the organization's id and a supplied clock
(`projectActionItems` in `action-items.ts`); loading the facts is the endpoint's job.

| Type                        | Owed by    | Open while                                                                       | Deadline                                      |
| --------------------------- | ---------- | -------------------------------------------------------------------------------- | --------------------------------------------- |
| `ACKNOWLEDGE_NOTICE`        | the buyer  | the notice is `ISSUED`                                                           | `acknowledgementDueAt`; overdue when now > it |
| `ACKNOWLEDGE_INSTRUCTIONS`  | the seller | the instruction's **current** revision has no acknowledgement                    | none                                          |
| `REVIEW_DOCUMENT`           | the buyer  | a document of the **current** revision has a **latest** file with no review      | none                                          |
| `REPLACE_REJECTED_DOCUMENT` | the seller | a document of the **current** revision has a **latest** file that was `REJECTED` | none                                          |

- **The side of the contract decides**, never the participant role, as for every command: a
  trader buys under one contract and sells under the next, and owes actions on both.
- **Only the current revision and each document's latest file count.** An earlier revision left
  unacknowledged, a file replaced before it was decided, a rejection followed by a replacement
  (which is pending: the buyer's action now), and anything under a superseded revision produce
  nothing. An approved latest file produces nothing for either side.
- **No action waits on another.** The commands do not require a revision to be acknowledged
  before its documents are uploaded or decided, so neither does the projection.
- **Overdue is the notice's own rule** (`isOverdue` in `notices/notice-rules.ts`, imported, not
  restated): `ISSUED` and strictly past the deadline, evaluated at the request's clock reading.
  No deadline is derived from laycan, and none is invented for instructions or documents.

### What an item carries

A discriminated union on `type` (`ActionItemSchema`). Every item has:

- `key`: the action's identity (below);
- `voyage` `{ id, reference }`, `contract` `{ id, position }`, and `counterparty`, the other party's
  `OrganizationRef`;
- its own source instants: `issuedAt` and `acknowledgementDueAt` (notices, plus `overdue`),
  `revisionCreatedAt` (instructions), `uploadedAt` (documents), and `rejectedAt` (rejected
  documents);
- `target`, naming the exact record by the identifiers its own endpoints take: `NOTICE`
  (`noticeId`), `INSTRUCTION_REVISION` (`instructionId`, `revisionNumber`) or `DOCUMENT_VERSION`
  (`revisionNumber`, `documentType`, `documentId`, `versionNumber`), each with `voyageId` and
  `contractId`, which must equal the item's own (a schema refinement).

The **rejection reason** is served only on `REPLACE_REJECTED_DOCUMENT`: it is what the seller
must act on, and both counterparties already read it in the documents panel. Nothing else of the
records is served: no notice message, instruction contents, file names or checksums, which stay
with the panels that own them. The schemas are Zod objects, so any other key is dropped.

### Visibility

- **Scope: contracts, not voyages.** The facts must be loaded only under contracts where the
  organization is the seller or the buyer **and** participates in the voyage now:
  `counterpartyContracts(principal)` from the voyages module, which already `AND`s
  `accessibleVoyages` ([ADR 0006](0006-participation-based-access.md),
  [ADR 0011](0011-counterparty-notices.md)). Participation alone would show a surveyor, or a
  trader elsewhere in the string, notices and documents it may not see. The projection also
  ignores any contract the organization is not party to, but that is a second line, not the
  scope: rows outside it must never be read.
- **Viewers read their organization's queue**, as they read every record in it. Commands keep
  their own checks (`requireOperator`, the side, preconditions); an item is not a permission, and
  the UI must not offer a viewer the command.
- **No 404s.** The resource is not voyage-scoped: an organization with nothing to do gets 200
  with an empty page, the same as one party to no contract.

### Identity

`key` is `<TYPE>:<record>` (`ACKNOWLEDGE_NOTICE:<noticeId>`,
`ACKNOWLEDGE_INSTRUCTIONS:<instructionId>:<revisionNumber>`,
`REVIEW_DOCUMENT:<documentId>:<versionNumber>`,
`REPLACE_REJECTED_DOCUMENT:<documentId>:<versionNumber>`). It is the same on every read for as
long as the action is open, unique in the queue, and new for a new revision or file: a revision
that supersedes another is a new action, not the old one updated. Clients treat it as opaque. It
is ASCII, so code-unit order (in TypeScript) and `COLLATE "C"` (in SQL) agree.

### Order and pagination

- **Order:** actions with a deadline first, earliest deadline first; then the rest, the longest
  waiting first (revision given, file uploaded, file rejected); ties by `key`. Sorting by the
  deadline puts overdue notices ahead without the order depending on the clock. The position
  `(dated, at, key)` is total, and built only from immutable facts, so an open action never
  changes place.
- **Keyset pagination.** `limit` 1–50 (default 20), `cursor` opaque: base64url JSON of the last
  served position. A page holds the actions strictly after it, in order; `nextCursor` is null on
  the last page. No total is computed or served. A cursor needs no signature: every page applies
  the organization's scope, so a forged one only moves within what its bearer may see. A cursor
  the API did not produce is a 400, before anything is read.
- **Filters** `type` and `overdue=true` are applied before the page is cut. They are not part of
  the cursor: a client sends the same filters with it, and a cursor sent with other filters is
  just a position in the same order.
- **Strategy for the first endpoint:** load the organization's candidate facts in scope (issued
  notices, current revisions, latest files of current-revision documents; never history), project
  them, and cut the page in memory (`actionItemPage`). The response is bounded by `limit`; the
  loading is not: every page reads all of the organization's candidates, so its cost scales with
  the organization's current work across its contracts, never with its history. No total is
  counted. When that is too much, the same order moves into SQL (a
  `UNION ALL` of the four kinds with the same position columns and `key COLLATE "C"`), behind the
  same contract and the same unit-tested rules.

### Consistency

- **One page, one snapshot, one clock.** The scope and every fact for a page are read in one
  `REPEATABLE READ` transaction, as for the timeline and documents, and the API's clock is read
  once: it decides `overdue` and is returned as `generatedAt`.
- **No snapshot across requests.** Each page is projected again from the records as they are when
  it is requested. Between pages: an action answered meanwhile is not served on a later page. An
  action that appears meanwhile is served if its complete position `(dated, at, key)` sorts after
  the cursor, and missed if it sorts before, until the client starts again from the first page.
  Its time is a fact of the record (the deadline the seller chose; when a revision was given, a
  file uploaded or rejected, by the API's clock before its transaction committed), not the order
  of commits: a new notice with an earlier deadline sorts before the cursor, and so can a new
  revision, upload or rejection whose time does not exceed the cursor's, a tie falling to the key.
  A notice that becomes overdue keeps its place, since its deadline does not move. Because
  positions never change, one walk through the pages serves no action twice. Clients that need
  the current state read the first page again; nothing promises more.

### Module boundaries for the endpoint

A new `action-center` module owns no table. It reads only through providers that the owning
modules export, each taking the caller's transaction and returning a type of its own module,
which `contract-facts.ts` adapts to the rules' facts; none of those modules depends on the
Action Center:

- voyages: `CounterpartyContracts.listAcrossVoyages(principal, tx)`, the contracts in scope on
  every voyage, with `voyage.reference` and both counterparties, under `counterpartyContracts`;
- notices: `IssuedNotices.listUnderContracts`, `ISSUED` notices only (id, contract, two instants);
- documentary-instructions: `CurrentRevisions.listUnderContracts`, each instruction's current
  revision joined to its acknowledgement, if any;
- documents: `LatestDocumentVersions.listForRevisions`, documents of the revisions the previous
  read found current, each joined to its latest file and that file's review.

One query each (a single SQL statement for the three fact readers), whatever the number of
voyages, contracts, revisions or documents; history is excluded in SQL, not discarded afterwards. Importing `isOverdue` from the notices module is the
first cross-module use of a rules file; it is a pure function and the point is to share the rule,
not restate it.

## Alternatives considered

- **A persisted `tasks` table**, written by each command. It would need every command (and every
  writer the triggers allow) to keep it in step, would need its own audit and visibility, and
  could disagree with the records. The `Task` sketched in the [domain model](../domain-model.md)
  stays a future idea for work the records do not express.
- **Scoping by participation, filtering in code.** Reads rows the organization may not see, and
  one forgotten filter leaks them. Rejected as for voyages (ADR 0006).
- **Overdue first by the clock, then everything else.** Makes an item's place depend on the time
  of the request, so it could move between pages. Ordering by the deadline gives the same result
  on any one page and stays stable.
- **One combined order by time** (deadlines and waiting times interleaved). Compares a future
  deadline with a past event, which says nothing about urgency.
- **Offset pagination or a total count.** Offsets skip or repeat items when the queue changes, and
  a total needs a second scan of every source for a number the queue does not need.
- **Laycan-derived deadlines.** Laycan is when the vessel must present, not when anyone must
  acknowledge or review; deriving deadlines from it would invent business rules.
- **Serving every reason, message or file name.** Convenient, but the queue would become a second
  reader of confidential contents with its own rules to keep in step.
- **For freshness, an organization-wide event stream.** Pushes would reach the queue sooner, but
  streams are per voyage ([ADR 0015](0015-voyage-event-streams.md)) and best effort, so the
  queue would still need reads to reconcile; polling and invalidation need no new
  infrastructure.
- **For freshness, reading every loaded page again** (TanStack's default refetch of an infinite
  query, with fresh cursors). It keeps the user's depth, but costs a request per loaded page on
  every refresh, and a refresh and a "Load more" on the same query either cancel or swallow each
  other. Restarting from the first page keeps one read per refresh and one rule for what is shown.
- **For freshness, an invalidation bus between the features.** The query cache already is one:
  commands invalidate the queue's key through a shared module, and TanStack refetches only what
  is on screen.

## Consequences

- No migration and no write path: the queue is right as of each read, and is gone where the
  records say so.
- The endpoint reads four modules' facts in one snapshot; each owning module grew a narrow
  exported reader. The scope across voyages is a new query, tested like `CounterpartyContracts`
  (service providers, other traders, spoofed ids, another organization's cursor).
- Page cost grows with the organization's open work. The move to SQL ordering is prepared (same
  position, ASCII keys) but not built.
- No stream: SSE streams are per voyage ([ADR 0015](0015-voyage-event-streams.md)) and none is
  added for the queue. A queue on screen reads its first page again on a timer, on the events
  that make it likely to be stale, and after the voyage commands of the same session
  ([freshness](#freshness)), so it lags the records by at most the interval while visible and
  online. Another organization's command (the counterparty presenting a file, say) reaches it
  only by those reads. `overdue` is true as of `generatedAt`, which the page shows as the last
  update; a deadline that passes is shown by the next read, with nothing written.
- Every refresh costs one page read per open Action Center tab, every 30 s while visible, each
  loading the organization's candidates (see the strategy above).

### The endpoint slice

1. The four exported readers above.
2. `ActionCenterModule`: `ActionCenterService` (cursor decoded first, a 400 before anything is
   read; one `REPEATABLE READ` transaction for the scope and every fact; the injectable
   `ACTION_CENTER_CLOCK` read once, after the reads, for `overdue` and `generatedAt`;
   `actionItemPage`) and `ActionCenterController` for `GET /api/action-items` with
   `ActionItemsQuerySchema`, `@ApiSessionAuth()` and `ActionItemPage`. No role check: viewers
   and operators read the same queue.
3. `apps/api/test/action-items.int-spec.ts`, over HTTP against PostgreSQL with every constraint
   in place, with the workflow written through the commands' own endpoints: both sides of all
   four types, a trader on both sides, viewers and operators, service providers and outsiders
   (empty pages), another contract on the same voyage, supplied organization ids and another
   organization's cursor, the exact field set, every transition (acknowledgements, rejection,
   replacement, approval, a new revision), deadline boundaries on a controlled clock, filters,
   limits, equal deadlines, changes between pages, malformed queries, and a page held between
   two of its reads (by a table lock) while a command commits, which it does not see.

Not tested: participation removed under a contract. The composite foreign keys refuse to delete
a participant a contract names, so that state cannot exist; the predicate states it anyway.

### The web slice

**`/actions`** is a protected page in the main navigation (the default landing page stays
`/voyages`). It is a reader of the endpoint, nothing more:

- **Server state only.** Per set of filters, under the identity's protected scope: a query for
  the first page (`actionItemQueries.list(scope, filters)`) and one per later page of the
  current walk (`actionItemQueries.page`), fetched with the shared client, validated with
  `ActionItemPageSchema`, and each request carries its query's abort signal. An identity change
  cancels a page on its way, first or next, and its late answer reaches nobody; a 401 signs out
  as for any protected query.
- **Filters in the URL** (`?type=…&overdue=true`), so reload, back and forward and shared links
  work. Each change is a history entry; a value the page does not know (or a parameter given
  twice) is ignored, never guessed at, and the page says so and offers to remove it from the
  address. A filter has a key of its own, so another filter's items are never shown while its
  first page loads, and its walk starts from the first page.
- **Pages are positions, not a snapshot**, so a walk is not kept once nothing shows it
  (`gcTime: 0`): coming back to the queue starts again from its first page. **Load more** sends
  the last `nextCursor` unchanged with the same filters; a failed page keeps the items shown and
  offers its own retry. **Refresh** reads the first page again and, once it answers, drops every
  page loaded after the previous one. The page shows no count, since the API serves no total
  and the items loaded are not the queue.
- **Each item** names the action, the voyage, the counterparty and the contract's position, the
  exact revision or file version (never for a notice), the deadline and overdue only for
  notices, the rejection reason only for a replacement, and its source instants. It sends no
  command: it links to the record. Viewers see the same queue and links, with a line saying an
  operator acts.

**Record links** (`features/voyages/navigation/`) open one exact record on the voyage's page:
`/voyages/:voyageId?open=notice|instruction-revision|document-version&contract=…` with the
identifiers of the item's `target` (`notice`; `instruction` and `revision`; `revision`,
`documentType`, `document` and `version`). The voyages feature owns them (`recordLinkPath`,
`parseRecordLink`, `resolveRecordLink`); the Action Center only builds links, and nothing in
the voyages feature depends on it.

- **The address is untrusted.** It is parsed back into a target with the contract's own target
  schemas (UUIDs, positive numbers without leading zeros, a known document type), with the
  voyage taken from the path; a repeated parameter makes a link malformed. A malformed link names
  nothing.
- **Resolved against what the page fetched**, once the queries the kind needs have answered
  (the voyage, the organization's contracts, and the notices, or the instructions, or the
  instructions and documents). Every identifier must match the record found: the contract must
  be one of the organization's on this voyage, the notice or instruction must be under it, and a
  document must match its id, contract, revision and type. Nothing else stands in for a record
  that does not match: a newer revision or file is never chosen instead.
- **What the record is now** is said in a status above the voyage's sections, from the
  organization's side of the contract: still waiting (for it, or for the counterparty),
  acknowledged or decided since (nothing waiting), a superseded revision or a replaced file
  (shown as history, read-only, nothing waiting on it; for a replaced file, that a decision or a
  replacement applies only to the latest one), not found, malformed, or not yet shown because a
  section it needs failed (the section offers the retry).
- **Showing it**: the section holding the record marks its container (the notice, the revision,
  the exact file version). Revealing it is a request, made by a link not seen before on the page
  (another revision or file on the same voyage included) and by **Show it**. For each request,
  every collapsed history holding the record opens (earlier revisions, earlier versions, both
  for a replaced file of a superseded revision), whatever the user did with it before, and
  history that does not hold it is left as it is. Focus then moves to the container once nothing
  collapsed encloses it (history stays mounted while folded, so being on the page is not
  enough) and focus has actually landed, which completes the request. Refreshes are not
  requests: history the user folded stays folded, even if a refresh moves the record into it,
  and focus stays where the user put it; the same link located again asks nothing. Drafts,
  chosen files and conflict notices are untouched: navigation only reads, and the forms keep
  their own basis.
- **No command is sent and no decision is started** by opening a link. The usual forms stay
  where they were, under their usual permissions, with nothing chosen.

### Freshness

A queue on screen keeps itself current by reading its **first page** again, never a later one
(`useActionQueue`, `actionItemQueries.list`):

- **When:** every 30 s while the tab is visible and the browser online (`refetchInterval`;
  ticks are skipped while hidden, and offline a read waits unsent); as soon as the tab becomes
  visible or the window regains focus; when the connection returns; on **Refresh**; and after a
  voyage command succeeds in the same session.
- **Commands** (issuing and acknowledging notices, giving, revising and acknowledging
  instructions, uploading and deciding on documents) call `invalidateActionQueue` from
  `shared/cache/action-queue.ts`, which owns the queue's key, so neither feature imports the
  other. It is called inside each command's existing session-epoch guard: a command answered
  after a sign-out, a sign-in as someone else, the same user signing back in, or session checks
  going to someone else and back, invalidates nothing. Only queues on screen are read again;
  another filter cached is marked stale, not fetched. No write is retried, and the commands'
  pre-dispatch check for commands that waited offline is unchanged.
- **Coalescing:** a trigger that arrives while a read is on its way shares it, so focus,
  visibility, reconnection and the interval never cancel or repeat a read. A command's
  invalidation is the exception: the read on its way may predate the command, so it is
  replaced by one sent now, and the change is never lost.
- **Pagination restarts.** Each successful read of the first page ends the walk that followed
  the previous one: its later pages are no longer shown, and a page still on its way loses its
  observer, is cancelled, and can never be appended to the new queue. **Load more** then follows
  the new page's cursor; walks are numbered so that none reuses another's pages or cursors.
  Refreshed first pages are never shown next to pages read before them. Filters stay as they
  are in the URL.
- **Failures and staleness.** A failed read changes nothing shown and is reported beside the
  queue with a retry. The header says when the queue was last updated (`generatedAt` of the
  last successful read, so older items are never presented as just checked), and that it may be
  out of date after a failure or while offline.
- **Overdue** changes only through reads: a deadline that passes appears as overdue, and in the
  overdue filter, on the next read, with nothing written.
- **Lifetime:** the interval, the focus listener and any read on its way end with the page,
  which the auth boundary replaces whenever the session changes.

Trade-off: a refresh returns a user who loaded later pages to the first one (at most every 30 s
while visible), the price of never mixing reads; reading every loaded page again would keep
the depth at the cost of a request per page on each refresh.

Tested through the real route tree, providers and MSW (`ActionCenterPage.test.tsx`,
`VoyageRecordLinks.test.tsx`, the command tests of the voyage page, and unit tests of the link
codec and URL filters): routing and the navigation item, all four kinds and their conditional
fields, filters through the URL and back and forward, cursors and the reset on a filter change,
loading, empty, first-page and next-page failures, Refresh, viewers, malformed responses (first
and later pages), late pages after an identity change, links resolved after delayed loading,
superseded revisions, replaced files and documents of superseded revisions shown as history,
stale, mismatched and malformed links that open nothing, a failed section retried, focus moved
once (and kept through a refresh with a draft open), history folded by the user and opened
again by another link on the same page or by Show it (revisions, versions, and both around a
replaced file of a superseded revision) with a draft kept on its version, and no command sent
from any link. Freshness on controlled timers with request barriers: polling and its pauses,
visibility, focus and reconnection, shared reads, cleanup on leaving and on session
replacement (including the same user signing back in), a walk restarted by a refresh and a late
page never appended, a deadline passing with nothing written, a failed refresh and its
recovery, an invalidation replacing a read on its way without fetching another filter, and a
command succeeding after the queue was shown; each command's own tests check its invalidation,
and that a completion for an ended session invalidates nothing.
