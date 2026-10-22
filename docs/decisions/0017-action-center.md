# 0017. Action Center: a read-only projection of what each organization owes, across voyages

- **Status:** Proposed. The projection rules (`apps/api/src/modules/action-center/`) and the wire
  contract (`packages/contracts/src/action-items.ts`) are implemented and unit-tested; the
  endpoint is the next slice.
- **Date:** 2026-10-22

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

**`GET /api/action-items` will return the signed-in organization's open actions, computed on every
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
  them, and cut the page in memory (`actionItemPage`). The cost of a page is the organization's
  open work, not its history. When that is too much, the same order moves into SQL (a
  `UNION ALL` of the four kinds with the same position columns and `key COLLATE "C"`), behind the
  same contract and the same unit-tested rules.

### Consistency

- **One page, one snapshot, one clock.** The scope and every fact for a page are read in one
  `REPEATABLE READ` transaction, as for the timeline and documents, and the API's clock is read
  once: it decides `overdue` and is returned as `generatedAt`.
- **No snapshot across requests.** Each page is projected again from the records as they are when
  it is requested. Between pages: an action answered meanwhile is not served on a later page; an
  action that appears meanwhile is served if it sorts after the cursor (a new revision, upload or
  rejection does, its time being the latest, unless it ties the cursor's time and key) and missed if it sorts before (a new notice with an
  earlier deadline) until the client starts again from the first page; a notice that becomes
  overdue keeps its place, since its deadline does not move. Because positions never change, one
  walk through the pages serves no action twice. Clients that need the current state read the
  first page again; nothing promises more.

### Module boundaries for the endpoint

A new `action-center` module owns no table. It reads only through providers that the owning
modules export, each taking the caller's transaction: the voyages module's contracts in scope
across voyages (with `voyage.reference`), and the notices, documentary-instructions and documents
modules' candidate facts under given contract ids. None of these exists yet except
`CounterpartyContracts` (per voyage) and `InstructionRevisions` (per revision). Importing
`isOverdue` from the notices module is the first cross-module use of a rules file; it is a pure
function and the point is to share the rule, not restate it.

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

## Consequences

- No migration and no write path: the queue is right as of each read, and is gone where the
  records say so.
- The endpoint must read four modules' facts in one snapshot; each owning module grows a narrow
  exported reader. The scope across voyages is a new query, and must be tested like
  `CounterpartyContracts` (service providers, other traders, removed participation, spoofed ids).
- Page cost grows with the organization's open work. The move to SQL ordering is prepared (same
  position, ASCII keys) but not built.
- A queue left open does not update itself: SSE streams are per voyage
  ([ADR 0015](0015-voyage-event-streams.md)) and this slice adds none. `overdue` is true as of
  `generatedAt`.

### What remains for the endpoint slice

1. Exported readers: contracts in scope across voyages (voyages module), issued notices
   (notices), current revisions with their acknowledgement (documentary-instructions), latest
   files and reviews of current-revision documents (documents).
2. The `action-center` module, its service (one `REPEATABLE READ` transaction, one clock reading,
   `decodeActionItemCursor` → 400, `actionItemPage`) and controller for `GET /api/action-items`
   with `ActionItemsQuerySchema`, `@ApiSessionAuth()` and `ActionItemPage`.
3. Integration tests against PostgreSQL: both sides and both roles, service providers and other
   traders (nothing), removed participation, superseded revisions and replaced files written
   through the API, deadline boundaries, filters, cursor walks with changes between pages,
   malformed cursors, and the exact field set of each item; the OpenAPI path list.
