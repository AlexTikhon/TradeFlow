import { createHash } from 'node:crypto';
import {
  CurrentUserSchema,
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  ProblemDetailsSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SESSION_COOKIE, sessionCookie, sessionTokenFrom, signIn } from './support/auth.js';
import {
  createOrganization,
  createSession,
  createUser,
  resetDatabase,
  TEST_PASSWORD,
} from './support/database.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const HOUR = 60 * 60 * 1000;

/** Problem body without the per-request `instance`, for comparing two failures. */
const withoutInstance = ({ instance: _instance, ...problem }: ProblemDetails) => problem;

describe('Authentication API', () => {
  let ctx: TestApp;
  const http = () => request(ctx.server);

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  async function aUser(email = 'ana@exporter.example') {
    const organization = await createOrganization(ctx.prisma, 'Exporter Co', 'BR');
    const user = await createUser(ctx.prisma, organization.id, { email });
    return { organization, user };
  }

  describe('POST /api/auth/sign-in', () => {
    it('verifies credentials, opens a session and sets a hardened cookie', async () => {
      const { organization, user } = await aUser();
      const before = Date.now();

      const response = await http()
        .post('/api/auth/sign-in')
        .send({ email: 'ana@exporter.example', password: TEST_PASSWORD })
        .expect(200);

      expect(CurrentUserSchema.parse(response.body)).toEqual({
        user: { id: user.id, email: user.email, fullName: user.fullName },
        organization: { id: organization.id, name: 'Exporter Co', countryCode: 'BR' },
      });

      const setCookie = response.headers['set-cookie'] as unknown as string[];
      const cookie = setCookie.find((header) => header.startsWith(`${SESSION_COOKIE}=`)) ?? '';
      expect(cookie).toMatch(/; HttpOnly/);
      expect(cookie).toMatch(/; SameSite=Strict/);
      expect(cookie).toMatch(/; Path=\//);
      expect(cookie).toMatch(/; Expires=/);
      expect(cookie).not.toMatch(/; Domain=/);

      // Only a digest of the token is stored, and the session expires after the configured TTL.
      const token = sessionTokenFrom(setCookie) ?? '';
      const [session] = await ctx.prisma.session.findMany();
      expect(session?.userId).toBe(user.id);
      expect(Buffer.from(session?.tokenHash ?? []).toString('hex')).toBe(
        createHash('sha256').update(token).digest('hex'),
      );
      expect(session?.expiresAt.getTime()).toBeGreaterThanOrEqual(before + 8 * HOUR);
      expect(session?.expiresAt.getTime()).toBeLessThanOrEqual(Date.now() + 8 * HOUR);
    });

    it('matches the email case-insensitively', async () => {
      await aUser();
      await http()
        .post('/api/auth/sign-in')
        .send({ email: ' Ana@Exporter.EXAMPLE', password: TEST_PASSWORD })
        .expect(200);
    });

    it('gives the same 401 for a wrong password, an unknown email and a password-less user', async () => {
      const { organization } = await aUser();
      await createUser(ctx.prisma, organization.id, {
        email: 'invited@exporter.example',
        hasPassword: false,
      });

      const attempts = [
        { email: 'ana@exporter.example', password: 'wrong password' },
        { email: 'nobody@exporter.example', password: TEST_PASSWORD },
        { email: 'invited@exporter.example', password: TEST_PASSWORD },
      ];
      const problems = [];
      for (const credentials of attempts) {
        const response = await http().post('/api/auth/sign-in').send(credentials).expect(401);
        expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
        expect(response.headers['set-cookie']).toBeUndefined();
        problems.push(withoutInstance(ProblemDetailsSchema.parse(response.body)));
      }

      expect(problems[0]).toEqual({
        type: 'about:blank',
        title: 'Unauthorized',
        status: 401,
        detail: 'Email or password is incorrect.',
      });
      expect(problems[1]).toEqual(problems[0]);
      expect(problems[2]).toEqual(problems[0]);
      expect(await ctx.prisma.session.count()).toBe(0);
    });

    it('rejects a malformed body with a validation problem', async () => {
      const response = await http()
        .post('/api/auth/sign-in')
        .send({ email: 'not-an-email' })
        .expect(400);

      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.errors?.map((error) => error.path)).toEqual(['body.email', 'body.password']);
    });

    it('ends the session the browser already had (no session fixation)', async () => {
      await aUser();
      const first = await signIn(ctx.server, 'ana@exporter.example');

      const response = await http()
        .post('/api/auth/sign-in')
        .set('Cookie', first)
        .send({ email: 'ana@exporter.example', password: TEST_PASSWORD })
        .expect(200);
      const second = sessionCookie(sessionTokenFrom(response.headers['set-cookie']) ?? '');

      expect(second).not.toBe(first);
      await http().get('/api/auth/me').set('Cookie', first).expect(401);
      await http().get('/api/auth/me').set('Cookie', second).expect(200);
    });

    it('refuses a cross-site request even with valid credentials', async () => {
      await aUser();

      const response = await http()
        .post('/api/auth/sign-in')
        .set('Sec-Fetch-Site', 'cross-site')
        .send({ email: 'ana@exporter.example', password: TEST_PASSWORD })
        .expect(403);

      expect(ProblemDetailsSchema.parse(response.body).status).toBe(403);
      expect(response.headers['set-cookie']).toBeUndefined();

      await http()
        .post('/api/auth/sign-in')
        .set('Sec-Fetch-Site', 'same-origin')
        .send({ email: 'ana@exporter.example', password: TEST_PASSWORD })
        .expect(200);
    });
  });

  describe('GET /api/auth/me', () => {
    it('returns the signed-in user and is never cacheable', async () => {
      const { user } = await aUser();
      const cookie = await signIn(ctx.server, user.email);

      const response = await http().get('/api/auth/me').set('Cookie', cookie).expect(200);

      expect(CurrentUserSchema.parse(response.body).user.id).toBe(user.id);
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it.each([
      ['no cookie', undefined],
      ['a malformed token', sessionCookie('not-a-token')],
      ['an unknown token', sessionCookie('A'.repeat(43))],
    ])('answers 401 problem details for %s', async (_label, cookie) => {
      const call = http().get('/api/auth/me');
      const response = await (cookie ? call.set('Cookie', cookie) : call).expect(401);

      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(ProblemDetailsSchema.parse(response.body)).toMatchObject({
        status: 401,
        title: 'Unauthorized',
        instance: '/api/auth/me',
      });
    });

    it('rejects an expired session', async () => {
      const { user } = await aUser();
      const token = await createSession(ctx.prisma, user.id, {
        createdAt: new Date(Date.now() - 9 * HOUR),
        expiresAt: new Date(Date.now() - HOUR),
      });

      await http().get('/api/auth/me').set('Cookie', sessionCookie(token)).expect(401);
    });

    it('rejects a revoked session', async () => {
      const { user } = await aUser();
      const cookie = await signIn(ctx.server, user.email);
      await ctx.prisma.session.updateMany({ data: { revokedAt: new Date() } });

      await http().get('/api/auth/me').set('Cookie', cookie).expect(401);
    });

    it('derives the organization from the user record on every request', async () => {
      const { user } = await aUser();
      const cookie = await signIn(ctx.server, user.email);
      const trader = await createOrganization(ctx.prisma, 'Trader AG', 'CH');

      await ctx.prisma.user.update({ where: { id: user.id }, data: { organizationId: trader.id } });

      const response = await http().get('/api/auth/me').set('Cookie', cookie).expect(200);
      expect(CurrentUserSchema.parse(response.body).organization.id).toBe(trader.id);
    });
  });

  describe('POST /api/auth/sign-out', () => {
    it('revokes the session server-side and clears the cookie', async () => {
      const { user } = await aUser();
      const cookie = await signIn(ctx.server, user.email);

      const response = await http().post('/api/auth/sign-out').set('Cookie', cookie).expect(204);

      const cleared = (response.headers['set-cookie'] as unknown as string[]).find((header) =>
        header.startsWith(`${SESSION_COOKIE}=;`),
      );
      expect(cleared).toMatch(/Expires=Thu, 01 Jan 1970/);
      const [session] = await ctx.prisma.session.findMany();
      expect(session?.revokedAt).toBeInstanceOf(Date);
      // Replaying the old cookie (e.g. a copy taken before sign-out) no longer works.
      await http().get('/api/auth/me').set('Cookie', cookie).expect(401);
    });

    it('succeeds without a session, so the client can always sign out', async () => {
      await http().post('/api/auth/sign-out').expect(204);
      await http().post('/api/auth/sign-out').set('Cookie', sessionCookie('junk')).expect(204);
    });

    it('refuses a cross-site sign-out attempt', async () => {
      const { user } = await aUser();
      const cookie = await signIn(ctx.server, user.email);

      await http()
        .post('/api/auth/sign-out')
        .set('Cookie', cookie)
        .set('Sec-Fetch-Site', 'same-site')
        .expect(403);
      await http().get('/api/auth/me').set('Cookie', cookie).expect(200);
    });
  });
});
