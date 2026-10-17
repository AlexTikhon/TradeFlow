# 0015. Voyage event streams: SSE invalidation signals, in-process and best effort (MVP)

- **Status:** Accepted
- **Date:** 2026-10-17

## Context

Two counterparties work on the same notice from two browsers. Until now the buyer saw a new ETA
notice, and the seller saw its acknowledgement, only after reloading or after the 30 s
`staleTime` had passed _and_ something triggered a refetch (focus, navigation). Neither the
notices panel nor the timeline ([ADR 0009](0009-transactional-audit-events.md)) updated on its
own.

The forces:

- **Signals leak too.** A message saying only "something changed under contract 2" tells its
  receiver that the two counterparties of contract 2 are active. Notices, and their timeline
  events, are visible only to those two organizations ([ADR 0011](0011-counterparty-notices.md));
  so must be the signal that one changed.
- **Long-lived connections outlive their checks.** A request is authorized once, when it
  arrives. A stream stays open for hours, during which its session can expire or be revoked
  (sign-out elsewhere, [ADR 0007](0007-cookie-sessions.md)), its user can move organization, and
  its organization can leave the voyage.
- **Only committed changes are real.** A notice whose transaction rolled back, or the losing
  acknowledgement of a race (409), never happened and must not be announced.
- **The command has already succeeded.** Once a transaction committed, nothing about telling
  others may turn the response into an error: the client would retry a write that was made.
- **One API process, no broker** ([architecture](../architecture.md#system-context)). Adding Redis
  or a queue for one panel is not justified yet.
- **The client already has the truth source.** Every panel reads through REST with its own
  visibility rules, under identity-scoped query keys, with session epochs that tell a late answer
  from a current one ([ADR 0003](0003-frontend-server-state.md), [ADR 0007](0007-cookie-sessions.md)).

## Decision

**Server-sent events that carry invalidation signals only, published in-process after commit,
delivered best effort to the contract's current counterparties, and reconciled through REST.**

### The stream

`GET /api/voyages/{voyageId}/events`, `text/event-stream`, cookie-authenticated like every
route. A participant of the voyage may open it; anyone else gets the voyage's 404. Messages are
JSON `data` lines matching `VoyageStreamMessageSchema`:

- `{"type":"READY"}` first, written only once the connection is subscribed.
- `{"type":"NOTICE_ISSUED"}` or `{"type":"NOTICE_ACKNOWLEDGED"}` per change. No ids, no
  contents, no audit payload. The client reads the data again through the REST endpoints, which
  apply their own rules.

No `id:` field is sent, so browsers send no `Last-Event-ID`: there is nothing to resume from.

### Publishing

`NoticesService` calls `VoyageEventBus.publish({ type, voyageId, contractId })` **after**
`$transaction` resolved: rollbacks and the 409 of a lost race throw before it. Publishing is
synchronous and only schedules work; it is wrapped so that a failure is logged and the command
still answers 201/200. The bus is a `Map` of listeners per voyage in the API's memory, exported
by the voyages module (which owns contracts and participation, and so decides who is told).

### Delivery: who, and checked when

`VoyageEventStreams` keeps the open streams. Before writing anything to a stream it reads, now:

1. the stream's session (`SessionPrincipals.refresh`): expired, revoked, or the user now in
   another organization → the stream is closed;
2. the organization's contracts on the voyage (`CounterpartyContracts.listForVoyage`): no longer
   a participant → closed; not a counterparty of the change's contract → that signal is dropped.

Idle streams are re-checked the same way every **30 s**, and sent a heartbeat comment. That is
the **revocation window**: a stream whose session ends while no change is delivered stays open
for at most 30 s (plus the time to check the streams before it), carrying nothing but
heartbeats; no signal is ever written without a check that started after the change committed.
A signal whose check began just before a revocation committed can still be written; that is the
same race any request in flight has.

### Bounds

Signals waiting for a check are coalesced per contract and type, so one stream holds at most
`2 × contracts` of them; more than 32 contracts with pending signals closes the stream. A client
that stops reading (the socket buffer is full) is closed rather than buffered for. Closing is
always safe: the client reconnects and reads again. On shutdown every stream is ended, a stream
still being opened is answered 503 at once (its access check is not waited for), and none opens
afterwards.

### The client

`useVoyageLiveUpdates` on the voyage page:

- connects once the voyage has loaded, for that voyage, under the session epoch current then;
- on `READY` (every connection, so also after a reconnect) and on every change, invalidates
  exactly the current scope's notices and timeline queries, with at most one refresh running
  and one queued;
- closes the connection when a transition ends its epoch (`subscribeToSessionTransitions`) and
  ignores any callback after that, so signing out and back in as the same user, or session
  checks going to someone else and back, never act on an old stream; the page connects again
  for the new session;
- while not live (connecting, reconnecting, or no `EventSource`), polls both queries every 30 s
  with `refetchInterval`, which TanStack Query pauses while the tab is hidden; when the browser
  gives up on a stream, opens a new one after 5 s, 15 s, then every 60 s.

## Alternatives considered

- **WebSockets.** Bidirectional, but nothing flows from the client, and they need their own
  authentication handshake and proxy configuration. SSE is plain HTTP: the cookie, the guards,
  Problem Details on refusal and `no-store` all apply unchanged.
- **Sending the changed notice (or the audit event).** Saves a request, but every message would
  need its own allowlist, and the stream would become a second read path with its own visibility
  bugs. Signals keep one read path.
- **Authorizing once, at connect.** Cheaper, but a revoked session or a departed organization
  would keep learning about activity until it disconnects.
- **Publishing inside the transaction, or from a database trigger (`LISTEN/NOTIFY`).**
  `NOTIFY` is transactional and would reach every API instance, but it needs a dedicated
  connection outside the pool and still loses messages while nobody listens. Worth it with a
  second instance; not before.
- **A transactional outbox and a broker (Redis, BullMQ).** Durable and multi-instance, and the
  planned path ([architecture](../architecture.md#evolution)). Out of scope for a first slice
  whose clients already reconcile.
- **Polling only, or a lower `staleTime`.** `staleTime` alone never refetches anything; polling
  alone adds load and latency for every open page. Polling stays as the fallback.

## Consequences

- **Best effort, stated.** A change made through another API instance, or while a client was
  disconnected, is not delivered; nothing is replayed. Clients converge through `READY` and
  polling, never through the stream alone. Running more than one instance silently degrades
  live updates to those two mechanisms until a shared bus exists.
- Every delivery costs two queries per open stream of the voyage, and every 30 s every stream
  costs two more. Fine for the number of users of one voyage; a per-voyage cache of the check
  is the first optimization if needed.
- Only notices are wired. Instructions, documents and reviews announce nothing yet; adding one
  means a `VoyageChangeType`, a publish after its transaction, and the queries the client
  invalidates for it.
- The issuer's own browser receives the signal too and refreshes; harmless, and it keeps the
  issuer's timeline current, which the mutation hooks did not do.
- Tests: the API streams over real HTTP connections against PostgreSQL (who receives what,
  rollbacks, a race, a failing bus, revocation, expiry, organization and participation changes,
  disconnects, shutdown); the web tests drive a fake `EventSource`. No test opens a stream from a
  real browser, so the browser's own cookie handling and reconnection are not covered
  automatically.
