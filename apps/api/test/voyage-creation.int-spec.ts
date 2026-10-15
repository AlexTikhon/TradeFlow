import {
  type CreateVoyageRequest,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  ProblemTypes,
  VoyageDetailSchema,
  VoyageListResponseSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '../src/generated/prisma/client.js';
import { signIn } from './support/auth.js';
import {
  createOrganization,
  createReferenceData,
  createUser,
  resetDatabase,
} from './support/database.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const REFERENCE_FORMAT = /^TF-\d{4}-\d{4,}$/;
const UNKNOWN_ID = '01990000-0000-7000-8000-999999999999';

describe('Creating a voyage (POST /api/voyages)', () => {
  let ctx: TestApp;
  let refs: Awaited<ReturnType<typeof createReferenceData>>;
  const http = () => request(ctx.server);

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    refs = await createReferenceData(ctx.prisma);
  });

  /** A user with `role` in a new organization, signed in. `cookie` authenticates as them. */
  async function aSignedInUser(organizationName: string, role: UserRole) {
    const organization = await createOrganization(ctx.prisma, organizationName, 'BR');
    const user = await createUser(ctx.prisma, organization.id, { role });
    const cookie = await signIn(ctx.server, user.email);
    return { organization, user, cookie };
  }

  /** Another signed-in user of an existing organization. */
  async function aColleagueOf(organizationId: string, role: UserRole = 'VIEWER') {
    const user = await createUser(ctx.prisma, organizationId, { role });
    return { user, cookie: await signIn(ctx.server, user.email) };
  }

  const validBody = (overrides: Partial<CreateVoyageRequest> = {}): CreateVoyageRequest => ({
    vesselId: refs.vessel.id,
    commodityId: refs.commodity.id,
    quantity: { amount: '50000.125', unit: 'MT' },
    loadPortId: refs.loadPort.id,
    dischargePortId: refs.dischargePort.id,
    laycan: { start: '2026-11-01', end: '2026-11-10' },
    ...overrides,
  });

  const create = (cookie: string | undefined, body: unknown) => {
    const call = http().post('/api/voyages');
    return (cookie ? call.set('Cookie', cookie) : call).send(body as object);
  };

  /** Every row the operation could write. Failures must leave all of them untouched. */
  const writes = async () => ({
    voyages: await ctx.prisma.voyage.count(),
    participants: await ctx.prisma.voyageParticipant.count(),
    auditEvents: await ctx.prisma.auditEvent.count(),
    referenceCounters: await ctx.prisma.voyageReferenceCounter.count(),
  });
  const NO_WRITES = { voyages: 0, participants: 0, auditEvents: 0, referenceCounters: 0 };

  const references = (body: unknown) =>
    VoyageListResponseSchema.parse(body).items.map((voyage) => voyage.reference);

  describe('authorization', () => {
    it('answers 401 without a session, even before validating the body', async () => {
      for (const body of [validBody(), { status: 'COMPLETED' }]) {
        const response = await create(undefined, body).expect(401);
        expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
        expect(ProblemDetailsSchema.parse(response.body)).toMatchObject({
          status: 401,
          detail: 'Authentication is required.',
        });
      }
      expect(await writes()).toEqual(NO_WRITES);
    });

    it('answers 403 to a viewer and writes nothing', async () => {
      const viewer = await aSignedInUser('Exporter Co', 'VIEWER');

      const response = await create(viewer.cookie, validBody()).expect(403);

      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(ProblemDetailsSchema.parse(response.body)).toMatchObject({
        type: ProblemTypes.Generic,
        title: 'Forbidden',
        status: 403,
        detail: 'Your role does not allow you to create voyages.',
      });
      expect(await writes()).toEqual(NO_WRITES);
    });

    it('checks the role current at the time of the request, not at sign-in', async () => {
      const user = await aSignedInUser('Exporter Co', 'VIEWER');
      await create(user.cookie, validBody()).expect(403);

      await ctx.prisma.user.update({ where: { id: user.user.id }, data: { role: 'OPERATOR' } });
      await create(user.cookie, validBody()).expect(201);

      await ctx.prisma.user.update({ where: { id: user.user.id }, data: { role: 'VIEWER' } });
      await create(user.cookie, validBody()).expect(403);
      expect((await writes()).voyages).toBe(1);
    });

    it('refuses a cross-site request from an operator', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');

      await create(operator.cookie, validBody()).set('Sec-Fetch-Site', 'cross-site').expect(403);

      expect(await writes()).toEqual(NO_WRITES);
    });
  });

  describe('success', () => {
    it('creates a PLANNED voyage with the operator organization as its exporter', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');

      const response = await create(operator.cookie, validBody()).expect(201);

      const voyage = VoyageDetailSchema.parse(response.body);
      expect(response.headers.location).toBe(`/api/voyages/${voyage.id}`);
      expect(response.headers['cache-control']).toBe('no-store');
      expect(voyage).toMatchObject({
        status: 'PLANNED',
        vessel: { id: refs.vessel.id },
        commodity: { id: refs.commodity.id },
        quantity: { amount: '50000.125', unit: 'MT' },
        loadPort: { id: refs.loadPort.id, unLocode: 'BRSSZ' },
        dischargePort: { id: refs.dischargePort.id, unLocode: 'NLRTM' },
        laycan: { start: '2026-11-01', end: '2026-11-10' },
        participants: [
          {
            role: 'EXPORTER',
            organization: { id: operator.organization.id, name: 'Exporter Co' },
          },
        ],
      });
      expect(voyage.reference).toMatch(REFERENCE_FORMAT);
    });

    it('is immediately visible to every user of the organization, and to nobody else', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');
      const colleague = await aColleagueOf(operator.organization.id);
      const outsider = await aSignedInUser('Outsider BV', 'OPERATOR');

      const created = VoyageDetailSchema.parse(
        (await create(operator.cookie, validBody()).expect(201)).body,
      );

      for (const { cookie } of [operator, colleague]) {
        const list = await http().get('/api/voyages').set('Cookie', cookie).expect(200);
        expect(references(list.body)).toEqual([created.reference]);
        const detail = await http()
          .get(`/api/voyages/${created.id}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(VoyageDetailSchema.parse(detail.body)).toEqual(created);
      }

      const list = await http().get('/api/voyages').set('Cookie', outsider.cookie).expect(200);
      expect(references(list.body)).toEqual([]);
      await http().get(`/api/voyages/${created.id}`).set('Cookie', outsider.cookie).expect(404);
    });

    it('stores the largest quantity DECIMAL(14,3) holds exactly', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');

      const response = await create(
        operator.cookie,
        validBody({ quantity: { amount: '99999999999.999', unit: 'MT' } }),
      ).expect(201);

      const voyage = VoyageDetailSchema.parse(response.body);
      expect(voyage.quantity.amount).toBe('99999999999.999');
      const stored = await ctx.prisma.voyage.findUniqueOrThrow({ where: { id: voyage.id } });
      expect(stored.quantity.toFixed(3)).toBe('99999999999.999');
    });

    it('records exactly one VOYAGE_CREATED event with a server-derived actor and time', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');
      const before = Date.now();

      const voyage = VoyageDetailSchema.parse(
        (await create(operator.cookie, validBody()).expect(201)).body,
      );

      const after = Date.now();
      const events = await ctx.prisma.auditEvent.findMany();
      expect(events).toHaveLength(1);
      const [event] = events;
      expect(event).toMatchObject({
        action: 'VOYAGE_CREATED',
        voyageId: voyage.id,
        actorUserId: operator.user.id,
        actorOrganizationId: operator.organization.id,
        payload: {
          reference: voyage.reference,
          status: 'PLANNED',
          vesselId: refs.vessel.id,
          commodityId: refs.commodity.id,
          quantity: { amount: '50000.125', unit: 'MT' },
          loadPortId: refs.loadPort.id,
          dischargePortId: refs.dischargePort.id,
          laycan: { start: '2026-11-01', end: '2026-11-10' },
          participants: [{ organizationId: operator.organization.id, role: 'EXPORTER' }],
        },
      });
      // Stamped by the server while handling this request; the client sends no time at all.
      expect(event?.occurredAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(event?.occurredAt.getTime()).toBeLessThanOrEqual(after);
    });
  });

  describe('server-derived identity', () => {
    it('rejects a body that tries to set ownership, participants, status or the actor', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');
      const other = await createOrganization(ctx.prisma, 'Other Co');

      const response = await create(operator.cookie, {
        ...validBody(),
        organizationId: other.id,
        participants: [{ organizationId: other.id, role: 'EXPORTER' }],
        status: 'COMPLETED',
        reference: 'TF-1999-0001',
        actorUserId: UNKNOWN_ID,
      }).expect(400);

      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.type).toBe(ProblemTypes.ValidationFailed);
      expect(problem.errors).toEqual([
        {
          path: 'body',
          message: expect.stringContaining('organizationId') as string,
        },
      ]);
      for (const field of ['participants', 'status', 'reference', 'actorUserId']) {
        expect(problem.errors?.[0]?.message).toContain(field);
      }
      expect(await writes()).toEqual(NO_WRITES);
    });

    it('ignores organization ids in headers and query strings', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');
      const other = await aSignedInUser('Other Co', 'OPERATOR');

      const response = await http()
        .post(`/api/voyages?organizationId=${other.organization.id}`)
        .set('Cookie', operator.cookie)
        .set('X-Organization-Id', other.organization.id)
        .set('X-User-Id', other.user.id)
        .send(validBody())
        .expect(201);

      const voyage = VoyageDetailSchema.parse(response.body);
      expect(voyage.participants.map((p) => p.organization.id)).toEqual([operator.organization.id]);
      expect(await ctx.prisma.auditEvent.findFirstOrThrow()).toMatchObject({
        actorUserId: operator.user.id,
        actorOrganizationId: operator.organization.id,
      });
      const othersList = await http().get('/api/voyages').set('Cookie', other.cookie).expect(200);
      expect(references(othersList.body)).toEqual([]);
    });
  });

  describe('validation', () => {
    it.each<[string, (body: CreateVoyageRequest) => unknown, string[]]>([
      [
        'excess decimal places',
        (b) => ({ ...b, quantity: { amount: '1.0001', unit: 'MT' } }),
        ['body.quantity.amount'],
      ],
      [
        'zero quantity',
        (b) => ({ ...b, quantity: { amount: '0.000', unit: 'MT' } }),
        ['body.quantity.amount'],
      ],
      [
        'negative quantity',
        (b) => ({ ...b, quantity: { amount: '-5', unit: 'MT' } }),
        ['body.quantity.amount'],
      ],
      [
        'a quantity too large for DECIMAL(14,3)',
        (b) => ({ ...b, quantity: { amount: '100000000000', unit: 'MT' } }),
        ['body.quantity.amount'],
      ],
      [
        'a numeric quantity',
        (b) => ({ ...b, quantity: { amount: 50000, unit: 'MT' } }),
        ['body.quantity.amount'],
      ],
      [
        'an unknown unit',
        (b) => ({ ...b, quantity: { amount: '5', unit: 'KG' } }),
        ['body.quantity.unit'],
      ],
      [
        'a laycan ending before it starts',
        (b) => ({ ...b, laycan: { start: '2026-11-10', end: '2026-11-09' } }),
        ['body.laycan.end'],
      ],
      [
        'a date that does not exist',
        (b) => ({ ...b, laycan: { start: '2026-02-30', end: '2026-03-05' } }),
        ['body.laycan.start'],
      ],
      [
        'the same port twice',
        (b) => ({ ...b, dischargePortId: b.loadPortId }),
        ['body.dischargePortId'],
      ],
      ['a malformed id', (b) => ({ ...b, vesselId: 'MV Horizon' }), ['body.vesselId']],
      [
        'missing fields',
        ({ commodityId: _commodityId, laycan: _laycan, ...rest }) => rest,
        ['body.commodityId', 'body.laycan'],
      ],
      ['an unknown vessel', (b) => ({ ...b, vesselId: UNKNOWN_ID }), ['body.vesselId']],
      ['an unknown commodity', (b) => ({ ...b, commodityId: UNKNOWN_ID }), ['body.commodityId']],
      [
        'unknown ports',
        (b) => ({
          ...b,
          loadPortId: UNKNOWN_ID,
          dischargePortId: '01990000-0000-7000-8000-999999999998',
        }),
        ['body.loadPortId', 'body.dischargePortId'],
      ],
    ])('rejects %s with problem details and writes nothing', async (_case, change, paths) => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');

      const response = await create(operator.cookie, change(validBody())).expect(400);

      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem).toMatchObject({
        type: ProblemTypes.ValidationFailed,
        status: 400,
        instance: '/api/voyages',
      });
      expect(problem.errors?.map((error) => error.path)).toEqual(paths);
      expect(await writes()).toEqual(NO_WRITES);
    });

    it('explains excess precision instead of rounding it', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');

      const response = await create(
        operator.cookie,
        validBody({ quantity: { amount: '50000.1255', unit: 'MT' } }),
      ).expect(400);

      expect(ProblemDetailsSchema.parse(response.body).errors).toEqual([
        { path: 'body.quantity.amount', message: 'Use at most 3 decimal places' },
      ]);
    });
  });

  describe('atomicity', () => {
    it('leaves no voyage, participation or reference behind when the audit write fails', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');
      // A real database failure inside the transaction, after the voyage rows were inserted.
      await ctx.prisma.$executeRawUnsafe(`
        CREATE FUNCTION test_audit_unavailable() RETURNS trigger LANGUAGE plpgsql
        AS $$ BEGIN RAISE EXCEPTION 'audit store unavailable'; END $$`);
      await ctx.prisma.$executeRawUnsafe(`
        CREATE TRIGGER test_audit_unavailable BEFORE INSERT ON audit_events
        FOR EACH ROW EXECUTE FUNCTION test_audit_unavailable()`);
      try {
        const response = await create(operator.cookie, validBody()).expect(500);

        const problem = ProblemDetailsSchema.parse(response.body);
        expect(problem.detail).toBe('An unexpected error occurred.');
        expect(JSON.stringify(problem)).not.toContain('audit store');
        expect(await writes()).toEqual(NO_WRITES);
      } finally {
        await ctx.prisma.$executeRawUnsafe('DROP TRIGGER test_audit_unavailable ON audit_events');
        await ctx.prisma.$executeRawUnsafe('DROP FUNCTION test_audit_unavailable()');
      }

      // The failed attempt gave its reference number back.
      const response = await create(operator.cookie, validBody()).expect(201);
      expect(VoyageDetailSchema.parse(response.body).reference).toMatch(/-0001$/);
    });

    it('keeps the audit trail append-only for every writer', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');
      await create(operator.cookie, validBody()).expect(201);

      await expect(ctx.prisma.auditEvent.updateMany({ data: { payload: {} } })).rejects.toThrow();
      await expect(ctx.prisma.auditEvent.deleteMany()).rejects.toThrow();
      expect(await ctx.prisma.auditEvent.count()).toBe(1);
    });
  });

  describe('references', () => {
    it('stay unique and consecutive under concurrent creation', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');
      const colleague = await aColleagueOf(operator.organization.id, 'OPERATOR');
      const attempts = 8;

      const responses = await Promise.all(
        Array.from({ length: attempts }, (_, index) =>
          create(index % 2 ? colleague.cookie : operator.cookie, validBody()),
        ),
      );

      expect(responses.map((response) => response.status)).toEqual(
        Array<number>(attempts).fill(201),
      );
      const numbers = responses
        .map((response) => VoyageDetailSchema.parse(response.body).reference)
        .map((reference) => Number(reference.split('-')[2]))
        .toSorted((a, b) => a - b);
      expect(numbers).toEqual(Array.from({ length: attempts }, (_, index) => index + 1));
      expect(await ctx.prisma.auditEvent.count()).toBe(attempts);
    });

    it('continue from the counter, padded to at least four digits', async () => {
      const operator = await aSignedInUser('Exporter Co', 'OPERATOR');
      const year = new Date().getUTCFullYear();
      await ctx.prisma.voyageReferenceCounter.create({ data: { year, lastNumber: 9999 } });

      const response = await create(operator.cookie, validBody()).expect(201);

      expect(VoyageDetailSchema.parse(response.body).reference).toBe(`TF-${year}-10000`);
    });
  });
});

describe('Reference data lookups', () => {
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

  it('require a session', async () => {
    for (const path of ['/api/vessels', '/api/commodities', '/api/ports']) {
      await http().get(path).expect(401);
    }
  });

  it('list vessels, commodities and ports by name for any signed-in user', async () => {
    const refs = await createReferenceData(ctx.prisma);
    const organization = await createOrganization(ctx.prisma, 'Viewer Co');
    const user = await createUser(ctx.prisma, organization.id);
    const cookie = await signIn(ctx.server, user.email);

    const vessels = await http().get('/api/vessels').set('Cookie', cookie).expect(200);
    expect(vessels.body).toEqual({
      items: [{ id: refs.vessel.id, name: refs.vessel.name, imoNumber: refs.vessel.imoNumber }],
    });
    const commodities = await http().get('/api/commodities').set('Cookie', cookie).expect(200);
    expect(commodities.body).toEqual({
      items: [{ id: refs.commodity.id, code: refs.commodity.code, name: 'Soybeans' }],
    });
    const ports = await http().get('/api/ports').set('Cookie', cookie).expect(200);
    expect(ports.body).toEqual({
      items: [
        { id: refs.dischargePort.id, unLocode: 'NLRTM', name: 'Rotterdam', countryCode: 'NL' },
        { id: refs.loadPort.id, unLocode: 'BRSSZ', name: 'Santos', countryCode: 'BR' },
      ],
    });
  });
});
