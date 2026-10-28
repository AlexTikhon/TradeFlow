import type { AddressInfo } from 'node:net';
import {
  CurrentUserSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
} from '@tradeflow/contracts';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { AuthService } from '../src/modules/auth/auth.service.js';
import {
  DEFAULT_SIGN_IN_ADMISSION_OPTIONS,
  SIGN_IN_ADMISSION_OPTIONS,
  SignInAdmission,
  type SignInAdmissionOptions,
} from '../src/modules/auth/sign-in-admission.js';
import { sessionCookie, sessionTokenFrom } from './support/auth.js';
import { failCommitsWriting, holdLock, waitForLockWaiters } from './support/concurrency.js';
import {
  createOrganization,
  createUser,
  resetDatabase,
  TEST_PASSWORD,
} from './support/database.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const EMAIL = 'ana@exporter.example';
const VALID = { email: EMAIL, password: TEST_PASSWORD };
const WINDOW_MS = DEFAULT_SIGN_IN_ADMISSION_OPTIONS.windowMs;

/**
 * Headers a client can write to claim another address. With `trust proxy` off, none may move
 * an attempt to another budget.
 */
const spoofedAddressHeaders = (n: number) => ({
  'X-Forwarded-For': `198.51.100.${n}, 203.0.113.${n}`,
  Forwarded: `for=192.0.2.${n}`,
  'X-Real-IP': `192.0.2.${n}`,
  'X-Client-IP': `192.0.2.${n}`,
  'CF-Connecting-IP': `192.0.2.${n}`,
  'True-Client-IP': `192.0.2.${n}`,
});

/** A refused sign-in: the 429 problem, `Retry-After`, and no cookie set or cleared. */
function expectRefused(
  response: request.Response,
  { detail, retryAfter }: { detail: string; retryAfter: string },
) {
  expect(response.status).toBe(429);
  expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  expect(response.headers['retry-after']).toBe(retryAfter);
  expect(response.headers['retry-after']).toMatch(/^[1-9]\d*$/);
  expect(response.headers['set-cookie']).toBeUndefined();
  expect(response.headers['cache-control']).toBe('no-store');
  expect(ProblemDetailsSchema.parse(response.body)).toEqual({
    type: 'about:blank',
    title: 'Too Many Requests',
    status: 429,
    detail,
    instance: '/api/auth/sign-in',
  });
}

const OVER_BUDGET = { detail: 'Too many sign-in attempts. Try again later.' };
const BUSY = {
  detail: 'Too many sign-ins are in progress. Try again shortly.',
  retryAfter: '1',
};

