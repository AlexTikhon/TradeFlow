# 0021. Portfolio-demo write budget: a durable allowance of business commands per dataset

- **Status:** Accepted. Implemented in `apps/api/src/modules/demo-write-budget/`
  (`DemoWriteBudget`), `apps/api/src/config/app-config.ts` and migration
  `20261125100000_demo_write_budget`; called from every business command's service. Tested
  against PostgreSQL in `apps/api/test/demo-write-budget.int-spec.ts`, in the OpenAPI suite
  (every changing operation is either covered or is sign-in/sign-out), in the web app's notice
  and upload tests, in Chromium by `pnpm demo:portfolio:verify`, and end to end with a reset by
  `pnpm demo:portfolio:rehearse-reset`.
- **Date:** 2026-11-25

## Context

The portfolio demo (`pnpm demo:portfolio`) invites visitors to sign in with published accounts
and change things: create voyages, give instructions, upload PDFs, decide on them. Each run
already owns a fresh PostgreSQL container and a temporary document directory, and discards both
on stop. Nothing, however, limits how much one run can grow while it is up: a visitor, or a
script using the published password, could create voyages or upload files until the container's
memory or the disk runs out, and every other visitor would see the result.

The limit must not change the product: ordinary development, tests, the plain demo and any
deployment must behave exactly as before unless the limit is asked for. It must survive an API
restart against the same database, hold under concurrent requests, and never leave a refused
command half done (a staged file, a row without its audit event). And it must not turn the demo
into something that looks like a hosted, self-healing service: restoring the showcase stays an
operator's act.

## Decision

| Aspect          | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Opt-in          | `PORTFOLIO_DEMO_WRITE_PROTECTION=enabled` turns it on; the default is `disabled`, and anything else is a startup error. `PORTFOLIO_DEMO_WRITE_ALLOWANCE` sets the allowance (a positive whole number, at most 1,000,000; default 200) and is refused unless protection is enabled, so no limit only looks configured. Disabled, the API never touches the counter.                                                                               |
| What counts     | Every business command, and nothing else: voyage creation, trade-string setup, issuing and acknowledging a notice, giving or revising and acknowledging documentary instructions, uploading a document version and reviewing one. Sign-in, sign-out, reads, downloads and event streams are never counted or refused. The OpenAPI suite fails if a changing operation appears that is neither one of these eight nor sign-in/sign-out.           |
| Where           | Once per command, in its service, after authentication, authorization and the checks that make it fail without writing (visibility, role, side, state, `If-Match`/`If-None-Match` judged on the entity as read, validation that needs the database), and before its first business write or, for an upload, before a byte is staged. The conditional writes that decide races are unchanged and still have the last word.                        |
| Counter         | One row in `demo_write_budget` (`CHECK (id = 1)`, `CHECK (admitted > 0)`), per database: a fresh dataset starts a fresh allowance, a restarted API does not. Admission is one statement: `INSERT … VALUES (1, 1) ON CONFLICT (id) DO UPDATE SET admitted = admitted + 1 WHERE admitted < $allowance RETURNING admitted`. PostgreSQL serializes competitors on the row and judges the condition on the latest count, so none is admitted past it. |
| Connection      | A small pool of its own (5 s connect and statement timeouts), never the command's transaction. Admission commits by itself, and a command holding a transaction never waits for a shared-pool connection its own transaction is keeping. No transaction is open while an upload is received: admission comes before receiving.                                                                                                                   |
| No refunds      | An admitted attempt stays counted whatever follows: a lost race (409/412 from the conditional write), an audit or storage failure, a rollback, a dropped connection.                                                                                                                                                                                                                                                                             |
| Exhausted       | `429` as Problem Details, type `/problems/demo-write-budget-exhausted`, title "Demo change limit reached", and a detail saying that browsing, downloads and signing in and out still work and that only an operator reset allows changes again. No `Retry-After`: waiting does not help, so no time is invented. Nothing is written, staged, promoted, audited or announced.                                                                     |
| Fails closed    | If the counter cannot be read and raised (database error, timeout), the command is refused with `503` before any write, and the cause is recorded on the request's HTTP lifecycle record. The client sees the generic 5xx body.                                                                                                                                                                                                                  |
| In the launcher | Only the portfolio profile passes `writeAllowance` (`e2e/demo/portfolio.ts`, 200), which starts the API with both variables set; the switch is explicit and independent of the web app's Vite mode. Both variables are among those the launcher removes from the caller's environment, so `pnpm demo` and `pnpm demo:verify` start with protection off whatever the shell holds.                                                                 |
| Reset           | Stop the run and start a new one (`pnpm demo:portfolio`): the run's own lifecycle removes the container (the counter with it), the documents and the servers, and the new run prepares the showcase again through the API. There is no reset, quota, fixture or administration endpoint.                                                                                                                                                         |

The showcase's preparation goes through the same API, so its 11 commands are admitted against
the allowance like any visitor's: a fresh portfolio run has 189 left.

## Alternatives considered

- **Rate limiting per address or per account.** Slows a flood down but bounds nothing: given
  time, the dataset still grows without limit. Shared demo accounts would also share a rate.
- **An in-process counter.** Simple, but an API restart would hand out a fresh allowance, and two
  instances would each grant one. PostgreSQL is already the run's store.
- **Counting inside the command's transaction.** Exact (only commands that commit count), but a
  rollback would refund the attempt: failing commands would cost nothing, and an upload, whose
  bytes are received outside any transaction, could not take part without holding a transaction
  open while it receives the file. Counting attempts on their own connection is conservative and
  simpler to reason about.
- **Refunding failed attempts.** Would need a second write after the outcome is known, which
  cannot be made reliable for an unknown commit outcome, and would reopen the race the single
  conditional statement closes.
- **Redis or a separate quota service.** Infrastructure the demo does not otherwise need.
- **A reset or quota endpoint.** Anyone who can reach the demo could call it. Recreating the
  run is already safe, owned and verified.
- **Scheduled hosted resets.** Out of scope while there is no hosted portfolio environment.

## Consequences

- One run's business data is bounded: at most 200 commands, each bounded by the existing limits
  (a 10 MiB PDF, a validated body), so at most about 2 GB of documents in the worst case and far
  less in practice.
- **Shared accounts, shared budget.** Every visitor of a run spends the same allowance. Once it
  is used up, nobody can change anything until the operator resets the run, and the reset
  discards every session, edit and uploaded file. One visitor can use it all up; this is a
  showcase's safety bound, not fairness between visitors.
- **Conservative counting.** Commands that are admitted and then fail (a lost race, an injected
  storage or audit failure) are not refunded, so a run may admit fewer than 200 successful
  changes. Commands refused before admission (401, 403, 404, 400 from validation, 409 or 412
  detected on the entity as read) cost nothing.
- **Fails closed.** A database problem that prevents counting refuses changes on a protected
  demo even if the business tables are writable.
- **Not a hosting control.** It does not limit sign-ins beyond ADR 0018, reads, streams or
  bandwidth, and it does not make the demo safe for unrestricted public hosting. A hosted
  showcase would also need a scheduled, verified reset and abuse controls at the edge.
- Every database, including development and test databases, gains the empty table through the
  migration; it stays empty wherever protection is off.
