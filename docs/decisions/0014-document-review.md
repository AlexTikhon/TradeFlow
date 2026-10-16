# 0014. Document review: one final decision per file version, a document version for every change (MVP)

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Milestone 8 lets the buyer answer what the seller presents ([ADR 0013](0013-documents.md)): under
each sale contract, operators of the buyer approve or reject each document the seller uploads.

The forces:

- **Evidence of exactly what was decided.** A decision is about specific bytes (one file
  version, with its checksum), presented against specific instructions (one revision), made by
  someone for an organization at a time, and, for a rejection, for a reason the seller can act on.
  It must stay attached to exactly that file when the seller uploads another.
- **Decisions are final in this slice.** Correcting a decision, reopening it or waiving a
  discrepancy are real practice, but each needs rules of its own. For now the only way forward
  after a rejection is a replacement, which is reviewed anew.
- **Three people can act on one document at once.** Two operators of the buyer can decide on the
  same file; the seller can replace the file while the buyer decides; the buyer can revise the
  instructions while deciding. Nobody may decide on a file that has been replaced, and the seller
  must not replace a file without having seen the decision on it.
- **The concurrency token of ADR 0013 is the file version number**, and a review adds no file. A
  token that does not move when a decision is recorded cannot stop a replacement that was chosen
  before the decision from passing over it.
- **Deployed databases already hold documents**, some with several versions. Migrations already
  applied are not edited.
- **Confidential to the contract**, like everything since [ADR 0011](0011-counterparty-notices.md).

## Decision

### The records

**One immutable review row per decided file version, and a document version that counts every
change.**

| Table / column                     | Holds                                                                                                                                                                                                                           |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `document_reviews` (new)           | One decision: the document and file version number (a foreign key to that exact `document_versions` row), `APPROVED` or `REJECTED`, the reason, the reviewer and organization, the time. Unique per file version. Never updated |
| `documents.version` (new column)   | Advances by exactly one on every change: each upload **and** each review. The entity tag (`ETag`, `If-Match`) of the document                                                                                                   |
| `documents.current_version_number` | Unchanged in meaning: the latest file version, advancing with uploads only. File versions are still numbered 1, 2, 3 without gaps                                                                                               |

At every commit, `version = current_version_number + (number of reviews)`. A file version
without a review is **pending** while it is the latest file of a document under the current
revision, and **not reviewed** otherwise (replaced first, or its revision superseded).

### MVP business rules (project-specific)

These are this project's starting rules, not settled trade practice:

1. **The buyer decides**: an `OPERATOR` of the contract's buyer approves or rejects.
2. **Only the latest file version, under the current revision of the instructions**, can be
   decided on.
3. **One decision per file version, and it is final**: never edited, withdrawn, reopened or
   replaced by another decision on the same file.
4. **A rejection says why**: 1 to 1000 characters, not blank, trimmed. An approval carries no
   reason.
5. **A replacement starts pending.** Decisions on earlier versions stay with those versions. The
   seller may replace a file whatever its state, an approved one included; the new file then
   needs a decision of its own.
6. **A new revision of the instructions** asks for every document again (ADR 0013); decisions made
   under a superseded revision stay readable, and its pending files are never decided.

### Who may do what

| Action                              | Who                                                           | Refusal                        |
| ----------------------------------- | ------------------------------------------------------------- | ------------------------------ |
| Read decisions (with the documents) | Any user, viewers included, of the contract's seller or buyer | 404, as for a missing document |
| Approve or reject                   | An `OPERATOR` of the contract's **buyer**                     | 403 (role, or the seller side) |
| Anyone else                         | Other participants, service providers, outsiders              | 404, as for a missing contract |

Contracts are resolved through `CounterpartyContracts` and revisions through
`InstructionRevisions`, as for uploads. The reviewer, their organization and the time come from
the session and the server's clock; the request body cannot name them (it is a closed schema).

### HTTP

- `POST /voyages/{voyageId}/contracts/{contractId}/documentary-instructions/revisions/{n}/documents/{type}/versions/{v}/review`
  with `{ "decision": "APPROVED" }` or `{ "decision": "REJECTED", "reason": "..." }`.
  `If-Match: "<document version>"` is required: none, or `*`, is 428; a stale or weak tag is 412. `200` with the document and its new `ETag`. A version that is not the latest, or already
  decided, is 409, as is a superseded revision; a missing document, version or revision is 404.
- **Uploads are now conditional on the document version** too: `If-Match` names the document's
  version, not the file number, and an upload answers the new document version as `ETag`.
  Until a document's first review the two numbers are equal (the migration sets them so), so a
  tag a client already holds stays valid; after a review, an upload based on the file number
  alone is stale (412), which is exactly the point.
- `GET .../documents` returns each document's `version` and each file version's `review` (null
  while pending or never decided), read with the contracts in one `REPEATABLE READ` snapshot.

### Concurrency: one conditional statement per decision

A review is one interactive transaction: resolve the contract (404), require the buyer side
(403), **share-lock the instruction row** through `InstructionRevisions.lock` and check the
revision (404, 409), then decide with one statement:

