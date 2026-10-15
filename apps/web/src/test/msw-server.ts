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

export interface FakeSession {
  /** Who the (simulated) session cookie belongs to; tests may change it to mimic another tab. */
  current: CurrentUser | null;
  signInRequests: number;
  signOutRequests: number;
}

/**
 * A stateful stand-in for the auth endpoints, behaving like the real API: sign-in with a known
 * email and TEST_PASSWORD establishes that identity, sign-out ends it, `me` reports it or 401s.
 */
export function serveSession(
  initial: CurrentUser | null,
  accounts: CurrentUser[] = initial ? [initial] : [],
): FakeSession {
  const session: FakeSession = { current: initial, signInRequests: 0, signOutRequests: 0 };
  server.use(
    http.get('*/api/auth/me', () =>
      session.current
        ? HttpResponse.json(session.current)
        : problemResponse(401, 'Authentication is required.'),
    ),
    http.post('*/api/auth/sign-in', async ({ request }) => {
      session.signInRequests += 1;
      const { email, password } = (await request.json()) as SignInRequest;
      const account = accounts.find((candidate) => candidate.user.email === email);
      if (!account || password !== TEST_PASSWORD) {
        return problemResponse(401, 'Email or password is incorrect.');
      }
      session.current = account;
      return HttpResponse.json(account);
    }),
    http.post('*/api/auth/sign-out', () => {
      session.signOutRequests += 1;
      session.current = null;
      return new HttpResponse(null, { status: 204 });
    }),
  );
  return session;
}
