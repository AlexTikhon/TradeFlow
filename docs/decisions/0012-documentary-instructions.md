# 0012. Documentary instructions: revisioned per contract, conditional writes with ETags (MVP)

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Milestone 6 adds the first business object that travels **up** the trade string and is edited
after it is created: **documentary instructions**. Under each sale contract the buyer tells its
seller whom the shipping documents must name (the consignee and, optionally, a notify party) and
which documents to present (bill of lading, phytosanitary certificate, and so on, with how many
originals and copies). The seller confirms it received them.

The forces:

- **Confidential to the contract**, like ETA notices ([ADR 0011](0011-counterparty-notices.md)):
  what a buyer asks its seller for is not the surveyor's business, nor that of a trader further
  down the string.
- **The content changes, and history matters.** Buyers correct a consignee or add a certificate.
  When documents are later rejected, both sides must be able to show what was asked for, when,
  and what the seller confirmed having received. Overwriting the content would destroy exactly
  that evidence.
- **Two people can edit at once.** Two operators of the buyer may revise the same instructions
  from the same starting point; the seller may acknowledge while the buyer is revising. The ETA
  notice's one-way transition (ADR 0011) guarded itself; an editable aggregate does not. A lost
  update here means the seller confirms, or prepares documents for, content nobody intended.
- **Create races too.** "One set of instructions per contract" must hold when two operators give
  the first instructions at the same moment.
