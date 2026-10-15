import {
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  ProblemTypes,
  VoyageDetailSchema,
  VoyageListResponseSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { VoyagesService } from '../src/modules/voyages/voyages.service.js';
import { signIn } from './support/auth.js';
import {
  createOrganization,
  createReferenceData,
  createUser,
  createVoyage,
  resetDatabase,
} from './support/database.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('Voyages API', () => {
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

  /** An organization with one signed-in user. `cookie` authenticates as that user. */
  async function anOrganizationSignedIn(name: string, countryCode = 'NL') {
    const organization = await createOrganization(ctx.prisma, name, countryCode);
    const user = await createUser(ctx.prisma, organization.id);
    const cookie = await signIn(ctx.server, user.email);
    return { organization, user, cookie };
  }

  const references = (body: unknown) =>
    VoyageListResponseSchema.parse(body).items.map((voyage) => voyage.reference);

  describe('GET /api/voyages', () => {
    it('returns voyages that satisfy the published contract, latest laycan first', async () => {
      const refs = await createReferenceData(ctx.prisma);
      const exporter = await anOrganizationSignedIn('Exporter Co', 'BR');
      const participants = [
        { organizationId: exporter.organization.id, role: 'EXPORTER' as const },
      ];
      await createVoyage(ctx.prisma, refs, {
        reference: 'TF-A',
        laycanStart: '2026-09-01',
        participants,
      });
      await createVoyage(ctx.prisma, refs, {
        reference: 'TF-B',
        laycanStart: '2026-11-01',
        participants,
      });

      const response = await http().get('/api/voyages').set('Cookie', exporter.cookie).expect(200);

      expect(references(response.body)).toEqual(['TF-B', 'TF-A']);
      expect(response.headers['cache-control']).toBe('no-store');
    });

    it('serialises quantities as exact decimal strings and laycan as calendar dates', async () => {
      const refs = await createReferenceData(ctx.prisma);
      const exporter = await anOrganizationSignedIn('Exporter Co', 'BR');
      await createVoyage(ctx.prisma, refs, {
        reference: 'TF-A',
        quantity: '50000.125',
        laycanStart: '2026-11-01',
        laycanEnd: '2026-11-10',
        participants: [{ organizationId: exporter.organization.id, role: 'EXPORTER' }],
      });

      const response = await http().get('/api/voyages').set('Cookie', exporter.cookie).expect(200);

      const [voyage] = VoyageListResponseSchema.parse(response.body).items;
      expect(voyage?.quantity).toEqual({ amount: '50000.125', unit: 'MT' });
      expect(voyage?.laycan).toEqual({ start: '2026-11-01', end: '2026-11-10' });
    });

    it('filters by status', async () => {
      const refs = await createReferenceData(ctx.prisma);
      const exporter = await anOrganizationSignedIn('Exporter Co', 'BR');
      const participants = [
        { organizationId: exporter.organization.id, role: 'EXPORTER' as const },
      ];
      await createVoyage(ctx.prisma, refs, { reference: 'TF-A', status: 'LOADING', participants });
      await createVoyage(ctx.prisma, refs, { reference: 'TF-B', status: 'PLANNED', participants });

      const response = await http()
        .get('/api/voyages?status=LOADING')
        .set('Cookie', exporter.cookie)
        .expect(200);

      expect(references(response.body)).toEqual(['TF-A']);
    });

    it('rejects an unknown status with a validation problem', async () => {
      const { cookie } = await anOrganizationSignedIn('Exporter Co');

      const response = await http()
        .get('/api/voyages?status=SAILING')
        .set('Cookie', cookie)
        .expect(400);

      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.type).toBe(ProblemTypes.ValidationFailed);
      expect(problem.errors?.map((e) => e.path)).toEqual(['query.status']);
    });

    it('returns an empty list when the organization participates in no voyage', async () => {
      const { cookie } = await anOrganizationSignedIn('Newcomer BV');

      const response = await http().get('/api/voyages').set('Cookie', cookie).expect(200);
      expect(response.body).toEqual({ items: [] });
    });
  });

  describe('GET /api/voyages/:voyageId', () => {
    it('returns the voyage with participants in trade-flow order', async () => {
      const refs = await createReferenceData(ctx.prisma);
      const exporter = await anOrganizationSignedIn('Exporter Co', 'BR');
      const [traderB, traderA, buyer, surveyor] = await Promise.all([
        createOrganization(ctx.prisma, 'Trader B'),
        createOrganization(ctx.prisma, 'Trader A', 'CH'),
        createOrganization(ctx.prisma, 'Buyer GmbH', 'DE'),
        createOrganization(ctx.prisma, 'Survey BV'),
      ]);
      const voyage = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-A',
        participants: [
          { organizationId: surveyor.id, role: 'SURVEYOR' },
          { organizationId: buyer.id, role: 'FINAL_BUYER' },
          { organizationId: traderB.id, role: 'TRADER' },
          { organizationId: exporter.organization.id, role: 'EXPORTER' },
          { organizationId: traderA.id, role: 'TRADER' },
        ],
      });

      const response = await http()
        .get(`/api/voyages/${voyage.id}`)
        .set('Cookie', exporter.cookie)
        .expect(200);

      const detail = VoyageDetailSchema.parse(response.body);
      expect(detail.reference).toBe('TF-A');
      expect(detail.loadPort.unLocode).toBe('BRSSZ');
      expect(detail.participants.map((p) => `${p.role}:${p.organization.name}`)).toEqual([
        'EXPORTER:Exporter Co',
        'TRADER:Trader A',
        'TRADER:Trader B',
        'FINAL_BUYER:Buyer GmbH',
        'SURVEYOR:Survey BV',
      ]);
    });

    it('returns 404 problem details for an unknown voyage', async () => {
      const { cookie } = await anOrganizationSignedIn('Exporter Co');
      const id = '01990000-0000-7000-8006-999999999999';

      const response = await http().get(`/api/voyages/${id}`).set('Cookie', cookie).expect(404);

      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(ProblemDetailsSchema.parse(response.body)).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Voyage was not found.',
        instance: `/api/voyages/${id}`,
      });
    });

    it('returns 400 for an identifier that is not a UUID', async () => {
      const { cookie } = await anOrganizationSignedIn('Exporter Co');

      const response = await http()
        .get('/api/voyages/TF-2026-0001')
        .set('Cookie', cookie)
        .expect(400);

      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.errors).toEqual([{ path: 'param.voyageId', message: 'Invalid UUID' }]);
    });
  });

  describe('participation-based access', () => {
    /**
     * Three organizations: Exporter and Buyer share TF-SHARED; each also has a voyage of its own;
     * Outsider participates in nothing.
     */
    async function scenario() {
      const refs = await createReferenceData(ctx.prisma);
      const exporter = await anOrganizationSignedIn('Exporter Co', 'BR');
      const buyer = await anOrganizationSignedIn('Buyer GmbH', 'DE');
      const outsider = await anOrganizationSignedIn('Outsider BV');
      const shared = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-SHARED',
        status: 'IN_TRANSIT',
        laycanStart: '2026-10-01',
        laycanEnd: '2026-10-10',
        participants: [
          { organizationId: exporter.organization.id, role: 'EXPORTER' },
          { organizationId: buyer.organization.id, role: 'FINAL_BUYER' },
        ],
      });
      const exporterOnly = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-EXPORTER',
        status: 'LOADING',
        laycanStart: '2026-11-01',
        participants: [{ organizationId: exporter.organization.id, role: 'EXPORTER' }],
      });
      const buyerOnly = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-BUYER',
        status: 'PLANNED',
        laycanStart: '2026-12-01',
        laycanEnd: '2026-12-10',
        participants: [{ organizationId: buyer.organization.id, role: 'FINAL_BUYER' }],
      });
      return { exporter, buyer, outsider, shared, exporterOnly, buyerOnly };
    }

    it('requires authentication for both endpoints, before any input validation', async () => {
      const { shared } = await scenario();

      for (const path of [
        '/api/voyages',
        '/api/voyages?status=SAILING',
        `/api/voyages/${shared.id}`,
        '/api/voyages/not-a-uuid',
      ]) {
        const response = await http().get(path).expect(401);
        expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
        expect(ProblemDetailsSchema.parse(response.body)).toMatchObject({
          status: 401,
          title: 'Unauthorized',
          detail: 'Authentication is required.',
        });
      }
    });

    it('lets both participating organizations access their shared voyage', async () => {
      const { exporter, buyer, shared } = await scenario();

      for (const { cookie } of [exporter, buyer]) {
        const list = await http().get('/api/voyages').set('Cookie', cookie).expect(200);
        expect(references(list.body)).toContain('TF-SHARED');

        const detail = await http()
          .get(`/api/voyages/${shared.id}`)
          .set('Cookie', cookie)
          .expect(200);
        expect(VoyageDetailSchema.parse(detail.body).reference).toBe('TF-SHARED');
      }
    });

    it('shows each organization only the voyages it participates in', async () => {
      const { exporter, buyer, outsider } = await scenario();

      const listFor = async (cookie: string) =>
        references((await http().get('/api/voyages').set('Cookie', cookie).expect(200)).body);

      expect(await listFor(exporter.cookie)).toEqual(['TF-EXPORTER', 'TF-SHARED']);
      expect(await listFor(buyer.cookie)).toEqual(['TF-BUYER', 'TF-SHARED']);
      expect(await listFor(outsider.cookie)).toEqual([]);
    });

    it('lists a voyage once even when the organization holds several roles on it', async () => {
      const { exporter, shared } = await scenario();
      await ctx.prisma.voyageParticipant.create({
        data: { voyageId: shared.id, organizationId: exporter.organization.id, role: 'TRADER' },
      });

      const response = await http().get('/api/voyages').set('Cookie', exporter.cookie).expect(200);
      expect(references(response.body)).toEqual(['TF-EXPORTER', 'TF-SHARED']);
    });

    it('does not let status filtering bypass organization scoping', async () => {
      const { exporter, outsider } = await scenario();

      // PLANNED exists only on the buyer's own voyage.
      const planned = await http()
        .get('/api/voyages?status=PLANNED')
        .set('Cookie', exporter.cookie)
        .expect(200);
      expect(references(planned.body)).toEqual([]);

      const inTransit = await http()
        .get('/api/voyages?status=IN_TRANSIT')
        .set('Cookie', outsider.cookie)
        .expect(200);
      expect(references(inTransit.body)).toEqual([]);
    });

    it('answers a non-participant exactly like a request for a missing voyage', async () => {
      const { outsider, shared } = await scenario();
      const missingId = '01990000-0000-7000-8006-999999999999';

      const forbidden = await http()
        .get(`/api/voyages/${shared.id}`)
        .set('Cookie', outsider.cookie)
        .expect(404);
      const missing = await http()
        .get(`/api/voyages/${missingId}`)
        .set('Cookie', outsider.cookie)
        .expect(404);

      expect(forbidden.headers['content-type']).toBe(missing.headers['content-type']);
      const { instance: forbiddenInstance, ...forbiddenProblem } = ProblemDetailsSchema.parse(
        forbidden.body,
      );
      const { instance: missingInstance, ...missingProblem } = ProblemDetailsSchema.parse(
        missing.body,
      );
      expect(forbiddenProblem).toEqual(missingProblem);
      expect(forbiddenInstance).toBe(`/api/voyages/${shared.id}`);
      expect(missingInstance).toBe(`/api/voyages/${missingId}`);
    });

    it('ignores organization ids supplied by the client', async () => {
      const { exporter, buyer, buyerOnly } = await scenario();
      const otherOrganization = buyer.organization.id;

      const list = await http()
        .get(`/api/voyages?organizationId=${otherOrganization}&status=PLANNED`)
        .set('Cookie', exporter.cookie)
        .set('X-Organization-Id', otherOrganization)
        .expect(200);
      expect(references(list.body)).toEqual([]);

      const unfiltered = await http()
        .get(`/api/voyages?organizationId=${otherOrganization}`)
        .set('Cookie', exporter.cookie)
        .set('X-Organization-Id', otherOrganization)
        .expect(200);
      expect(references(unfiltered.body)).toEqual(['TF-EXPORTER', 'TF-SHARED']);

      await http()
        .get(`/api/voyages/${buyerOnly.id}?organizationId=${otherOrganization}`)
        .set('Cookie', exporter.cookie)
        .set('X-Organization-Id', otherOrganization)
        .expect(404);
    });

    it('revokes access as soon as the organization stops participating', async () => {
      const { buyer, shared } = await scenario();
      await http().get(`/api/voyages/${shared.id}`).set('Cookie', buyer.cookie).expect(200);

      await ctx.prisma.voyageParticipant.deleteMany({
        where: { voyageId: shared.id, organizationId: buyer.organization.id },
      });

      // Same session, next request: the voyage is gone from both endpoints.
      await http().get(`/api/voyages/${shared.id}`).set('Cookie', buyer.cookie).expect(404);
      const list = await http().get('/api/voyages').set('Cookie', buyer.cookie).expect(200);
      expect(references(list.body)).toEqual(['TF-BUYER']);
    });

    it('stops serving voyages once the session is signed out', async () => {
      const { exporter } = await scenario();

      await http().post('/api/auth/sign-out').set('Cookie', exporter.cookie).expect(204);

      await http().get('/api/voyages').set('Cookie', exporter.cookie).expect(401);
    });
  });

  describe('unexpected failures', () => {
    it('return a generic 500 problem without leaking internals', async () => {
      const { cookie } = await anOrganizationSignedIn('Exporter Co');
      const spy = vi
        .spyOn(ctx.app.get(VoyagesService), 'list')
        .mockRejectedValueOnce(new Error('connection reset by peer'));
      try {
        const response = await http().get('/api/voyages').set('Cookie', cookie).expect(500);
        const problem = ProblemDetailsSchema.parse(response.body);
        expect(problem.detail).toBe('An unexpected error occurred.');
        expect(JSON.stringify(problem)).not.toContain('connection reset');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
