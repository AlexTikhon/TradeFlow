# 0007. Server-side sessions in an HttpOnly cookie

- **Status:** Accepted
- **Date:** 2026-10-15

## Context

Milestone 2 adds sign-in, so that voyage access can be scoped to the user's organization
([ADR 0006](0006-participation-based-access.md)). The forces:

- **One client today, same origin.** The only client is our SPA, served from the same origin as
  the API (Vite proxies `/api` in development). There are no third-party API consumers yet.
- **Access changes must apply immediately.** Signing out must end a session at once. When an
  organization is removed from a voyage, its users must lose access on their next request, not
  when some token expires.
- **Identity must be derived, never asserted.** The acting organization must come from verified
  server-side state. A client-supplied organization id or header must not be able to choose it.
- **No identity provider yet.** Users are seeded with passwords. Enterprise SSO (OIDC) is likely
  later, but there is no deployment to integrate with today.
- **Threats to design for:** token theft through XSS, cross-site request forgery, session
  fixation, account enumeration at sign-in, and a leaked database copy.

## Decision

**Opaque, server-side sessions carried in an HttpOnly cookie.**

| Concern       | Choice                                                                                                                                                                                                                    |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Passwords     | argon2id from `node:crypto` (no native add-on), at the OWASP minimum (19 MiB, 2 passes, 1 lane). Stored as PHC strings in `users.password_hash`. A CHECK constraint accepts only argon2id. `NULL` means "cannot sign in". |
| Session token | 256 random bits, base64url. Only its SHA-256 digest is stored (`sessions.token_hash`, unique).                                                                                                                            |
| Lifetime      | Absolute expiry, `SESSION_TTL_MINUTES` (default 8 hours), with no sliding renewal. `revoked_at` ends a session early.                                                                                                     |
| Validation    | One indexed lookup per request. Expiry and revocation are conditions of the query itself. The organization is read from the user row on every request; it is never stored in the session or taken from the client.        |
| Cookie        | `HttpOnly; SameSite=Strict; Path=/`, with `Expires` set to the session expiry. Over HTTPS (production) it is also `Secure` and named with the `__Host-` prefix.                                                           |
| CSRF          | `SameSite=Strict`, plus a guard that refuses unsafe methods whose `Sec-Fetch-Site` is not `same-origin`. No CORS is configured.                                                                                           |
| Default       | A global `AuthGuard` denies every route without a valid session. Routes opt out with `@Public()`: sign-in, sign-out and health. The guard runs before validation pipes.                                                   |
| Caching       | Every `/api` response carries `Cache-Control: no-store`.                                                                                                                                                                  |

Endpoints:

- `POST /api/auth/sign-in` verifies the credentials and returns `CurrentUser` with `Set-Cookie`.
  Every failure (unknown email, wrong password, user without a password) gets the same 401 body.
  A dummy argon2 verification equalises timing. Signing in always issues a new token and revokes
  any session the browser presented, which prevents session fixation.
- `GET /api/auth/me` returns the signed-in user and organization, or 401.
- `POST /api/auth/sign-out` revokes the session and clears the cookie (204). It is public and
  idempotent, so a client can always sign out, even with a dead session.

Until background jobs exist, a user's expired and revoked sessions are deleted at their next
sign-in.

## Alternatives considered

- **JWT bearer tokens in `localStorage`.** Stateless validation, but any XSS can read the token.
  Revocation needs a denylist or short lifetimes plus refresh tokens, which reintroduces server
  state. An organization claim baked into the token goes stale when membership changes. We would
  still query the database on every request to check participation, so statelessness buys
  nothing here.
- **JWT in an HttpOnly cookie.** Fixes XSS readability, but keeps the revocation and staleness
  problems, and adds signing-key management.
- **`express-session` and Passport.** Mature, but we need one local strategy and one table. The
  generic store abstraction and strategy plumbing would be more code to understand than the
  roughly 150 lines here. Passport (or `openid-client`) becomes worth it with OIDC.
- **An external identity provider (OIDC: Keycloak, Auth0, Entra ID).** The right answer for
  enterprise SSO, and the likely next step. It does not replace this decision: an OIDC callback
  would end by creating the same session row and cookie. Postponed until there is a deployment
  and an IdP to integrate with.
- **bcrypt or scrypt.** bcrypt truncates input at 72 bytes and needs a native module. scrypt is
  acceptable, but argon2id is OWASP's first recommendation and Node 24 ships it.
- **Sliding (idle) expiry.** Better UX for long working sessions, but it costs a write per
  request (or a throttled one). Deferred; the absolute lifetime is the security bound either way.

## Consequences

- Sign-out and revocation take effect on the next request. "Sign out everywhere" is one
  `UPDATE ... WHERE user_id = ?`, though no endpoint exposes it yet.
- A copy of the database yields neither usable session tokens (SHA-256 digests) nor cheaply
  crackable passwords (argon2id).
- Every authenticated request costs one unique-index lookup joined to `users`. A short-lived
  in-process cache could remove it, at the price of revocation latency; not worth it now.
- Cookie authentication suits browsers on our own site. Machine clients (integrations) will need
  their own credential type (API keys or OAuth client credentials) when they appear.
- The frontend never sees the token. It learns who is signed in from `GET /api/auth/me` and keys
  all protected cached data by that identity (see [architecture](../architecture.md#authentication-in-the-browser)).
- `crypto.argon2` is new in Node (24.7). The PHC format is library-independent, so moving to
  another argon2 implementation would not require rehashing.
- **Known gaps, deliberately out of scope for this milestone:** sign-in rate limiting and lockout
  (needs a shared store, which arrives with Redis), password reset and user administration, MFA,
  idle timeout, and an audit trail of sign-ins (arrives with the audit milestone).
