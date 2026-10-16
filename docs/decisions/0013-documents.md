# 0013. Documents: private PDF versions per instruction revision, received outside the transaction (MVP)

- **Status:** Accepted
- **Date:** 2026-10-16

## Context

Milestone 7 adds the first files. Under each sale contract the seller presents the documents that
the buyer's documentary instructions require ([ADR 0012](0012-documentary-instructions.md)): a
bill of lading, a phytosanitary certificate, and so on. The first slice stores a PDF per required
document, keeps every version, and lets both counterparties download them.

The forces:

- **Evidence.** When documents are disputed, both sides must be able to show exactly which bytes
  were presented, against which instructions, by whom and when. A replaced file must not destroy
  the one it replaced, and the bytes served later must be the bytes received.
- **Against exact instructions.** Instructions are revised. A document presented against revision
  1 answers revision 1; once revision 2 is given, revision 1 must not take new documents, even from
  an upload that started before the revision was given.
- **Confidential to the contract**, like notices and instructions
  ([ADR 0011](0011-counterparty-notices.md)).
- **Two stores that cannot commit together.** The bytes do not belong in PostgreSQL (see below),
  and a filesystem rename and a database commit cannot be made atomic. Something will be left
  over when a process dies between them; the design must say what, and how it is cleaned up.
- **Untrusted input, at size.** A client chooses the file name, the declared type, the size and
  when to stop sending. Ten megabytes take seconds to arrive, during which the session, the
  user's role or the instructions can change.