- **No new infrastructure.** One PostgreSQL database, one API process, no queue
  ([architecture](../architecture.md#evolution)).

## Decision

### The aggregate and its records

**One instruction aggregate per sale contract, with immutable revisions and per-revision
acknowledgements.** Three tables, owned by a new `documentary-instructions` module:

| Table                                      | Holds                                                                                                                      |
| ------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------- |
| `documentary_instructions`                 | The aggregate: its contract (unique), `version`, `current_revision_number`                                                 |
| `documentary_instruction_revisions`        | One row per revision: number, consignee, notify party, requirements (JSON), author and time. Never updated                 |
| `documentary_instruction_acknowledgements` | The seller's acknowledgement of one exact revision (unique per revision): who, for which organization, when. Never updated |

- **A revision is the whole content**, never a patch, numbered 1, 2, 3 per instruction without
  gaps. Revising writes a new row; the previous revisions stay exactly as written.
- **An acknowledgement names the exact revision** it confirms, in its row and in the URL
  (`.../revisions/{n}/acknowledgement`). Only the current revision can be acknowledged, once. A
  new revision starts unacknowledged; acknowledgements of earlier revisions remain on record.
- **Acknowledging records receipt, not acceptance**, as for notices.

### Who may do what

| Action                     | Who                                                           | Refusal                          |
| -------------------------- | ------------------------------------------------------------- | -------------------------------- |
| Read (with every revision) | Any user, viewers included, of the contract's buyer or seller | 404, as for missing instructions |
| Give or revise             | An `OPERATOR` of the contract's **buyer**                     | 403 (role, or the seller side)   |
| Acknowledge a revision     | An `OPERATOR` of the contract's **seller**                    | 403 (role, or the buyer side)    |
| Anyone else                | Other participants, service providers, outsiders              | 404, as for missing instructions |

The visibility rule is ADR 0011's, unchanged and not restated: the module resolves contracts only
through the voyages module's `CounterpartyContracts`, which requires the organization to be the
seller or buyer **and** to participate in the voyage now. The role and the side are checked in
the command service, in that order, after request validation.

### Concurrency: two numbers, one conditional statement per write

- **The revision number and the aggregate version are separate.** The revision number counts
  content (1, 2, 3); the version counts every change to the aggregate, revisions **and**
  acknowledgements, so it advances on every successful write. The current revision number never
  exceeds the version (CHECK).
- **HTTP conditional requests** (RFC 9110). The version's entity tag is the strong tag `"<n>"`,
  returned as `ETag` on reads and writes and in the body as `version` (so list items carry it
  too). A write must say what it is based on:
  - `PUT .../contracts/{contractId}/documentary-instructions` with `If-None-Match: *` creates the
    first revision (201, `Location`), with `If-Match: "<n>"` writes the next one (200).
  - `POST .../revisions/{n}/acknowledgement` requires `If-Match: "<n>"`.
  - **No precondition: 428 Precondition Required.** `If-Match: *` is refused the same way: it
    would make the write unconditional. **A stale or non-matching tag: 412 Precondition
    Failed**, and nothing is written. Weak tags (`W/"3"`) never match, as RFC 9110 requires
    for `If-Match`. A malformed header, or both headers at once, is a 400.
  - An acknowledgement of a superseded revision with a current tag is a 409, as is a second
    acknowledgement of the same revision; a revision that does not exist yet is a 404.
- **Checked by the database write, not by reading first.** Each command is one interactive
  transaction whose deciding statement is a single conditional SQL statement:
  - create: `INSERT ... ON CONFLICT (trade_contract_id) DO NOTHING RETURNING ...`: a concurrent
    creation waits on the unique index and then inserts nothing;
  - revise: `UPDATE ... SET version = version + 1, current_revision_number = current_revision_number + 1
WHERE trade_contract_id = $1 AND version = ANY($2) RETURNING ...`;
  - acknowledge: `UPDATE ... SET version = version + 1 WHERE trade_contract_id = $1 AND
version = ANY($2) AND current_revision_number = $3 AND NOT EXISTS (acknowledgement) RETURNING ...`.

  Under `READ COMMITTED`, an `UPDATE` that waited for a competitor's row lock re-evaluates its
  `WHERE` against the committed row, so the loser changes nothing and gets 412. The version
  predicate is deliberately on the updated table itself: PostgreSQL re-checks only the target
  row's own conditions after such a wait, not a subquery's, so `updateMany` with relation
  filters (which may become `WHERE id IN (subquery)`) is not used for these statements. Only
  after a statement changed nothing does the service read the row, to say **why** (412, 409 or
  404); that read never decides whether anything is written.

- **Each write and its audit event commit together** ([ADR 0009](0009-transactional-audit-events.md)).
  `DOCUMENTARY_INSTRUCTION_REVISED` records the revision as written and the new version;
  `DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED` the revision and the new version. Partial unique
  indexes allow one event per instruction version, one `REVISED` per revision and one
  `ACKNOWLEDGED` per revision, as a last line of defence.
- **The response is read inside the transaction**, so its body and `ETag` are exactly the
  version that write produced.

### Invariants the database holds for every writer

- One instruction per contract (unique), inside its contract's voyage (composite foreign key);
  a contract with instructions cannot be deleted.
- The aggregate starts at version 1 with revision 1; every update advances the version by exactly
  one and the revision number by at most one, and cannot move it to another contract (trigger).
- The current revision exists at commit (deferred constraint trigger).
- Revisions and acknowledgements are inserted only for the instruction's current revision
  (trigger, which also share-locks the aggregate row), and are never updated (triggers).
- Content: consignee and notify party at most 500 characters and not blank; requirements a JSON
  array of one to eight `{ document, originals, copies }` objects with exactly those keys, known
  document types, each once, integer counts 0..10, not both zero (CHECK through an immutable
  function).

### MVP business rules (project-specific)

These are this project's starting rules, not settled trade practice:

1. **Content:** a consignee (free text: name and address lines), an optional notify party, and
   one to eight document requirements, one per document type, each asking for 0..10 originals
   and 0..10 copies, at least one in total. The eight types are bill of lading, commercial
   invoice, certificate of origin, phytosanitary, weight, quality, fumigation and insurance
   certificates. No free-text clauses, no attachments, no presentation deadlines yet.
2. **One instruction per contract**, given by the buyer; the seller cannot propose changes
   through the system.
3. **A revision must change something.** Sending the current content again is a 400: it would
   only reset the seller's acknowledgement.
4. **No withdrawal or deletion.** Instructions are corrected by revising them.

## Alternatives considered

- **One mutable row, overwritten on edit, with history only in audit events.** Simpler reads, but
  the evidence would live in a log that the product does not read, and an acknowledgement could
  silently come to refer to content written after it.
- **Version number only (no separate revision number).** Acknowledgements also change the
  aggregate; tying the content number to the version would make revision numbers jump and mean
  nothing to users. Using the revision number as the concurrency token would let a revision
  overwrite an acknowledgement the buyer has not seen.
- **Acknowledgement columns on the revision row**, set by a guarded update as for notices. It
  makes revision rows mutable. A separate insert-only table keeps "a revision never changes" true
  without exceptions.
- **`SELECT ... FOR UPDATE`, compare in application code, then save.** Correct if every writer
  remembers to lock; the conditional statement is correct by itself, holds the lock for less
  time, and is what the requirement asks for.
- **`SERIALIZABLE` transactions with retries.** Would also prevent lost updates, but turns
  conflicts into serialization failures that must be retried, and retrying a user's write
  automatically is what this design forbids: the user must see the newer version first.
- **Version in the request body instead of `If-Match`.** Works, but invents a convention where
  HTTP has one, and cannot express "create only if absent" as cleanly as `If-None-Match: *`.
- **`POST` to create, `PATCH` to revise.** A revision is a full replacement of the content, which
  is what `PUT` means, and one URL per contract makes "one instruction per contract" visible in
  the API.
- **A `documentary_requirements` child table instead of JSON.** More relational, but rows could
  then be added to an old revision after the fact; immutability would need triggers on a second
  table. The requirements are a small value object written once with their revision; a CHECK
  validates their shape.
- **Express's automatic `ETag` (a body hash) left on.** It put a weak tag on every response,
  404s included, that looks usable in `If-Match` and never matches. It is switched off for the
  whole API: entity tags are set explicitly where writes are conditional, and responses are
  `no-store` anyway.

## Consequences

- Clients must read before writing and send the tag they read. The web client keeps the version
  its draft started from, not the latest cached one: a background refresh must never turn a
  stale draft into a valid write. On 412 it keeps the draft, shows the newer version, and sends
  again only after the user explicitly bases the draft on it. Nothing is retried automatically.
- The version advances on acknowledgements, so a buyer who opened the form before the seller
  acknowledged gets a 412 and sees the acknowledgement before revising. That is intended: the
  new revision will reset what the seller confirmed.
- Every response is `no-store`, so entity tags are used only for concurrency, never for caching.
  The tag identifies the aggregate version; the representation also depends on the reader's
  side of the contract.
- Revision history grows without bound per contract; the read returns all of it. Fine for an
  MVP (a handful of revisions); pagination or a summary view comes when it is not.
- The demo seed creates no instructions, and removes those given through the API on its own
  voyages when it re-seeds (their revisions and acknowledgements go with them; audit events
  stay). `DELETE` on revisions and acknowledgements is therefore not blocked by a trigger, as for
  notices; no endpoint deletes them.
- The same conditional-write pattern (version column, `If-Match`, one conditional statement,
  412/428) is the template for the next editable aggregates, such as recording the trade string.