```sql
UPDATE documents SET version = version + 1
WHERE <the document> AND version = ANY($expected)
  AND current_version_number = $fileVersion
  AND NOT EXISTS (SELECT 1 FROM document_reviews WHERE <the document and file version>)
RETURNING ...
```

then insert the review, record `DOCUMENT_VERSION_REVIEWED`, and read the response, all before
commit. Only when the statement changed nothing is the document read, to say why (404, 412,
409); that read decides nothing. Any upload or review advances the version, so under
`READ COMMITTED` a statement that waited for a competitor's row lock re-checks the version and
changes nothing (ADR 0012 explains why the predicate must be on the updated row itself).

| Race                                              | Outcome                                                                                                     |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Two reviews of the same version                   | One 200, one 412                                                                                            |
| A review and a replacement, both from version _n_ | Whichever takes the row first wins; the other gets 412. A losing upload's kept bytes are removed (ADR 0013) |
| A revision of the instructions, then a review     | The review's share lock waits, then sees the new revision: 409                                              |
| A review, then a revision of the instructions     | The revision waits for the review to commit, then supersedes it; the decision stays on revision _n_         |

### Invariants the database holds for every writer

- `documents_guard` is replaced: a document starts at version 1 with file version 1; every change
  advances `version` by exactly one, and `current_version_number` by zero or one.
- A deferred constraint trigger, on `documents` and on `document_reviews`, requires
  `version = current_version_number + reviews` at commit: no version without the file or the
  decision it stands for, no decision without its version.
- A review is inserted only for the document's current file version, while its revision is the
  instruction's current one (a trigger share-locks the document, then the instruction, in the
  order uploads lock them); at most one per file version (unique); never updated (trigger); a
  CHECK pairs a rejection with a bounded, non-blank reason and an approval with none.
- `DOCUMENT_VERSION_REVIEWED` events name the document, the file version and its SHA-256, the
  decision, the reason, the time and the document version (CHECK on the payload); partial unique
  indexes allow one review event per file version and one upload-or-review event per document
  version. Upload events now carry the document version as well (events recorded before this
  change lack it, and are not touched: the audit trail is append-only).
- Reviews cascade only from their file version, which cascades from its document: the demo seed
  removes documents wholesale. No endpoint deletes anything.

### Migrations

Two, because PostgreSQL does not let a transaction use an enum value it has just added
(`20261016140000_document_reviews`, then `20261016140100_document_review_audit_events`). Before
them every change to a document was an upload, so the backfill sets `version` to
`current_version_number`; the guard trigger (which refuses any update that adds no file) is
switched off for that one statement, and the deferred check that the current version exists is
made immediate so that no trigger event is left pending. An integration test applies every
earlier migration to a scratch database, writes documents with several versions as the API wrote
them, applies these two, checks the backfill and that nothing else changed, makes a review and
a replacement on the migrated rows, and compares the result with the Prisma schema.

## Alternatives considered

- **A status column on `document_versions`** (pending, approved, rejected). One table fewer, but
  versions would become mutable, and ADR 0013 makes "a version never changes" an invariant held by
  a trigger. An insert-only table, like instruction acknowledgements, keeps it without exceptions.
- **Keep the file version number as the only token**, and guard reviews by "no review yet". A
  review would not move the tag, so a seller who chose a file before the rejection could replace
  it without having seen the reason; the conflict the user most needs to hear about would pass
  silently.
- **A separate token per file version for reviews.** Two numbers for clients to carry, and still
  nothing that tells an upload about a decision. One document version covers both directions.
- **The review on the document row** (its current state). Loses which file a decision was about
  as soon as a replacement arrives.
- **Changeable or reopenable decisions.** Needed eventually (amendments, waivers), but each needs
  rules about what the seller saw and when; a later amendment can be a new row that refers to the
  one it amends, without editing it.
- **Refusing replacements of an approved file.** Simpler, but a seller who finds a mistake after
  approval would have no way to correct it in the system; the buyer decides again instead.
- **`SERIALIZABLE` transactions with retries**: as in ADR 0012, conflicts must reach the user, not
  be retried.
- **A plain `ADD COLUMN ... DEFAULT 1`** (what Prisma generates): wrong for every document with
  more than one version, whose tags clients may hold.

## Consequences

- Clients send the document version, not the file number. A tag held from before the first review
  stays valid until that review; the web client bases both uploads and decisions on the version
  and tells the user whether a 412 came from a new file or from a decision.
- A wrong decision cannot be corrected in the system; the seller can only upload a replacement
  for the buyer to decide on.
- An approved document can still be replaced; the replacement shows as pending.
- Files pending under a superseded revision stay "not reviewed" for good.
- Who may decide (the buyer's operators) is checked by the service, not the database, which does
  not know the principal, as for uploads.
- No notifications of new files or decisions, no review deadlines, no partial acceptance, no
  discrepancy codes or comment threads: none is in this slice.