describe('Sign-in admission (ADR 0018)', () => {
  let ctx: TestApp;
  /** The admission clock, moved by hand: a window ends exactly when a test says. */
  const clock = { now: 0 };
  /** The API over IPv4 loopback, and over IPv6 loopback: two different client addresses. */
  let v4: string;
  let v6: string;

  const signInFrom = (base: string, body: object, headers: Record<string, string> = {}) =>
    request(base).post('/api/auth/sign-in').set(headers).send(body);
  const signIn = (body: object, headers: Record<string, string> = {}) =>
    signInFrom(v4, body, headers);

  /** Spends the rest of the IPv4 client's budget (out of `spent` already used). */
  async function exhaustBudget(spent = 0) {
    for (let n = spent; n < DEFAULT_SIGN_IN_ADMISSION_OPTIONS.attemptsPerWindow; n += 1) {
      await signIn({ email: EMAIL, password: 'wrong password' }).expect(401);
    }
  }

  beforeAll(async () => {
    ctx = await createTestApp({
      // The production policy; only its clock is the test's.
      signInAdmission: { ...DEFAULT_SIGN_IN_ADMISSION_OPTIONS, now: () => clock.now },
    });
    // Dual-stack, so IPv4 clients connect as ::ffff:127.0.0.1 and IPv6 ones as ::1.
    await ctx.app.listen(0, '::');
    const { port } = ctx.server.address() as AddressInfo;
    v4 = `http://127.0.0.1:${port}`;
    v6 = `http://[::1]:${port}`;
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    const organization = await createOrganization(ctx.prisma, 'Exporter Co', 'BR');
    await createUser(ctx.prisma, organization.id, { email: EMAIL, role: 'OPERATOR' });
    // Every earlier window has ended.
    clock.now += WINDOW_MS;
  });

  afterEach(() => {
    vi.restoreAllMocks();
    expect(ctx.app.get(SignInAdmission).runningSignIns).toBe(0);
  });

  it("is the production policy in the application's own module", async () => {
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    try {
      const { now, ...limits } = moduleRef.get<SignInAdmissionOptions>(SIGN_IN_ADMISSION_OPTIONS);
      expect(limits).toEqual({
        attemptsPerWindow: 20,
        windowMs: 60_000,
        maxTrackedClients: 10_000,
        maxConcurrent: 4,
      });
      expect(now).toBe(DEFAULT_SIGN_IN_ADMISSION_OPTIONS.now);
    } finally {
      await moduleRef.close();
    }
  });

  describe('attempt budget per client address', () => {
    it('counts 20 attempts whatever the email, outcome or forwarding headers, then refuses', async () => {
      const kinds = [
        { body: VALID, status: 200 },
        { body: { email: EMAIL, password: 'wrong password' }, status: 401 },
        { body: { email: 'nobody@exporter.example', password: TEST_PASSWORD }, status: 401 },
        { body: { email: 'not-an-email' }, status: 400 },
      ];
      const attempts = [...kinds, ...kinds, ...kinds, ...kinds, ...kinds];
      expect(attempts).toHaveLength(20);
      for (const [n, { body, status }] of attempts.entries()) {
        await signIn(body, spoofedAddressHeaders(n)).expect(status);
      }
      const signIns = vi.spyOn(ctx.app.get(AuthService), 'signIn');

      // A valid sign-in, a fresh email and fresh forwarding headers: all over budget.
      expectRefused(await signIn(VALID, spoofedAddressHeaders(99)), {
        ...OVER_BUDGET,
        retryAfter: '60',
      });
      expectRefused(await signIn({ email: 'someone-else@exporter.example', password: 'x' }), {
        ...OVER_BUDGET,
        retryAfter: '60',
      });
      // Refused before the service: no lookup, no hashing, no session work.
      expect(signIns).not.toHaveBeenCalled();
      expect(await ctx.prisma.session.count()).toBe(5);
    });

    it('refuses until the window ends to the millisecond, then opens a new one', async () => {
      const start = clock.now;
      await exhaustBudget();

      clock.now = start + 30_000;
      expectRefused(await signIn(VALID), { ...OVER_BUDGET, retryAfter: '30' });
      clock.now = start + WINDOW_MS - 1;
      expectRefused(await signIn(VALID), { ...OVER_BUDGET, retryAfter: '1' });

      clock.now = start + WINDOW_MS;
      await signIn(VALID).expect(200);
      await exhaustBudget(1);
      expectRefused(await signIn(VALID), { ...OVER_BUDGET, retryAfter: '60' });
    });

    it('keeps a separate budget for each connecting address', async () => {
      await exhaustBudget();
      expectRefused(await signIn(VALID), { ...OVER_BUDGET, retryAfter: '60' });

      const fromV6 = await signInFrom(v6, VALID).expect(200);
      expect(CurrentUserSchema.parse(fromV6.body).user.email).toBe(EMAIL);
      expectRefused(await signIn(VALID), { ...OVER_BUDGET, retryAfter: '60' });
    });

    it('leaves the session the browser has valid, and every other endpoint open', async () => {
      const first = await signIn(VALID).expect(200);
      const cookie = sessionCookie(sessionTokenFrom(first.headers['set-cookie']) ?? '');
      await exhaustBudget(1);

      // Signing in again with that session's cookie is refused without replacing it.
      expectRefused(await signIn(VALID, { Cookie: cookie }), {
        ...OVER_BUDGET,
        retryAfter: '60',
      });
      const [session] = await ctx.prisma.session.findMany();
      expect(session?.revokedAt).toBeNull();
      await request(v4).get('/api/auth/me').set('Cookie', cookie).expect(200);

      await request(v4).get('/api/health').expect(200);
      await request(v4).get('/api/voyages').set('Cookie', cookie).expect(200);
      await request(v4).get('/api/action-items').set('Cookie', cookie).expect(200);
      await request(v4).post('/api/auth/sign-out').set('Cookie', cookie).expect(204);
      await request(v4).get('/api/auth/me').set('Cookie', cookie).expect(401);
    });

    it('refuses a cross-site sign-in as before, without spending the budget', async () => {
      for (let n = 0; n < 25; n += 1) {
        const response = await signIn(VALID, { 'Sec-Fetch-Site': 'cross-site' }).expect(403);
        expect(response.headers['set-cookie']).toBeUndefined();
      }
      await signIn(VALID, { 'Sec-Fetch-Site': 'same-origin' }).expect(200);

      await exhaustBudget(1);
      await signIn(VALID, { 'Sec-Fetch-Site': 'cross-site' }).expect(403);
    });
  });

  describe('sign-ins in progress', () => {
    /**
     * Starts `count` valid sign-ins and waits until each is blocked on a lock held on `users`:
     * each holds a slot, inside its credential lookup.
     */
    async function holdSignIns(count: number) {
      const lock = await holdLock(ctx.prisma, (tx) =>
        tx.$executeRawUnsafe('LOCK TABLE users IN ACCESS EXCLUSIVE MODE'),
      );
      // `then` sends each request now rather than when it is awaited.
      const responses = Array.from({ length: count }, () =>
        signIn(VALID).then((response) => response),
      );
      await waitForLockWaiters(ctx.prisma, count);
      return { lock, responses };
    }

    const lockWaiters = async () => {
      const [row] = await ctx.prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      return row?.waiting;
    };

    it('refuses a fifth at once with 429, before it reaches the database', async () => {
      const { lock, responses } = await holdSignIns(4);
      expect(ctx.app.get(SignInAdmission).runningSignIns).toBe(4);

      // Were it looking anyone up, it would wait on the lock like the others.
      expectRefused(await signIn(VALID), BUSY);
      expectRefused(await signInFrom(v6, VALID), BUSY);
      expect(await lockWaiters()).toBe(4);

      await lock.release();
      for (const response of await Promise.all(responses)) {
        expect(response.status).toBe(200);
      }
      expect(ctx.app.get(SignInAdmission).runningSignIns).toBe(0);
      await signIn(VALID).expect(200);
    });

    it('gives the slots back when the held sign-ins fail', async () => {
      await failCommitsWriting(ctx.prisma, 'sessions', async () => {
        const { lock, responses } = await holdSignIns(4);
        expectRefused(await signIn(VALID), BUSY);

        await lock.release();
        for (const response of await Promise.all(responses)) {
          expect(response.status).toBe(500);
          expect(response.headers['set-cookie']).toBeUndefined();
        }
      });
      expect(ctx.app.get(SignInAdmission).runningSignIns).toBe(0);

      // All four slots are free again.
      const { lock, responses } = await holdSignIns(4);
      await lock.release();
      for (const response of await Promise.all(responses)) {
        expect(response.status).toBe(200);
      }
    });
  });
});
