import {
  ORGANIZATION_SEARCH_MAX_RESULTS,
  OrganizationSearchResponseSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '../src/generated/prisma/client.js';
import { signIn } from './support/auth.js';
import {
  createOrganization,
  createReferenceData,
  createUser,
  createVoyage,
  resetDatabase,
} from './support/database.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('Finding organizations (GET /api/organizations)', () => {
  let ctx: TestApp;
  const api = () => request(ctx.server);

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  /** A signed-in user with `role` of `organizationId`. */
  async function aMemberOf(organizationId: string, role: UserRole) {
    const user = await createUser(ctx.prisma, organizationId, { role });
    return signIn(ctx.server, user.email);
  }

  const search = (cookie: string | undefined, query: Record<string, string | string[]>) => {
    const call = api().get('/api/organizations').query(query);
    return cookie ? call.set('Cookie', cookie) : call;
  };

  const names = (body: unknown) =>
    OrganizationSearchResponseSchema.parse(body).items.map(({ name }) => name);

  it('answers 401 without a session', async () => {
    const response = await search(undefined, { search: 'grain' }).expect(401);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
  });

  it('answers 403 to a viewer: only operators can use the result', async () => {
    const own = await createOrganization(ctx.prisma, 'Cerrado Grãos', 'BR');
    await createOrganization(ctx.prisma, 'Lacustra Commodities', 'CH');
    const response = await search(await aMemberOf(own.id, 'VIEWER'), { search: 'lac' }).expect(403);
    expect(ProblemDetailsSchema.parse(response.body).detail).toBe(
      'Your role does not allow you to search organizations.',
    );
  });

  it('matches part of the name, ignoring case, and serves only id, name and country, by name', async () => {
    const own = await createOrganization(ctx.prisma, 'Cerrado Grãos', 'BR');
    const lacustra = await createOrganization(ctx.prisma, 'Lacustra Commodities', 'CH');
    await createOrganization(ctx.prisma, 'Agro Commodities', 'AR');
    await createOrganization(ctx.prisma, 'Rhine Valley Crushers', 'DE');
    const cookie = await aMemberOf(own.id, 'OPERATOR');

    const response = await search(cookie, { search: 'COMMOD' }).expect(200);

    expect(names(response.body)).toEqual(['Agro Commodities', 'Lacustra Commodities']);
    expect((response.body as { items: unknown[] }).items[1]).toEqual({
      id: lacustra.id,
      name: 'Lacustra Commodities',
      countryCode: 'CH',
    });
    expect(Object.keys(response.body as object)).toEqual(['items']);
  });

  it('never returns the caller’s own organization', async () => {
    const own = await createOrganization(ctx.prisma, 'Grain Exporter', 'BR');
    await createOrganization(ctx.prisma, 'Grain Importer', 'DE');

    const response = await search(await aMemberOf(own.id, 'OPERATOR'), { search: 'grain' }).expect(
      200,
    );

    expect(names(response.body)).toEqual(['Grain Importer']);
  });

  it(`returns at most ${ORGANIZATION_SEARCH_MAX_RESULTS}`, async () => {
    const own = await createOrganization(ctx.prisma, 'Caller', 'BR');
    for (let index = 1; index <= ORGANIZATION_SEARCH_MAX_RESULTS + 5; index++) {
      await createOrganization(ctx.prisma, `Trader ${String(index).padStart(2, '0')}`);
    }

    const response = await search(await aMemberOf(own.id, 'OPERATOR'), { search: 'trader' }).expect(
      200,
    );

    expect(names(response.body)).toEqual(
      Array.from(
        { length: ORGANIZATION_SEARCH_MAX_RESULTS },
        (_, index) => `Trader ${String(index + 1).padStart(2, '0')}`,
      ),
    );
  });

  it('treats %, _ and \\ in the search text literally', async () => {
    const own = await createOrganization(ctx.prisma, 'Caller', 'BR');
    await createOrganization(ctx.prisma, 'Fifty Percent Trading');
    await createOrganization(ctx.prisma, '100% Grain_Co');
    await createOrganization(ctx.prisma, 'Back\\slash Ltd');
    const cookie = await aMemberOf(own.id, 'OPERATOR');

    expect(names((await search(cookie, { search: '%%' }).expect(200)).body)).toEqual([]);
    expect(names((await search(cookie, { search: '0%' }).expect(200)).body)).toEqual([
      '100% Grain_Co',
    ]);
    expect(names((await search(cookie, { search: 'n_C' }).expect(200)).body)).toEqual([
      '100% Grain_Co',
    ]);
    expect(names((await search(cookie, { search: '__' }).expect(200)).body)).toEqual([]);
    expect(names((await search(cookie, { search: 'k\\s' }).expect(200)).body)).toEqual([
      'Back\\slash Ltd',
    ]);
  });

  it('says nothing about voyages: participants and strangers look the same', async () => {
    const refs = await createReferenceData(ctx.prisma);
    const own = await createOrganization(ctx.prisma, 'Caller', 'BR');
    const partner = await createOrganization(ctx.prisma, 'Partner Trading', 'CH');
    const stranger = await createOrganization(ctx.prisma, 'Stranger Trading', 'DE');
    await createVoyage(ctx.prisma, refs, {
      reference: 'TF-SHARED',
      participants: [
        { organizationId: own.id, role: 'EXPORTER' },
        { organizationId: partner.id, role: 'FINAL_BUYER' },
      ],
    });

    const response = await search(await aMemberOf(own.id, 'OPERATOR'), {
      search: 'trading',
    }).expect(200);

    expect(response.body).toEqual({
      items: [
        { id: partner.id, name: 'Partner Trading', countryCode: 'CH' },
        { id: stranger.id, name: 'Stranger Trading', countryCode: 'DE' },
      ],
    });
  });

  it.each<[string, Record<string, string | string[]>]>([
    ['no search text', {}],
    ['one character', { search: 'a' }],
    ['only spaces around one character', { search: '  a  ' }],
    ['more than 100 characters', { search: 'x'.repeat(101) }],
    ['a repeated parameter', { search: ['ab', 'cd'] }],
  ])('refuses %s with 400', async (_case, query) => {
    const own = await createOrganization(ctx.prisma, 'Caller', 'BR');
    const response = await search(await aMemberOf(own.id, 'OPERATOR'), query).expect(400);
    expect(ProblemDetailsSchema.parse(response.body).errors?.map(({ path }) => path)).toEqual([
      'query.search',
    ]);
  });
});
