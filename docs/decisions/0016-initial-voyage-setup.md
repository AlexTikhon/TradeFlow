# 0016. Initial voyage setup: one atomic command records a new voyage's whole trade chain

- **Status:** Proposed (not implemented)
- **Date:** 2026-10-18

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
- **Participation is the access grant** ([ADR 0006](0006-participation-based-access.md)).
  Writing a `voyage_participants` row is what lets an organization see a voyage. Recording a
  chain therefore grants access to every organization in it, at once.
- **Everyone in the chain sees all of it** ([ADR 0010](0010-trade-string-visibility.md)):
  every participant reads the topology (every party's name and country, in order) and the
  participant directory.
- **Writes follow one convention**: role checked in the service (`requireOperator`,
  [ADR 0008](0008-user-roles.md)), visibility through `accessibleVoyages`, a conditional write
  and its audit event in one transaction ([ADR 0009](0009-transactional-audit-events.md)), and
  HTTP preconditions for "create only if absent" (`If-None-Match: *`, 412 when it exists, 428
  without one), as for first instructions and first uploads.
- **No organization or user management exists**, and none is in scope: organizations are only
  ever selected, never created, invited or edited.

Out of scope: seeded voyages, voyages that already have contracts or other participants,
editing or extending a recorded chain, service providers, contract terms, invitations,
notifications, and organization or user CRUD.

## Decision (proposed)

**`PUT /api/voyages/:voyageId/trade-string` with `If-None-Match: *` records the complete chain
of a new, empty, `PLANNED` voyage in one transaction, together with its participants and one
audit event. An operator of the voyage's exporter may do it once. Organizations are chosen
through a minimal, search-only directory.**

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
- The exporter's participation is re-read inside the transaction, under the voyage's lock (see
  5). A removed participation or a demoted role between request and commit is honoured.

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
list in one call. Whether every organization should be findable at all is a product question.

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

### 3. One atomic command, not incremental editing

| Concern                      | One atomic setup (chosen)                                                                             | Incremental editing (add a party, add a contract)                                                                                                                       |
| ---------------------------- | ----------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Validation                   | `validateTradeString` unchanged, on the complete candidate chain                                      | Needs rules for partial chains ("valid so far"), a second validator, and a "draft" state, because `toTradeString` refuses to read an incomplete chain                   |
| Access                       | Granted once, to a complete, validated chain                                                          | Granted step by step: an organization can see a voyage whose chain is not settled, and may act on contracts that are later edited                                       |
| Concurrency                  | One lock, one precondition (`If-None-Match: *`): exactly one setup wins                               | A version on the chain, `If-Match` on every edit, and edits racing notices or instructions already given on existing edges                                              |
| Audit                        | One event that records the chain as committed                                                         | One event per edit; the chain at any moment must be reconstructed                                                                                                       |
| What can go wrong for a user | The exporter must know the whole chain before submitting. A mistake cannot be corrected in this slice | Mistakes are fixable, but removing a party with bilateral data attached raises questions this milestone cannot answer (what happens to its instructions and documents?) |
| Size                         | One command, no new tables or columns                                                                 | Several commands, a chain version, and edit rules for edges with dependent data                                                                                         |

The atomic command is the smallest change that keeps every existing invariant as it is. Its
cost, no correction, is real. It is accepted for this slice and named as the first follow-up.

### 4. Contract, preconditions and competing requests

**Request.** `PUT /api/voyages/:voyageId/trade-string`, header `If-None-Match: *` (required),
body `ConfigureTradeStringRequest`:

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
UUIDs, nothing else. The first party must be the voyage's exporter. Naming it, rather than
leaving it implicit, makes the request read as the chain the user saw and confirmed.

**Response.** `201 Created` with the existing `TradeString` body, exactly what
`GET .../trade-string` will return from then on. There is no `ETag`: the string has no version
until editing exists.

**Outcomes**, in the order they are decided:

| Status | When                                                                                                                                                                                                             |
| ------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 401    | No valid session                                                                                                                                                                                                 |
| 403    | Cross-site request (the existing same-origin guard)                                                                                                                                                              |
| 400    | The body breaks the schema                                                                                                                                                                                       |
| 428    | No `If-None-Match: *` (and `If-Match` is not accepted: there is nothing to match yet)                                                                                                                            |
| 403    | The caller is a viewer (`requireOperator`, before the voyage is read, as in every command)                                                                                                                       |
| 404    | The voyage does not exist or the caller's organization does not participate: identical bodies                                                                                                                    |
| 403    | The caller's organization participates, but not as the voyage's exporter                                                                                                                                         |
| 409    | The voyage cannot be set up: not `PLANNED`, or it has participants other than its exporter (seeded TF-2026-0003)                                                                                                 |
| 412    | A trade string already exists: seeded voyages, and the loser of a race                                                                                                                                           |
| 400    | Business validation, all reported at once: the first party is not the exporter; an organization id is unknown (`body.parties.N.organizationId`); every `validateTradeString` violation, mapped to `body.parties` |

The schema validation comes first, as in every controller; the business validation comes last,
because it needs the locked state. A 400 from either writes nothing.

**Competing setups.** The transaction (5) begins by locking the voyage row
(`SELECT ... FROM voyages WHERE id = $1 FOR NO KEY UPDATE`). This is the repository's existing
lock-then-read pattern (`instruction-revisions.ts` share-locks an instruction the same way). A
second setup waits on that lock. Under READ COMMITTED its next statement reads a fresh snapshot,
sees the first setup's contracts, and answers 412. `FOR NO KEY UPDATE` does not conflict with
the key-share locks that foreign keys take, so it blocks only other setups. Behind the lock, as
the last line of defence: the unique `(voyage_id, position)` and `(voyage_id, organization_id,
role)` indexes, and a new partial unique index allowing one setup event per voyage. A conflict on
any of them aborts the whole transaction.

### 5. One transaction: participants, contracts and audit

Inside one interactive `$transaction`:

1. Lock the voyage, scoped by `accessibleVoyages(principal)`: no row means 404.
2. Re-read the caller's participation and role: exporter operator, or 403.
3. Check the state: `PLANNED` and no other participants (409); no contracts (412).
4. Resolve the organization ids (unknown ids are 400). Build the candidate chain with
   provisional participant ids, with the existing exporter participant first, and run
   `validateTradeString`. Any violation is 400.
5. Insert the `TRADER` and `FINAL_BUYER` participants (`createManyAndReturn`), then contracts
   1..n between consecutive participants.
6. Read the string back through `tradeStringSelect` and `toTradeString`, which validates the
   stored chain a second time. That is the response.
7. Record `VOYAGE_TRADE_STRING_CONFIGURED` through `AuditTrail.record`, with the parties
   (`organizationId`, `role`, `participantId`) and contracts (`contractId`, `position`,
   `sellerOrganizationId`, `buyerOrganizationId`) as committed.

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

- **Existing voyages.** Unchanged. The setup refuses every voyage with contracts (412) or extra
  participants (409), so seeded and operational chains cannot be touched. No read rule changes.
- **The exporter's page.** On 201, the mutation invalidates the voyage's detail key prefix,
  `[...scope, 'voyages', 'detail', voyageId]`. That refreshes the details (participants), the
  trade string, `my-contracts`, notices, instructions, documents and the timeline, all nested
  under it. It also invalidates `lists(scope)`. Like every write, the result is dropped if the
  identity changed meanwhile. The notice and instruction panels move from "not a party to a sale
  contract" to their empty states for contract 1.
- **New participants.** They see the voyage on their next request: list, details, string, their
  own contracts. Nothing is pushed to them. They have no stream on a voyage they could not see,
  and there are no notifications.
- **Other open pages of the exporter.** Not told in this slice. Stream signals are per contract
  ([ADR 0015](0015-voyage-event-streams.md)), and a voyage-level signal is a separate change.
  Such a page keeps showing "Trade string not configured" until its next refetch (focus, reload,
  `staleTime`). A setup attempted from it gets 412, and the form then shows the recorded string.
  An already open stream needs no change for later bilateral signals: it re-reads the
  organization's contracts before every delivery.
- **Bilateral workflows.** Unchanged and immediately usable, because they key on contracts and
  participation, which now exist: `If-None-Match: *` for the first instructions and the first
  upload, and so on.

## Alternatives considered

- **Incremental editing** of participants and contracts: see the comparison in 3. Rejected for
  this slice, because partial chains break the existing validation and read model. It is the
  natural shape of a later "each seller records its own sale" model.
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
  bilateral workflows. Every existing invariant, validator and read rule is reused unchanged.
- One command, one lock, one event: competing setups, invalid chains and audit failures all end
  with the voyage exactly as before or exactly as set up, nothing in between.
- Access is granted by one organization's decision, to others, without their consent, and is
  permanent in this slice. That is acceptable only while organizations are a known, curated set,
  and it is the first thing the product questions below must settle.
- A mistake in the chain cannot be undone through the API.
- The organization search exposes names and countries of organizations to operators who search
  for them. That is the same information participants already see of each other, but it is
  available before any shared voyage exists.
- Pages of the exporter other than the one that set up the voyage stay stale until they refetch.
  A voyage-level stream signal is a possible follow-up to ADR 0015.

## Acceptance scenarios

Each is meant as a PostgreSQL/HTTP integration test unless marked otherwise.

1. **Create, set up, buyer gains access, bilateral workflow usable.**
   - Ana (Cerrado operator) creates a voyage (`POST /api/voyages`, 201) and sets up
     Cerrado → Lacustra → Rhine Valley (`PUT .../trade-string` with `If-None-Match: *`, 201,
     the string in order).
   - Claire (Lacustra) now finds the voyage in her list. Its trade string shows three parties.
     `my-contracts` shows contract 1 as `BUYER` and contract 2 as `SELLER`.
   - Claire gives instructions on contract 1 (201). Ana acknowledges them, uploads a PDF, and
     Claire approves it.
   - Katrin (Rhine Valley) sees contract 2 only, none of contract 1's notices, instructions or
     documents, and the timeline entries "Created the voyage" and "Set up the trade string".
   - Chromium smoke: the same, from voyage creation to the buyer's page in a second context.
2. **Invalid chain, no partial writes.** Each of the following answers 400 and leaves the voyage
   with one participant, no contracts and only its `VOYAGE_CREATED` event; a valid setup then
   succeeds:
   - one party (schema);
   - a repeated organization (`CYCLE` or `BRANCH`);
   - a first party that is not the exporter;
   - an unknown organization id.

   A write that fails after validation (for example a forced foreign-key violation on the last
   contract) answers 500 and also leaves nothing.

3. **Two concurrent setups, exactly one success.** Two setups are started against a held lock on
   the voyage row (the existing race helper): first with the same chain, then with different
   chains. One answers 201 and the other 412. There is exactly one set of participants and
   contracts, the winner's, and exactly one setup event.
4. **Audit failure rolls back everything.** With the audit insert forced to fail (the existing
   pattern in each feature's tests), the setup answers 500. No participant, contract or event is
   added, and a later setup succeeds.
5. **Viewers and unrelated organizations cannot set it up.**
   - Rafael (Cerrado viewer) gets 403.
   - Lucía (Pampa Litoral, not a participant) gets a 404 identical to a missing voyage's.
   - After setup, Claire (participant, not exporter) gets 403.
   - None writes anything.
   - Also: TF-2026-0001 answers 412, TF-2026-0003 answers 409, a voyage not `PLANNED` answers
     409, and a request without `If-None-Match: *` answers 428.
   - Organization search: 403 for viewers; never the caller's own organization; never more than
     20 results.

## Implementation sequence (smallest, API first)

1. **Contracts** (`packages/contracts`): `ConfigureTradeStringRequestSchema`, the
   organization-search query and response, and the timeline event member, with schema tests.
2. **Migrations**: the enum value, then the payload `CHECK` and the partial unique index; Prisma
   schema enum.
3. **Domain** (pure, unit-tested): build the candidate chain from ordered organizations, with
   derived roles and provisional participant ids, and run `validateTradeString` on it. Map
   violations to request paths.
4. **Organization search** endpoint, with integration tests.
5. **Setup command**: service and controller (lock, checks, writes, read-back, audit), OpenAPI,
   and integration tests for scenarios 1 to 5, including the race and the forced audit failure.
6. **Timeline**: add the action to `VOYAGE_ACTIONS` and map it, with an integration test.

Then the UI:

7. **Web API and mutation hook**: `If-None-Match: *`, invalidation of the detail prefix and the
   lists, results dropped after an identity change; the timeline label; jsdom tests.
8. **Setup form** on the trade-string card, for exporter operators while the voyage is empty and
   `PLANNED`:
   - the exporter fixed first;
   - organizations found through search, added as traders and a final buyer, reorderable;
   - a review step that shows the chain and what each named organization will see;
   - 400 violations shown per row;
   - 412 shows the recorded string and keeps nothing to re-send.

   jsdom tests.

9. **Chromium smoke** for scenario 1; then the README, domain model and MVP status, and this
   ADR to "Accepted".

## Unresolved product questions

These change the design if answered differently. The proposal above takes the first, simplest
reading of each.

- **Who knows the chain?** The proposal assumes the exporter knows every downstream party. In
  practice a seller often knows only its own buyer, and traders may keep their buyers from their
  suppliers. The alternative, each seller recording its own onward sale, is incremental by
  nature (see 3) and would need a per-voyage visibility policy (ADR 0010's fallback).
- **Correcting mistakes.** A wrong party gains access and cannot be removed in this slice, and
  voyages cannot be cancelled through the API. What is the remedy: an operator-run fix, a
  "replace while nothing bilateral exists yet" command, or cancellation?
- **The directory.** Should every organization be findable by name, or only those that opt in?
  Is name and country enough to tell two similarly named companies apart, or do organizations
  need an external identifier (for example an LEI)?
- **Consent and notification.** Named organizations gain access, and obligations, without being
  asked or told. Is an acceptance step needed before access, and who is notified, how?
- **Service providers.** Surveyors and shipping agents are not part of this setup. Do they join
  in the same step, later, or by another party's action?
- **Which voyages.** Only `PLANNED`, and only with no other participants: is that the right gate,
  and should the 10-party limit be different?