- **Two people can upload at once**, as two operators of the seller replacing the same document.
- **No new infrastructure yet.** One API process, one database; an object store comes later
  ([architecture](../architecture.md#evolution)).

## Decision

### The aggregate and its records

**One document per (contract, instruction revision, required document type), with immutable
versions.** Two tables, owned by a new `documents` module:

| Table               | Holds                                                                                                                                                  |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `documents`         | The aggregate: its contract, instruction, revision number and document type (unique together), and `current_version_number`, the concurrency token     |
| `document_versions` | One row per upload: number, storage key, file name (display only), media type, size, SHA-256, uploader (user and organization) and time. Never updated |

- **A version is a whole file**, numbered 1, 2, 3 per document without gaps. A replacement adds a
  version; earlier versions keep their bytes and every column. Nothing is deleted or withdrawn.
- **A document belongs to one exact revision.** A new revision of the instructions starts with no
  documents; those presented against earlier revisions stay readable, read-only.
- **A document type must be required by its revision.** The revision's requirements say which
  documents exist to be presented.

### Who may do what

| Action                         | Who                                                           | Refusal                        |
| ------------------------------ | ------------------------------------------------------------- | ------------------------------ |
| List, download (every version) | Any user, viewers included, of the contract's seller or buyer | 404, as for a missing document |
| Upload a version               | An `OPERATOR` of the contract's **seller**                    | 403 (role, or the buyer side)  |
| Anyone else                    | Other participants, service providers, outsiders              | 404, as for a missing contract |

The visibility rule is ADR 0011's: contracts are resolved only through `CounterpartyContracts`,
which requires the organization to be the seller or buyer **and** to participate in the voyage
now. Revisions are resolved only through the documentary-instructions module's
`InstructionRevisions`; the documents module reads neither module's tables.

### HTTP

- `GET /voyages/{voyageId}/documents`: the documents under the reader's contracts, with every
  version, read in one `REPEATABLE READ` snapshot as for instructions.
- `POST /voyages/{voyageId}/contracts/{contractId}/documentary-instructions/revisions/{n}/documents/{type}/versions`:
  `multipart/form-data` with exactly one part, the file, in the field `file`. Conditional, as in
  ADR 0012: `If-None-Match: *` for the first version, `If-Match: "<n>"` naming the current version
  for a replacement; neither is 428, a stale tag 412. `201` with the document, `ETag` (the new
  version) and `Location` (its content).
- `GET .../versions/{v}/content`: the bytes, `Content-Type: application/pdf`,
  `Content-Disposition: attachment` with the uploaded name (an ASCII fallback and the exact
  UTF-8 name, RFC 6266/8187), `X-Content-Type-Options: nosniff`, a sandboxing
  `Content-Security-Policy`, `Repr-Digest` (SHA-256, RFC 9530), and `no-store` like every
  response.

### What is accepted, checked by the server while it receives

- **PDF only, judged by the bytes**: the file must start with `%PDF-` and be declared
  `application/pdf`. A name or a declared type alone is not enough; a file that starts otherwise
  is a 415. (PDF readers tolerate junk before the header; these rules do not.)
- **1 byte to 10 MiB.** A body that declares more is refused before it is read (413, connection
  closed); a file that grows past 10 MiB is refused as soon as it does, while streaming.
- **Exactly one part**, the file: a second file, any other field, no file, or a malformed body is
  a 400.
- **A refusal reaches the client**: whenever an upload is answered before its body was read
  (by a guard, a check in step 1 below, or a failure part-way), the rest of the body is read and
  discarded first, up to 16 MiB. Node would otherwise reset the connection under a client still
  sending, which a browser reports as a network error instead of the 403, 409 or 412.
- **The file name is display text**: reduced to its last path segment, without control or
  invisible formatting characters (bidirectional overrides), at most 255 characters. It never
  names anything in storage.

### Storage

A small `DocumentStorage` interface (`stage`, `promote`, `discard`, `read`, `remove`), implemented
today on the local filesystem under one private directory (`DOCUMENT_STORAGE_DIR`, required in
production, never served by any web server):

- `staging/<uuid>.part`, created exclusively and owner-only, while an upload is received;
- `objects/<uuid>` once kept, moved there by a rename within the same filesystem, so a kept object
  is complete or absent. Bytes are flushed to disk before the rename.

Keys are UUIDs generated by the storage; a key or staging id of any other shape is refused before
the filesystem is touched, and a CHECK constraint holds the same format in the database.

### The upload, step by step

The bytes are received **outside** any database transaction: a transaction held open while a
client streams ten megabytes would hold its locks for as long as the client likes.

1. **Check before reading** (no bytes read yet): guards, path parameters, precondition headers
   (428/400), `multipart/form-data` and the declared length (415/413), the role (403), the contract
   (404), the seller side (403), the revision (404 if none, 409 if superseded), the document type
   (404 if the revision does not require it), and the precondition against the document as it is
   (412). A refused upload is refused before its bytes are stored.
2. **Receive** the one file part into staging, counting and hashing it as it passes; refuse it
   (and discard what was staged) if it is too large, not a PDF, or empty, or if the request turns
   out to have more parts or is malformed.
3. **Keep** the staged bytes under a new key (`promote`).
4. **Commit**, in one transaction: read the session again (401 if it ended meanwhile, 403 if the
   role was taken away, 404 if the user moved to another organization), resolve the contract
   again, **share-lock the instruction row** and check the revision again, then the conditional
   write, the version row and the `DOCUMENT_VERSION_UPLOADED` audit event, and read the response.
5. **Answer** `201`.

What happens when a step fails:

| Fails at                                           | Database               | Bytes                                                                                |
| -------------------------------------------------- | ---------------------- | ------------------------------------------------------------------------------------ |
| 1, check                                           | nothing                | nothing was read                                                                     |
| 2, receive (aborted, too large, not a PDF, disk)   | nothing                | the partial staged file is removed                                                   |
| 3, promote                                         | nothing                | the staged file is discarded                                                         |
| 4, inside the transaction (a check, a race, audit) | rolled back, certainly | the kept object is removed                                                           |
| 4, while committing (connection lost at `COMMIT`)  | unknown                | **kept**: removing it could leave a committed row without bytes; logged as an orphan |
| a compensating removal fails                       | rolled back            | **kept**; logged as an orphan                                                        |
| the process dies after 3 and before 4 commits      | nothing                | **kept**: an orphan                                                                  |
| the process dies during 2                          | nothing                | a leftover `.part` file in staging                                                   |

The order is chosen so that the only leftover is **bytes no row names**, never a row whose bytes
are missing: a reader can never be offered a version it cannot download. The filesystem and
PostgreSQL do not commit atomically, and this design does not pretend they do.

**Orphan recovery** (a procedure, not yet a job): an object under `objects/` whose key no
`document_versions.storage_key` names, and that is older than the longest possible upload (an
hour is ample: the server's request timeout is five minutes), is an orphan and can be deleted; any
file under `staging/` older than that is a leftover and can be deleted. Running it while uploads
are in flight is safe only with that age threshold, since a kept object becomes named only when
its transaction commits. The [architecture](../architecture.md#documents-files-outside-the-transaction)
gives the queries.

### Concurrency and superseded revisions

- **Lost updates** are prevented as in ADR 0012: the first version is `INSERT ... ON CONFLICT
DO NOTHING`, a replacement `UPDATE documents SET current_version_number = current_version_number + 1
WHERE ... AND current_version_number = ANY($expected)`. Two concurrent uploads of the same version
  end in one 201 and one 412, and the loser's kept bytes are removed.
- **A superseded revision is refused at commit**, not only before the bytes arrive. The commit
  share-locks the instruction row (through `InstructionRevisions.lock`) before it writes anything:
  a revision being given at that moment makes the upload wait, and under `READ COMMITTED` the
  lock then returns the new current revision, so the upload is refused with 409. A revision given
  while an upload commits waits for the upload instead, and supersedes it once it has committed.
- **The database holds the same rules for every writer**: triggers accept a document, and each
  new version, only for the instruction's current revision and a type that revision requires
  (share-locking the instruction too); a version only as its document's current version; a
  document changes only by advancing its version by one, and a deferred constraint trigger
  requires the current version to exist at commit. Versions are immutable. Composite foreign keys
  keep a document inside its contract's voyage, under its contract's instruction, on an existing
  revision; none cascades.

### Downloads

A version's bytes are read once and checked against the stored size and SHA-256 before they are
served: bytes that do not match (tampered, truncated, missing) are a logged data error and a
generic 500, never a download that looks complete. A failure after the first byte cuts the
connection rather than ending a short response normally.

## Alternatives considered

- **Bytes in PostgreSQL** (`bytea` or large objects). One transaction for everything, but the
  database, its backups and its replication grow with every scan, and the API buffers whole files
  through the driver. Object storage is where files are going anyway.
- **Stream the bytes inside the transaction.** Still not atomic with the filesystem, and it would
  hold a transaction (and the instruction's share lock) for as long as a slow or malicious client
  takes to send ten megabytes.
- **Row first (`PENDING`), bytes, then mark it complete.** Also two stores, plus a state every read
  must filter and a sweeper for rows stuck pending. Its leftover is a row without bytes, which
  readers would see; ours is bytes without a row, which nobody sees.
- **Multer / `FileInterceptor`.** Parses the whole body before the handler runs, so authorization
  would come after the bytes were received and stored; and its limits, abort handling and errors
  are its own. Busboy (which Multer wraps) is used directly instead, after the checks.
- **Pre-signed object-store URLs**, the browser uploading straight to storage. The right shape once
  there is an object store; it needs a completion step that does what step 4 does here.
- **Checking the type by extension or `Content-Type` only.** Both are the client's word.
- **One document per contract and type, across revisions.** Simpler, but it would no longer say
  which instructions a file answers, which is the point of presenting it.
- **Overwriting or deleting versions.** Destroys exactly the evidence the feature exists for.

## Consequences

- Orphaned bytes are possible after a crash or a failed compensation, and are removed only by the
  reconciliation procedure, run by hand. They are logged when the API knows it left one.
- The directory entry of a rename is not fsynced: after a power loss a just-kept object can vanish,
  and its row (committed after the rename) then names a missing object, which downloads report as
  a data error. Acceptable for local storage; an object store removes it.
- Local storage ties the API to one filesystem: one instance, or a shared volume. An object store
  implements the same interface (`stage` as an upload to a staging prefix, `promote` as a copy, or
  as recording the key) when it arrives.
- A new revision of the instructions asks for every document again, even one whose requirement did
  not change: presentation is against exact instructions. To revisit when presentation deadlines
  arrive.
- Downloads read each file twice (check, then serve), bounded by the 10 MiB limit.
- The web client downloads through `fetch` and a blob, so a 401 signs out like any other request;
  files are held in memory while they are saved, again bounded by the limit.
- No virus scanning, no approval or rejection by the buyer, no deletion: none is in this slice.
- The demo seed removes documents on its own voyages when it re-seeds, and their bytes after its
  transaction commits.
