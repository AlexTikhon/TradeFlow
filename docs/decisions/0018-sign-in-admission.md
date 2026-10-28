# 0018. Sign-in admission: a per-address attempt budget and a concurrency cap, in process

- **Status:** Accepted. Implemented in `apps/api/src/modules/auth/` (`sign-in-admission.ts`,
  `sign-in-admission.guard.ts`, `AuthService.signIn`); unit-tested on a hand-moved clock
  (`sign-in-admission.spec.ts`, `auth.service.spec.ts`) and tested over HTTP against PostgreSQL
  (`apps/api/test/sign-in-admission.int-spec.ts`). The sign-in page's handling of a 429 is
  tested in `apps/web/src/features/auth/auth-flow.test.tsx`.
- **Date:** 2026-10-28

## Context

`POST /api/auth/sign-in` looks a user up and runs an argon2id verification (19 MiB, 2 passes,
[ADR 0007](0007-cookie-sessions.md)); for an unknown email it verifies against a dummy hash, so
timing does not reveal which emails exist. Until now nothing limited how often a client could
do that, or how many verifications could run at once. Two problems follow:

- **Online guessing.** A client can try passwords as fast as the server answers.
- **Work amplification.** Every attempt costs memory and CPU whether or not the email exists.
  Many concurrent attempts can exhaust memory and starve every other request in the one Node
  process.

ADR 0007 listed rate limiting as a known gap, waiting for a shared store. This phase runs one API
process and adds no infrastructure, so the protection has to work in process, with its limits
stated.

## Decision

Two admission checks, both in the `auth` module, both refusing with the same 429 shape:

| Check            | Rule                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Attempt budget   | 20 attempts per client address per 60-second window. A window starts at an address's first attempt after its previous window ended. Every attempt counts, whatever the email, the outcome, or whether the body is valid. Refused attempts do not count.                                                                                                                                                                                                           |
| Client address   | `request.ip`, which Express derives from the socket because `trust proxy` stays off. `X-Forwarded-For`, `Forwarded`, `X-Real-IP` and similar headers are ignored: any client can write them.                                                                                                                                                                                                                                                                      |
| Storage bound    | At most 10,000 tracked addresses. Expired windows are reclaimed on every attempt (they sit at the front of an insertion-ordered map, so this is cheap). When every tracked window is still running, attempts from new addresses are refused until the oldest ends; no running budget is evicted to make room.                                                                                                                                                     |
| Concurrency cap  | At most 4 `AuthService.signIn` executions at once. A slot is taken before the credential lookup and given back in `finally`, on success and on every failure. With every slot taken, the request is refused at once, never queued. The dummy hash is computed lazily inside a slot, so its cold-start cost is within the cap.                                                                                                                                     |
| Refusal          | `429 Too Many Requests` as RFC 9457 Problem Details, with `Retry-After` in whole seconds (at least 1): the time left in the window, or 1 when the cap is reached. No cookie is set or cleared, no session is revoked or created, and the body is the same whether or not the email exists.                                                                                                                                                                        |
| Clock and limits | `SIGN_IN_ADMISSION_OPTIONS` (attempts, window, storage bound, cap, clock). Production uses the defaults above and a monotonic clock (`performance.now()`), so a wall-clock correction neither ends nor extends a window. Only the attempt budget is configurable, by `SIGN_IN_ATTEMPTS_PER_MINUTE` (default 20, at least 1). Tests inject a hand-moved clock and, where every request shares one loopback address, a larger budget; there is no test-mode bypass. |

**Placement.** The budget is a route guard on sign-in only (`SignInAdmissionGuard`). Nest runs
global guards first, so a cross-site sign-in is still refused by `SameOriginGuard` with 403 and
spends nothing; the budget is spent before the body is validated and before `AuthService` is
called. The concurrency cap is inside `AuthService.signIn`, so it bounds every caller of the
service, not only the route. Sign-out, `GET /api/auth/me`, health and every business endpoint
are outside both checks.

**In the browser.** The sign-in page shows "Too many sign-in attempts. Wait a minute, then try
again." for a 429, keeps the email and password the user typed, and never re-sends on its own;
the user sends again when they choose. There is no countdown.

## Alternatives considered

- **`@nestjs/throttler`.** A general rate limiter, but it is a new dependency for one route, has
  no concurrency cap, and its default key and storage policies would need the same overrides
  written here. Worth revisiting if more routes need limits.
- **Per-account lockout or per-email budgets.** Stops guessing at one account from many
  addresses, but lets anyone lock a known user out, and a per-email counter keyed by unknown
  emails would reveal which emails exist through its behaviour. Not done; see consequences.
- **Sliding window or token bucket.** Smoother, so no burst at a window boundary, but more
  state per address and harder to state exactly. The fixed window is simple to test to the
  millisecond, and the boundary burst is bounded (below).
- **Queueing over-cap sign-ins.** Fairer to a legitimate burst, but a queue is unbounded memory
  and latency unless it is bounded too, and then it refuses anyway. Refusing at once is simpler
  and keeps the Node process responsive.
- **Trusting `X-Forwarded-For`.** Needed behind a reverse proxy, but only with the proxy's own
  address configured as trusted (`trust proxy` with a specific hop or subnet). Enabling it
  blanket would let every client choose its own budget. Left off until a deployment defines
  its proxies.
- **Redis or the database as a shared counter.** Coordinates instances and survives restarts,
  but this phase has one process and no Redis. A database counter would add a write to every
  attempt, including refused ones, on the path we are protecting.

## Consequences

- An address can make at most 20 password verifications a minute, and the process at most 4 at
  a time, so neither guessing nor hashing load is unbounded any more.
- **Shared addresses share a budget.** Users behind one NAT, office gateway or VPN exit share 20
  attempts a minute. Behind a reverse proxy without a trusted-proxy policy, every client
  connects from the proxy's address, so the budget becomes one for everyone: a deployment
  behind a proxy must configure which proxy hops to trust before going live.
- **Process-local.** Budgets reset when the process restarts, and several API instances would
  each grant a full budget per address. Coordinating them needs a shared store, as for event
  streams ([ADR 0015](0015-voyage-event-streams.md)).
- **No account lockout.** Guessing at one account from many addresses is limited only by each
  address's budget. IPv6 clients usually hold many addresses (a /64 or more); each counts
  separately, so the per-address budget is weaker against them.
- **Storage bound trade-off.** A client with more than 10,000 addresses can fill the table; new
  addresses are then refused for up to one window. That refuses some legitimate sign-ins rather
  than giving any address an unlimited budget or evicting a spent one.
- **Boundary burst.** Fixed windows allow up to 40 attempts within a short span across a
  window's end (20 at the end of one window, 20 at the start of the next).
- **Busy refusals.** In a burst of more than 4 simultaneous sign-ins, legitimate users can be
  told to wait a second. With argon2id at 19 MiB, the cap also bounds sign-in memory to about
  76 MiB.
- **Tests share an address too.** Integration suites that do not test admission, and the E2E
  run (whose browsers all reach the API through the one web-server proxy), raise only the attempt
  budget. The guard, window, storage bound and concurrency cap they run are the production ones.
- `Retry-After` is a hint for clients; the web app shows it as plain advice and does not act on
  it.
