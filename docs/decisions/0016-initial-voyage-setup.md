# 0016. Initial voyage setup: one atomic command records a new voyage's whole trade chain

- **Status:** Accepted (implemented, steps 1 to 9 of the
  [implementation sequence](#implementation-sequence-smallest-api-first)); the
  [product questions](#unresolved-product-questions) stay open
- **Date:** 2026-10-18
- **Implementation:** organization search, the setup command, its migrations and timeline entry,
  with PostgreSQL/HTTP tests; the setup form on the trade-string card, with route tests; one
  Chromium journey from voyage creation through setup to the buyer's instructions. Verified
  locally (`pnpm check`, `pnpm test:e2e`), not yet in CI.

## Context

A voyage created in the app (`POST /api/voyages`) has one participant, its creator's
organization as `EXPORTER`, and no sale contracts. Everything bilateral (ETA notices,
documentary instructions, documents and their review) hangs off a `trade_contracts` row
([ADR 0011](0011-counterparty-notices.md) to [ADR 0014](0014-document-review.md)). So today
every voyage on which those workflows can run comes from the seed, or from rows written into the
database by hand, as the Chromium tests do ([MVP status](../mvp-status.md#limitations)).

The next milestone closes that gap for new voyages only: an exporter creates a voyage, then
records who it is sold through, and the organizations named gain access and their bilateral
workflows. The forces:

- **The chain is validated as a whole, and only as a whole.** `validateTradeString`
  (`apps/api/src/modules/voyages/trade-string.ts`) checks positions 1..n, connected contracts,
  exporter first, final buyer last, traders between, no branches, cycles or service providers.
  The database checks single rows only: positive, unique positions; distinct counterparties of
  the same voyage; nobody selling or buying twice. A half-recorded chain (an exporter selling to
  a trader with no final buyer yet) is invalid. The read model refuses to serve an invalid stored
  chain: `toTradeString` throws, so `GET .../trade-string` would answer 500.
- **The trade string always exists as a resource.** Before any contract is recorded,
  `GET /api/voyages/:voyageId/trade-string` answers 200 with `parties: []` and `edges: []`, and
  the trade-string card shows "Trade string not configured". This stays as it is.
- **Participation is the access grant** ([ADR 0006](0006-participation-based-access.md)).
  Writing a `voyage_participants` row is what lets an organization see a voyage. Recording a
  chain therefore grants access to every organization in it, at once.
- **Everyone in the chain sees all of it** ([ADR 0010](0010-trade-string-visibility.md)):
  every participant reads the topology (every party's name and country, in order) and the
  participant directory.
- **Writes follow one convention**: role checked in the service (`requireOperator`,
  [ADR 0008](0008-user-roles.md)), visibility through `accessibleVoyages`, the write and its
  audit event in one transaction ([ADR 0009](0009-transactional-audit-events.md)). Versioned
  aggregates (instructions, documents) also use HTTP preconditions (`If-None-Match: *` for the
  first version, `If-Match` after it, 412 and 428). This command deliberately does not (see 4).
- **The principal is resolved per request.** `AuthGuard` reads the session, and the user's
  organization and role, when the request arrives. A command that may wait reads them again
  with `SessionPrincipals.refresh` before deciding, as uploads do
  ([ADR 0013](0013-documents.md)).
- **No organization or user management exists**, and none is in scope: organizations are only
  ever selected, never created, invited or edited.

Out of scope: seeded voyages, voyages that already have contracts or other participants,
editing, extending or correcting a recorded chain, service providers, contract terms,
invitations, notifications, and organization or user CRUD.

### Assumptions

The proposal holds only while all of these hold. Each is revisited in
[Unresolved product questions](#unresolved-product-questions).

- **Organizations are a curated, existing set.** Every organization that can be named already
  exists and was put there by whoever runs the platform. Nobody creates, invites or edits one
  through this command.
- **The exporter knows the full chain.** It names every party, from itself to the final buyer,
  before submitting.
- **Participation grants access.** Being named makes an organization a participant, with
  everything that implies (2), immediately and without any further step.
- **Configuration is not counterparty acceptance.** The recorded chain is the exporter's
  statement of who the cargo is sold through. It does not mean any named organization agreed
  to it, to its position in it, or to any contract term.
- **Correction is outside this slice.** A recorded chain cannot be edited, replaced or removed
  through the API. A mistake is fixed outside the product until a later decision.

## Decision (proposed)

**`POST /api/voyages/:voyageId/trade-string` records the complete chain of a new, empty,
`PLANNED` voyage in one transaction, together with its participants and one audit event. It
answers 200 with the `TradeString`, and 409 once a chain exists, including to the loser of a
race. An operator of the voyage's exporter may do it once. Organizations are chosen through a
minimal, search-only directory.**

### 1. Who may set up a voyage

**An operator of the organization that participates in the voyage as `EXPORTER`.**

- The exporter is the only participant of an empty voyage, so it is the only organization that
  can see it at all. Anyone else gets the voyage's 404, exactly as for every other read and
  write.
- It is defined by participation, not by the user who created the voyage. Any operator of the
  exporter may set it up, like every other command, which is authorized per organization and
  role, never per author.
- Viewers of the exporter get 403: they can see the voyage, and the existing rule is that viewers
  read and operators act. No new role or permission is introduced.
- **Revalidation after the lock.** A setup may wait on the voyage's lock behind a competing
  setup (4), so the principal `AuthGuard` resolved may be out of date when the command decides.
  Once the lock is held, the transaction reads the session again (`SessionPrincipals.refresh`):
  an ended or revoked session is 401, a user who is no longer an operator is 403, and the
  organization (possibly changed) is checked against the voyage's participants again (5).
- **What the lock does not do.** The voyage lock serializes setups of that voyage, and
  nothing else. It does not block sign-out, session expiry, or a change to a user's role or
  organization: none of those touch the voyage row. The command acts on the session, role and
  organization as read at the refresh; a change committed after that read applies from the
  next request. This is the same guarantee uploads give, and it is accepted here.

Why not "any participant" or "each seller for its own sale"? On an empty voyage they coincide
with the exporter or do not exist yet. The incremental alternative is discussed in 3 and left
open in [Unresolved product questions](#unresolved-product-questions).

### 2. Choosing organizations, and what participation grants

**Discovery.** A new read, `GET /api/organizations?search=<text>`:

| Rule   | Proposal                                                                                               |
| ------ | ------------------------------------------------------------------------------------------------------ |
| Who    | Signed-in operators (403 for viewers): only operators can use the result                               |
| Query  | `search` required, 2 to 100 characters, matched case-insensitively against the name                    |
| Result | At most 20 `OrganizationRef` (`id`, `name`, `countryCode`), ordered by name; the caller's own excluded |
| Never  | Users, emails, roles, counts, voyages, or whether an organization participates in anything             |

The response reuses `OrganizationRefSchema`, the same three fields every participant already
sees of every other participant. It is search-only, so it cannot be paged into a full customer
list in one call. It searches the curated set of existing organizations only (see
[Assumptions](#assumptions)). Whether every organization should be findable at all is a product
question.

**Selection.** The request names organizations by `id` only, in chain order. Roles and
positions are not sent; the server derives them (first: the exporter; last: `FINAL_BUYER`;
between: `TRADER`), as it derives every other server-decided field.

**What each named organization gains on commit**, through existing rules only:

| Gained                                                                                                   | Rule                                 |
| -------------------------------------------------------------------------------------------------------- | ------------------------------------ |
| The voyage in its list, and its details: vessel, commodity, total quantity, ports, laycan                | Participation (ADR 0006)             |
| The whole trade string (every party's name, country and place) and the participant directory             | ADR 0010                             |
| The voyage's event stream; timeline entries for the voyage itself                                        | ADR 0015, ADR 0009                   |
| Its own contracts: as buyer, give instructions and review documents; as seller, issue notices and upload | ADR 0011 to 0014, its contracts only |

Nothing about contracts it is not party to: notices, instructions, documents and their timeline
events stay counterparty-only. The voyage's earlier "Created the voyage" entry becomes visible
to the new participants, with the exporter user's name, as it is for every participant today.

Gaining access is not accepting anything. A named organization is not asked, and its access
does not record that it agreed to the chain or to any contract (see
[Assumptions](#assumptions)).

### 3. One atomic command, not incremental editing

| Concern                      | One atomic setup (chosen)                                                                             | Incremental editing (add a party, add a contract)                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation                   | `validateTradeString` unchanged, on the complete candidate chain                                      | Needs rules for partial chains ("valid so far"), a second validator, and a "draft" state, because `toTradeString` refuses to read an incomplete chain                   |
| Access                       | Granted once, to a complete, validated chain                                                          | Granted step by step: an organization can see a voyage whose chain is not settled, and may act on contracts that are later edited                                       |
| Concurrency                  | One lock and one state check: exactly one setup wins, every other gets 409                            | A version on the chain, `If-Match` on every edit, and edits racing notices or instructions already given on existing edges                                              |
| Audit                        | One event that records the chain as committed                                                         | One event per edit; the chain at any moment must be reconstructed                                                                                                       |
| What can go wrong for a user | The exporter must know the whole chain before submitting. A mistake cannot be corrected in this slice | Mistakes are fixable, but removing a party with bilateral data attached raises questions this milestone cannot answer (what happens to its instructions and documents?) |
| Size                         | One command, no new tables or columns                                                                 | Several commands, a chain version, and edit rules for edges with dependent data                                                                                         |

The atomic command is the smallest change that keeps every existing invariant as it is. Its
cost, no correction, is real. It is accepted for this slice and named as the first follow-up.

### 4. Contract, outcomes and competing requests

**Request.** `POST /api/voyages/:voyageId/trade-string`, body `ConfigureTradeStringRequest`:

```json
{
  "parties": [
    { "organizationId": "<the voyage's exporter>" },
    { "organizationId": "<a trader>" },
    { "organizationId": "<the final buyer>" }
  ]
}
```

A closed object (`z.strictObject`, like `CreateVoyageRequest`): 2 to 10 parties, distinct
UUIDs (a repeated one is refused by the schema, at its second place), nothing else. The first
party must be the voyage's exporter. Naming it, rather than leaving it implicit, makes the
request read as the chain the user saw and confirmed. No precondition header is required. One
that is sent is evaluated, never ignored (see "Conditional headers" below).

**Response.** `200 OK` with the existing `TradeString` body, exactly what
`GET .../trade-string` returns from then on. There is no `ETag` and no `Location`: the string
has no version until editing exists, and its URL is the one the request was sent to.

**Why `POST` and 409, not a conditional `PUT`.** The alternative is
`PUT .../trade-string` with `If-None-Match: *` (412 when a chain exists, 428 without the
header), as for first instructions and first uploads. It fits less well here:

- `If-None-Match: *` means "only if no current representation exists". The trade string always
  has one: `GET` answers 200 with empty arrays before setup, and that stays. The precondition
  would have to mean "only if empty", or `GET` would have to start answering 404 before setup,
  which changes a working read and the "not configured" card for no gain.
- `PUT` asks the server to make the target's state the enclosed representation. This body is
  not a representation of the trade string: it names organizations only, and the server derives
  their roles and the positions, creates participants and grants them access. That is
  processing the body under the resource's own rules, which is what `POST` is for. Idempotency
  is not the reason: a conditional `PUT` would be idempotent too, because idempotency concerns
  the effect on the server, not the status code. Repeating it would change nothing more, even
  though the repetition answers 412 instead of 201.
- Without a version, a required precondition adds nothing the state check does not already
  decide, and adds a 428 path every client must get right. "A chain is already recorded" is a
  conflict with the resource's state, the same for seeded voyages, a second attempt and a lost
  race: one 409.
- `PUT` with `If-Match` stays free for the later editing command, when the string gains a
  version.

The cost is a departure from the required preconditions of instructions and documents. A retry
after a lost response (the setup committed, the reply did not arrive) gets 409; the client then
reads the string and finds its chain recorded.

**Conditional headers.** None is required, and none that is sent is silently dropped. The trade
string always has a current representation (empty before setup) and has neither an entity tag
nor a modification date, so RFC 9110 (section 13) decides each one, in its order:

| Header                                         | Evaluates to                                                                       | Outcome                    |
| ---------------------------------------------- | ---------------------------------------------------------------------------------- | -------------------------- |
| `If-Match: *`                                  | true: a current representation exists                                              | goes on                    |
| `If-Match: "x", …` (any list, even empty)      | false: the trade string has no entity tag to match                                 | 412                        |
| `If-None-Match: *`                             | false: a current representation exists, even an empty one                          | 412                        |
| `If-None-Match: "x", …` (any list, even empty) | true: no entity tag can match                                                      | goes on                    |
| `If-Unmodified-Since`                          | not evaluated: there is no modification date, and section 13.1.4 says to ignore it | goes on                    |
| `If-Modified-Since`, `If-Range`                | not applicable: they apply to `GET` and `HEAD` only                                | goes on                    |
| Malformed `If-Match`/`If-None-Match`           | not `*` and not a list of entity tags                                              | 400 (`header.if-match`, …) |

The lists are read as RFC 9110 writes them (sections 5.6.1 and 8.8.3), not split on commas: a
comma inside an opaque tag is content (`"a,b"` is one tag); an opaque tag holds visible ASCII
other than `"`, or obs-text, never a space or a tab; `W/` (uppercase) marks a weak tag and `""`
is a valid empty tag; `*` counts only alone, so `"*"` is an ordinary tag and `*, "a"` is
malformed; empty list elements (`"a", , "b"`, a leading or trailing comma) are ignored, so a
header with no element is an empty list. The versioned helpers of instructions and documents
keep their own, stricter parsing.

Preconditions are evaluated after authorization and the state checks, and before the chain is
validated (row 13 below). Section 13.2.1 says to ignore preconditions when the response without
them would not be 2xx or 412, so a configured voyage answers 409 whatever was sent.

**Outcomes**, in the order they are decided. The first that applies is the answer:

| #   | Status | When                                                                                                                                                                                                             |
| --- | ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 401    | No valid session when the request arrives (`AuthGuard`)                                                                                                                                                          |
| 2   | 403    | Cross-site request (the existing same-origin guard)                                                                                                                                                              |
| 3   | 400    | The body breaks the schema (an organization named twice included), or an `If-Match` or `If-None-Match` header is malformed                                                                                       |
| 4   | 403    | The caller is a viewer (`requireOperator` on the request's principal, before the voyage is read, as in every command)                                                                                            |
| 5   | 404    | The voyage does not exist or the caller's organization does not participate: identical bodies (the read scoped by `accessibleVoyages` before the lock finds no row)                                              |
| 6   | 401    | After the lock: the session has ended or been revoked (`SessionPrincipals.refresh`)                                                                                                                              |
| 7   | 403    | After the lock: the user is no longer an operator                                                                                                                                                                |
| 8   | 404    | After the lock: the user's current organization does not participate in the voyage (it changed meanwhile)                                                                                                        |
| 9   | 403    | After the lock: the current organization participates, but not as the voyage's exporter                                                                                                                          |
| 10  | 409    | **Already configured**: the voyage has at least one contract. Seeded chains, a second attempt, and the loser of a race                                                                                           |
| 11  | 409    | Not `PLANNED`                                                                                                                                                                                                    |
| 12  | 409    | It has participants other than its exporter (seeded TF-2026-0003)                                                                                                                                                |
| 13  | 412    | A precondition that was sent does not hold (see "Conditional headers")                                                                                                                                           |
| 14  | 400    | Business validation, all reported at once: the first party is not the exporter; an organization id is unknown (`body.parties.N.organizationId`); every `validateTradeString` violation, mapped to `body.parties` |

Rows 1 to 4 are decided before the transaction, 5 to 14 inside it, in that order. The three
409s are problem details with distinct `detail` messages; the client does not branch on them
(see 6).

**Why contracts before the other gates.** Authorization comes first (rows 5 to 9): a caller who
may not set up the voyage learns nothing about its state. Among the state checks, "already
configured" comes first because recording a chain also adds participants and may coexist with
any status. If the participant gate came first, a voyage configured by a concurrent request
would be refused as "has other participants", the side effect of configuration rather than the
reason. Checking contracts first gives every configured voyage the same answer, whether seeded
(TF-2026-0001: contracts, extra participants and `IN_TRANSIT`, answered "already configured"),
configured earlier through this command, or configured by the request that won a race.

**Competing setups.** The transaction (5) begins by reading the voyage scoped by
`accessibleVoyages`, then locking its row (`SELECT id FROM voyages WHERE id = $1 FOR NO KEY
UPDATE`). This
is the repository's existing lock-then-read pattern (`instruction-revisions.ts` share-locks an
instruction the same way). A second setup waits on that lock. Under READ COMMITTED each of its
later statements reads a fresh snapshot: it revalidates the session and role (1), then sees the
first setup's contracts and answers 409 "already configured". `FOR NO KEY UPDATE` does not
conflict with the key-share locks that foreign keys take, so it blocks only other setups. Behind
the lock, as the last line of defence: the unique `(voyage_id, position)` and
`(voyage_id, organization_id, role)` indexes, and a new partial unique index allowing one setup
event per voyage. A conflict on any of them aborts the whole transaction.

### 5. One transaction: participants, contracts and audit

Inside one interactive `$transaction`:

1. Read the voyage scoped by `accessibleVoyages(principal)`, then lock its row: no row means 404. (The scope stays in one place, the Prisma predicate, rather than restated in SQL; every
   check after the lock is made again anyway.)
2. Read the session again (`SessionPrincipals.refresh`): none means 401; `requireOperator` on the
   result, or 403.
3. Re-read the current organization's participation in the voyage: none means 404; a
   participation other than `EXPORTER` means 403.
4. Check the state, in this order: any contract (409, already configured); not `PLANNED` (409);
   participants other than the exporter (409).
5. Evaluate the preconditions that were sent, if any (412).
6. Resolve the organization ids (unknown ids are 400). Build the candidate chain with
   provisional participant ids, with the existing exporter participant first, and run
   `validateTradeString`. Any violation is 400.
7. Insert the `TRADER` and `FINAL_BUYER` participants (`createManyAndReturn`), then contracts
   1..n between consecutive participants.
8. Read the string back through `tradeStringSelect` and `toTradeString`, which validates the
   stored chain a second time. That is the response.
9. Record `VOYAGE_TRADE_STRING_CONFIGURED` through `AuditTrail.record`, with the refreshed
   actor, the parties (`organizationId`, `role`, `participantId`) and contracts (`contractId`,
   `position`, `sellerOrganizationId`, `buyerOrganizationId`) as committed.

Any exception rolls back all of it: participants, contracts and the event. Nothing is published
to event streams (see 6). Database changes, in two migrations because PostgreSQL cannot use an
enum value in the transaction that adds it:

- add `VOYAGE_TRADE_STRING_CONFIGURED` to `audit_action`;
- add a `CHECK` that its payload has `parties` and `contracts` arrays, and
  `CREATE UNIQUE INDEX audit_events_one_trade_string_configured ON audit_events (voyage_id)
WHERE action = 'VOYAGE_TRADE_STRING_CONFIGURED'`.

No new tables or columns.

**Timeline.** The action joins `VOYAGE_ACTIONS` in `audit-timeline.ts`, visible to every
participant like the voyage's creation. Its timeline entry carries no payload facts
("Set up the trade string", who, when): the parties are already in the trade string.

### 6. Effects on visibility, bilateral panels and caches

- **Existing voyages.** Unchanged. The setup refuses every voyage with contracts, and every
  voyage with extra participants, with 409, so seeded and operational chains cannot be touched.
  No read rule changes. `GET .../trade-string` still answers 200 with empty arrays for a voyage
  without contracts.
- **The exporter's page.** On 200, the mutation invalidates the voyage's detail key prefix,
  `[...scope, 'voyages', 'detail', voyageId]`. That refreshes the details (participants), the
  trade string, `my-contracts`, notices, instructions, documents and the timeline, all nested
  under it. It also invalidates `lists(scope)`. Like every write, the result is dropped if the
  identity changed meanwhile. The notice and instruction panels move from "not a party to a sale
  contract" to their empty states for contract 1.
- **A 409 on the exporter's page.** The mutation invalidates the same keys and the form waits
  for the trade string. If it now has parties, the card shows the recorded string with a note
  that the trade string was already set up, and keeps nothing to re-send. If it is still empty,
  the voyage cannot be set up (not `PLANNED`, or other participants), and the form shows the
  409's message and stays closed.
- **New participants.** They see the voyage on their next request: list, details, string, their
  own contracts. Nothing is pushed to them. They have no stream on a voyage they could not see,
  and there are no notifications.
- **Other open pages of the exporter.** Not told in this slice. Stream signals are per contract
  ([ADR 0015](0015-voyage-event-streams.md)), and a voyage-level signal is a separate change.
  The details, trade string and `my-contracts` queries are not polled. After `staleTime`
  (30 s) they become stale, which by itself fetches nothing: it only lets the next trigger
  refetch them, such as the window regaining focus, the component remounting, the network
  reconnecting, or a reload. Until such a trigger, the page keeps showing "Trade string not
  configured". A setup attempted from it gets 409 and the form shows the recorded string, as
  above. An already open stream needs no change for later bilateral signals: it re-reads the
  organization's contracts before every delivery.
- **Bilateral workflows.** Unchanged and immediately usable, because they key on contracts and
  participation, which now exist: `If-None-Match: *` for the first instructions and the first
  upload, and so on.

## Alternatives considered

- **Incremental editing** of participants and contracts: see the comparison in 3. Rejected for
  this slice, because partial chains break the existing validation and read model. It is the
  natural shape of a later "each seller records its own sale" model.
- **`PUT .../trade-string` with `If-None-Match: *`** (412 when configured, 428 without the
  header): see 4. Rejected because the trade string always has a representation, because the
  body is not a representation to store but organizations from which the server derives a chain
  and grants access, and because a required precondition without a version adds a failure mode
  without adding a guarantee.
- **The chain inside `POST /api/voyages`.** One request instead of two, but it couples two
  decisions with different information: the shipment, known first, and the buyers, often known
  later. It also gives the voyage form a second, unrelated failure mode, and leaves voyages
  created without a chain still needing this command.
- **Separate endpoints for participants and contracts**, called in sequence. The intermediate
  states are visible and invalid, and the client becomes responsible for atomicity.
- **A full organization directory**, or **organization ids entered by hand.** The first lists
  every customer to every operator; the second is unusable and invites typos that grant access
  to the wrong company. Search-only is the smallest workable middle.
- **`SERIALIZABLE` isolation, or a version column on `voyages`**, instead of the row lock.
  `SERIALIZABLE` would need retries the codebase does not have. A version needs a migration and a
  meaning ("setup version") that editing would define better later. The lock reuses an existing
  pattern and the unique indexes already exist.

## Consequences

- New voyages become fully usable without the seed or SQL: create, set up, then the existing
  bilateral workflows. Every existing invariant, validator and read rule is reused unchanged,
  including `GET .../trade-string` before setup.
- One command, one lock, one event: competing setups, invalid chains and audit failures all end
  with the voyage exactly as before or exactly as set up, nothing in between. Every refusal of
  an already configured voyage is the same 409.
- The command departs from the precondition convention of instructions and documents. A plain
  request never gets 428 or 412; 412 answers only a precondition the client chose to send. A
  retry after a lost response gets 409.
- The session and role are as of the refresh after the lock, not as of commit. A sign-out or
  demotion in that short window applies from the next request, as for uploads.
- Access is granted by one organization's decision, to others, without their consent, and is
  permanent in this slice. Configuration records no acceptance by them. That is acceptable only
  while organizations are a known, curated set, and it is the first thing the product questions
  below must settle.
- A mistake in the chain cannot be undone through the API.
- The organization search exposes names and countries of organizations to operators who search
  for them. That is the same information participants already see of each other, but it is
  available before any shared voyage exists.
- Pages of the exporter other than the one that set up the voyage stay stale until something
  triggers a refetch. A voyage-level stream signal is a possible follow-up to ADR 0015.

## Acceptance scenarios

Each is meant as a PostgreSQL/HTTP integration test unless marked otherwise.

1. **Create, set up, buyer gains access, bilateral workflow usable.**
   - Ana (Cerrado operator) creates a voyage (`POST /api/voyages`, 201).
     `GET .../trade-string` answers 200 with `parties: []` and `edges: []`.
   - Ana sets up Cerrado → Lacustra → Rhine Valley (`POST .../trade-string`, no precondition
     header, 200, the string in order). `GET .../trade-string` now answers the same body.
   - Claire (Lacustra) now finds the voyage in her list. Its trade string shows three parties.
     `my-contracts` shows contract 1 as `BUYER` and contract 2 as `SELLER`.
   - Claire gives instructions on contract 1 (201). Ana acknowledges them, uploads a PDF, and
     Claire approves it.
   - Katrin (Rhine Valley) sees contract 2 only, none of contract 1's notices, instructions or
     documents, and the timeline entries "Created the voyage" and "Set up the trade string".
   - A second `POST .../trade-string` from Ana, with the same or another chain, answers 409
     already configured and writes nothing.
   - Chromium smoke: voyage creation and setup through the UI, then the buyer's page in a second
     context and its instructions, which reach the exporter's page.
2. **Invalid chain, no partial writes.** Each of the following answers 400 and leaves the voyage
   with one participant, no contracts, only its `VOYAGE_CREATED` event, and a
   `GET .../trade-string` of 200 with empty arrays; a valid setup then succeeds:
   - one party (schema);
   - a repeated organization (schema, reported at its second place);
   - a first party that is not the exporter;
   - an unknown organization id.

   A write that fails after validation (the contract insert, forced to fail after the
   participants were inserted) answers 500 and also leaves nothing.

3. **Two concurrent setups, exactly one success.** Two setups are started against a held lock on
   the voyage row (the existing race helper): first with the same chain, then with different
   chains. One answers 200 and the other 409 already configured, never the "other
   participants" 409. There is exactly one set of participants and contracts, the winner's, and
   exactly one setup event.
4. **Revalidation after waiting for the lock.** A setup is started against a held lock. While it
   waits:
   - Ana's session is revoked (sign-out): on release it answers 401;
   - Ana is made a viewer: on release it answers 403;
   - Ana is moved to an organization that does not participate: on release it answers 404.

   None writes anything, and a later setup by another Cerrado operator succeeds.

5. **Audit failure rolls back everything.** With the audit insert forced to fail (the existing
   pattern in each feature's tests), the setup answers 500. No participant, contract or event is
   added, and a later setup succeeds.
6. **Who may set it up, and check precedence.**
   - Rafael (Cerrado viewer) gets 403.
   - Lucía (Pampa Litoral, not a participant) gets a 404 identical to a missing voyage's.
   - After setup, Claire (participant, not exporter) gets 403, not 409: authorization comes
     before the state.
   - TF-2026-0001 (contracts, extra participants, `IN_TRANSIT`) answers 409 already configured.
   - TF-2026-0003 (`PLANNED`, extra participants, no contracts) answers 409 for its other
     participants.
   - A new voyage that is not `PLANNED` answers 409 for its status.
   - Conditional headers: `If-Match: *`, `If-None-Match` with any list of tags (`"a,b"`, a
     mixed list with quoted commas, an empty list) and `If-Unmodified-Since` set the voyage up;
     `If-Match` with any list of tags (`"a,b"`, weak tags, `"*"`, an empty list) and
     `If-None-Match: *` answer 412, before a chain that would be 400; a malformed one (an
     unterminated tag, a space or tab inside a tag, `w/`, `*` in a list) answers 400 and
     writes nothing; a configured voyage answers 409 whatever is sent.
   - None writes anything.
   - Organization search: 403 for viewers; never the caller's own organization; never more than
     20 results; `%`, `_` and `\` in the search text match literally; participants and
     strangers look the same.

## Implementation sequence (smallest, API first)

All nine steps are implemented. `apps/api/test/trade-string-setup.int-spec.ts` and
`organizations.int-spec.ts` cover scenarios 1 to 6 over HTTP;
`apps/web/src/features/voyages/pages/VoyageTradeStringSetup.test.tsx` covers the form (steps 7
and 8); `e2e/tests/trade-string-setup.spec.ts` is scenario 1's Chromium journey, up to the
buyer's instructions reaching the exporter (the upload and review of scenario 1 are covered
over HTTP, not in Chromium).

As built, the form also:

- shows exporters why setup is not offered on an empty voyage (viewer, not `PLANNED`, other
  participants), and nothing at all on a voyage whose string is set up or to other participants;
- searches from two characters, debounced, never offers the caller's own organization, and stops
  adding at ten organizations in all;
- moves rows with labelled "Move … up/down" buttons, keeps focus on the moved row and announces
  each change in a status region;
- goes back to editing on a 400, with each refusal on its row, and clears refusals on any change;
- after a 409, refetches and either shows the recorded string ("Already set up") or the 409's
  message and why the voyage cannot be set up; an open form whose voyage stops being eligible
  after a refresh is replaced by a notice;
- ignores every outcome of a setup sent under a session that has since ended, even when the same
  user has signed back in, as the document commands do.

1. **Contracts** (`packages/contracts`): `ConfigureTradeStringRequestSchema`, the
   organization-search query and response, and the timeline event member, with schema tests.
2. **Migrations**: the enum value, then the payload `CHECK` and the partial unique index; Prisma
   schema enum.
3. **Domain** (pure, unit-tested): build the candidate chain from ordered organizations, with
   derived roles and provisional participant ids, and run `validateTradeString` on it. Map
   violations to request paths.
4. **Organization search** endpoint, with integration tests.
5. **Setup command**: service and controller (lock, session refresh, checks in the order of 4,
   writes, read-back, audit), OpenAPI (200, 400, 401, 403, 404, 409, 412), and integration tests for
   scenarios 1 to 6, including the race, the revalidation after the lock and the forced audit
   failure.
6. **Timeline**: add the action to `VOYAGE_ACTIONS` and map it, with an integration test.

Then the UI:

7. **Web API and mutation hook**: a plain `POST` with no precondition header; on 200 and on 409,
   invalidation of the detail prefix and the lists; results dropped after an identity change;
   the timeline label; jsdom tests.
8. **Setup form** on the trade-string card, for exporter operators while the voyage is empty and
   `PLANNED`:
   - the exporter fixed first;
   - organizations found through search, added as traders and a final buyer, reorderable;
   - a review step that shows the chain and what each named organization will see, and says
     that naming them grants access but does not record their agreement;
   - 400 violations shown per row;
   - 409 with a recorded string: the card shows that string and keeps nothing to re-send;
     409 without one: the form shows the message and closes.

   jsdom tests.

9. **Chromium smoke** for scenario 1; then the README, domain model and MVP status, and this
   ADR to "Accepted".

## Unresolved product questions

These change the design if answered differently. The proposal above takes the first, simplest
reading of each, as stated in [Assumptions](#assumptions).

- **Who knows the chain?** The proposal assumes the exporter knows every downstream party. In
  practice a seller often knows only its own buyer, and traders may keep their buyers from their
  suppliers. The alternative, each seller recording its own onward sale, is incremental by
  nature (see 3) and would need a per-voyage visibility policy (ADR 0010's fallback).
- **Correcting mistakes.** A wrong party gains access and cannot be removed in this slice, and
  voyages cannot be cancelled through the API. What is the remedy: an operator-run fix, a
  "replace while nothing bilateral exists yet" command, or cancellation?
- **The directory.** Should every organization be findable by name, or only those that opt in?
  Is name and country enough to tell two similarly named companies apart, or do organizations
  need an external identifier (for example an LEI)? Who adds organizations to the curated set?
- **Consent and notification.** Named organizations gain access, and obligations, without being
  asked or told, and configuration records no acceptance. Is an acceptance step needed before
  access, and who is notified, how?
- **Service providers.** Surveyors and shipping agents are not part of this setup. Do they join
  in the same step, later, or by another party's action?
- **Which voyages.** Only `PLANNED`, and only with no other participants: is that the right gate,
  and should the 10-party limit be different?
