# 0011. ETA notices: counterparty-only, issued then acknowledged, overdue derived (MVP)

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

Milestone 5 adds the first business object that travels **along** the trade string: an ETA
notice, in which the seller under a sale contract tells its buyer when the vessel is expected,
and asks the buyer to confirm receipt by a deadline. It is also the first object whose content
is confidential to two organizations, not shared by every participant.

The forces:

- **Confidential to the contract.** [ADR 0010](0010-trade-string-visibility.md) lets every
  participant see who sells to whom, and says explicitly that this grants nothing more. What a
  seller tells its buyer is not the surveyor's business, nor that of the trader two contracts
  down the string.
- **Contract ids are new on the wire.** To issue under a contract, the seller's client must name
  it. The shared topology must not start carrying contract ids to answer that.
- **Receipt is not acceptance.** In commodity trade an acknowledged ETA is evidence that the
  buyer was told in time. It is not agreement to anything commercial, and the UI and API must
  not suggest it is.
- **Deadlines pass while nothing runs.** There is no scheduler or queue
  ([architecture](../architecture.md#evolution)), and none should be needed to show that a
  deadline was missed.
- **Two people can press the button at once.** Two operators of the buyer may acknowledge the
  same notice concurrently. Exactly one acknowledgement, and one audit event, may result.
- **Module ownership.** The voyages module owns `trade_contracts` and `voyage_participants`
  ([architecture](../architecture.md#module-boundaries)).

## Decision

**One notice type (`ETA`), one workflow (`ISSUED → ACKNOWLEDGED`), visible only to the
contract's two counterparties.**

### Who may do what

| Action      | Who                                                             | Refusal                       |
| ----------- | --------------------------------------------------------------- | ----------------------------- |
| Read        | Any user of the contract's seller or buyer organization         | 404, as for a missing notice  |
| Issue       | An `OPERATOR` of the contract's **seller** organization         | 403 (role, or the buyer side) |
| Acknowledge | An `OPERATOR` of the contract's **buyer** organization, once    | 403; 409 when already done    |
| Anyone else | Other participants (service providers, other traders) and users | 404, as for a missing notice  |

- **Counterparty status and current participation, both.** A contract is the organization's
  when it is the seller or buyer under it **and** it participates in the contract's voyage now
  (`accessibleVoyages`, [ADR 0006](0006-participation-based-access.md)). The composite foreign
  keys make the first imply the second today; the predicate (`counterpartyContracts`) states both
  so it does not depend on them.
- **Scoped in the database.** The voyages module exports `CounterpartyContracts`, the only way
  another module resolves a contract. It answers, in one query with both predicates inside, the
  reader's contracts on a voyage. The notices module then loads notices **only under those
  contract ids** and the voyage in the path. A notice under someone else's contract, of another
  voyage, or that does not exist is the same empty result and the same 404 (`Notice was not
found.`). Contract ids in a request body get the same treatment (`Contract was not found.`),
  so cross-voyage and foreign ids cannot reach anything.
- **Checked in the command service.** As with voyage creation
  ([ADR 0008](0008-user-roles.md)): validation (400), then the role (403), then the contract as
  the principal sees it (404), then its side (403), then the deadline against the server's clock
  (400). Participant roles (exporter, trader) do not decide anything here: the side of the
  contract does.
- **Contract ids have their own endpoint.** `GET /api/voyages/{id}/my-contracts` lists the
  organization's contracts on the voyage with their ids and its side. It is empty for a
  participant that is party to none. The trade-string response is unchanged and still carries
  no ids ([ADR 0010](0010-trade-string-visibility.md)).

### The workflow and its records

- A notice holds `estimatedArrivalAt`, `acknowledgementDueAt`, an optional message (at most
  1000 characters, never blank), the issuer (user and organization) and `issuedAt`, and, once
  acknowledged, the acknowledging user, organization and `acknowledgedAt`. All times are
  instants (`timestamptz`, ISO 8601 with an offset on input, UTC on output). Issuer, acknowledger
  and both times come from the session and the API's clock; a body that tries to set them is
  rejected.
- **Issued content is immutable.** No endpoint edits or deletes a notice. A trigger refuses any
  `UPDATE` that changes an issued column, and any change at all to an acknowledged notice, for
  every writer. A changed ETA is a new notice.
- **Acknowledging is one conditional update**:
  `UPDATE notices SET status = 'ACKNOWLEDGED', … WHERE id = $1 AND status = 'ISSUED'`. Under
  PostgreSQL's default `READ COMMITTED`, a concurrent second update waits for the first, then
  re-checks its condition against the committed row and changes nothing. Zero rows changed is a
  `409 Conflict`, and that transaction records no event.
- **Each command and its audit event commit together** ([ADR 0009](0009-transactional-audit-events.md)):
  `NOTICE_ISSUED` with the notice as issued, `NOTICE_ACKNOWLEDGED` with the time and whether it
  was late. If the event cannot be written, the notice is not issued, or stays unacknowledged.
  Partial unique indexes allow at most one event of each kind per notice, as a last line of
  defence behind the conditional update.

### MVP business rules for time

1. The deadline lies **after the moment of issue** (server clock) and **not after the estimated
   arrival**: a receipt confirmed after the vessel is in is no use to the seller. The second rule
   is also in the shared request schema; both are CHECK constraints.
2. A notice is **overdue** while it is `ISSUED` and its deadline has passed. That is derived
   whenever a notice is read (`overdue` in the response); nothing is stored or scheduled when a
   deadline passes. There is no `OVERDUE` status.
3. A **late acknowledgement is allowed**. It is recorded like any other; the notice is no longer
   overdue, its times show it was late, and the audit event records `late: true`.

## Alternatives considered

- **All participants see notices**, like the trade string. Simple, but it publishes what each
  seller tells its buyer to the whole string and every service provider. Rejected: ADR 0010 was
  written to stop exactly this inference.
- **403 for participants who are not counterparties.** Honest about the rule, but it confirms
  that a notice with that id exists. 404 keeps existence undisclosed, as for voyages.
- **Contract ids added to the trade string**, so the client can pick one. Every participant would
  receive ids it can do nothing with, and the shared view would start growing. A separate,
  counterparty-scoped endpoint fails closed.
- **The notices module joining `trade_contracts` itself.** One query instead of two, but it would
  restate the access rule outside the module that owns it, and couple notices to the contract
  table's shape.
- **A persisted `OVERDUE` status set by a scheduled job.** Needs a scheduler that does not exist,
  can lag or fail, and makes "overdue" a write that needs its own audit. Derivation is always
  right as of the read. A job will be worth it for _notifications_, not for state.
- **Optimistic concurrency with a `version` column and `If-Match`.** The general answer for
  editable aggregates (see [architecture](../architecture.md#evolution)). Here the only change is
  a one-way state transition, which the state itself guards.
- **`SELECT … FOR UPDATE` before deciding.** Also correct, but holds a lock across application
  code for no benefit over a conditional update.
- **Editable notices with versions.** Out of scope; issuing a new notice expresses a changed ETA
  without having to define who sees which version.

## Consequences

- Each counterparty sees the notices under its own contracts; a trader sees those it sent
  downstream and those it received from upstream, and nothing about contracts it is not part of.
  Service providers see nothing, and the panel tells them why.
- `overdue` is true as of the response. A page left open does not flip on its own; it changes on
  the next read (window focus, or after 30 seconds of staleness when something refetches).
- The seed's notices use times relative to when it runs, so the demo keeps one acknowledged,
  one awaiting and one overdue notice. Re-seeding replaces notices on seeded voyages, with fresh
  ids: audit events of earlier notices remain (the audit trail is append-only), and one
  acknowledgement event per notice id must not block acknowledging a re-created notice.
- Deleting a contract or voyage with notices is refused (`RESTRICT`), like audited voyages.
- The database does not know who the principal is, so "issuer is the seller's operator" is
  enforced by the service (and tested), not by a constraint. Postgres RLS remains the candidate
  for defence in depth (ADR 0006).
- **A second notice type** (vessel nomination, NOR) will decide how type-specific fields are
  stored: nullable columns with per-type CHECKs, or a detail table per type. The `type` column
  and the `notices` table name leave room for either.
