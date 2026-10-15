import type { CurrentUser, ProblemDetails, SignInRequest } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { TEST_PASSWORD } from './fixtures/auth';

/** Handlers are registered per test with `server.use(...)` so each test states its API. */
export const server = setupServer();

const TITLES: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  500: 'Internal Server Error',
};

export function problemResponse(status: number, detail: string) {
  const problem: ProblemDetails = {
    type: 'about:blank',
    title: TITLES[status] ?? 'Error',
    status,
    detail,
  };
  return HttpResponse.json(problem, {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

export type AuthEndpoint = 'me' | 'sign-in' | 'sign-out';

/** A response the test lets through explicitly, so interleavings are deterministic. */
export interface HeldResponse {
  /** Resolves once the request has reached the (fake) server. */
  received: Promise<void>;
  release(): void;
}

export interface FakeSession {
  /** Who the (simulated) session cookie belongs to; tests may change it to mimic another tab. */
  current: CurrentUser | null;
  meRequests: number;
  signInRequests: number;
  signOutRequests: number;
  /** What reached the server and what came back, in order, e.g. `sign-out answered`. */
  log: string[];
  /** Holds the next response from `endpoint` until `release()`. */
  holdNext(endpoint: AuthEndpoint): HeldResponse;
  /** Makes the next sign-out fail with a 500, leaving the session alive. */
  failNextSignOut(): void;
}

/**
 * A stateful stand-in for the auth endpoints, behaving like the real API: sign-in with a known
 * email and TEST_PASSWORD establishes that identity, sign-out ends it, `me` reports it or 401s.
 *
 * Timing follows a real browser: the server reads the cookie when a request arrives, and a
 * `Set-Cookie` takes effect when its response arrives. A held sign-out therefore revokes the
 * session at once but clears the cookie (whatever it holds by then) only when released.
 */
export function serveSession(
  initial: CurrentUser | null,
  accounts: CurrentUser[] = initial ? [initial] : [],
): FakeSession {
  const holds: Record<AuthEndpoint, (() => Promise<void>)[]> = {
    me: [],
    'sign-in': [],
    'sign-out': [],
  };
  let failSignOut = false;

  const session: FakeSession = {
    current: initial,
    meRequests: 0,
    signInRequests: 0,
    signOutRequests: 0,
    log: [],
    holdNext(endpoint) {
      let release: () => void = () => undefined;
      let arrived: () => void = () => undefined;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const received = new Promise<void>((resolve) => {
        arrived = resolve;
      });
      holds[endpoint].push(() => {
        arrived();
        return gate;
      });
      return { received, release };
    },
    failNextSignOut() {
      failSignOut = true;
    },
  };

  async function arrive(endpoint: AuthEndpoint) {
    session.log.push(`${endpoint} received`);
    await holds[endpoint].shift()?.();
  }

  server.use(
    http.get('*/api/auth/me', async () => {
      session.meRequests += 1;
      const identity = session.current;
      await arrive('me');
      session.log.push('me answered');
      return identity
        ? HttpResponse.json(identity)
        : problemResponse(401, 'Authentication is required.');
    }),
    http.post('*/api/auth/sign-in', async ({ request }) => {
      session.signInRequests += 1;
      const { email, password } = (await request.json()) as SignInRequest;
      await arrive('sign-in');
      session.log.push('sign-in answered');
      const account = accounts.find((candidate) => candidate.user.email === email);
      if (!account || password !== TEST_PASSWORD) {
        return problemResponse(401, 'Email or password is incorrect.');
      }
      session.current = account;
      return HttpResponse.json(account);
    }),
    http.post('*/api/auth/sign-out', async () => {
      session.signOutRequests += 1;
      const fails = failSignOut;
      failSignOut = false;
      if (!fails) session.current = null; // Revoked on arrival.
      await arrive('sign-out');
      session.log.push('sign-out answered');
      if (fails) {
        return problemResponse(500, 'Sign-out failed.');
      }
      session.current = null; // The cookie is cleared when the response arrives.
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return session;
}
