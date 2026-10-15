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
import {
  createOrganization,
  createReferenceData,
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

  describe('GET /api/voyages', () => {
    it('returns voyages that satisfy the published contract, latest laycan first', async () => {
      const refs = await createReferenceData(ctx.prisma);
      await createVoyage(ctx.prisma, refs, { reference: 'TF-A', laycanStart: '2026-09-01' });
      await createVoyage(ctx.prisma, refs, { reference: 'TF-B', laycanStart: '2026-11-01' });

      const response = await http().get('/api/voyages').expect(200);

      const body = VoyageListResponseSchema.parse(response.body);
      expect(body.items.map((v) => v.reference)).toEqual(['TF-B', 'TF-A']);
    });

    it('serialises quantities as exact decimal strings and laycan as calendar dates', async () => {
      const refs = await createReferenceData(ctx.prisma);
      await createVoyage(ctx.prisma, refs, {
        reference: 'TF-A',
        quantity: '50000.125',
        laycanStart: '2026-11-01',
        laycanEnd: '2026-11-10',
      });

      const response = await http().get('/api/voyages').expect(200);

      const [voyage] = VoyageListResponseSchema.parse(response.body).items;
      expect(voyage?.quantity).toEqual({ amount: '50000.125', unit: 'MT' });
      expect(voyage?.laycan).toEqual({ start: '2026-11-01', end: '2026-11-10' });
    });

    it('filters by status', async () => {
      const refs = await createReferenceData(ctx.prisma);
      await createVoyage(ctx.prisma, refs, { reference: 'TF-A', status: 'LOADING' });
      await createVoyage(ctx.prisma, refs, { reference: 'TF-B', status: 'PLANNED' });

      const response = await http().get('/api/voyages?status=LOADING').expect(200);

      const body = VoyageListResponseSchema.parse(response.body);
      expect(body.items.map((v) => v.reference)).toEqual(['TF-A']);
    });

    it('rejects an unknown status with a validation problem', async () => {
      const response = await http().get('/api/voyages?status=SAILING').expect(400);

      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.type).toBe(ProblemTypes.ValidationFailed);
      expect(problem.errors?.map((e) => e.path)).toEqual(['query.status']);
    });

    it('returns an empty list when there are no voyages', async () => {
      const response = await http().get('/api/voyages').expect(200);
      expect(response.body).toEqual({ items: [] });
    });
  });

  describe('GET /api/voyages/:voyageId', () => {
    it('returns the voyage with participants in trade-flow order', async () => {
      const refs = await createReferenceData(ctx.prisma);
      const [exporter, traderB, traderA, buyer, surveyor] = await Promise.all([
        createOrganization(ctx.prisma, 'Exporter Co', 'BR'),
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
          { organizationId: exporter.id, role: 'EXPORTER' },
          { organizationId: traderA.id, role: 'TRADER' },
        ],
      });

      const response = await http().get(`/api/voyages/${voyage.id}`).expect(200);

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
      const id = '01990000-0000-7000-8006-999999999999';
      const response = await http().get(`/api/voyages/${id}`).expect(404);

      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(ProblemDetailsSchema.parse(response.body)).toMatchObject({
        status: 404,
        title: 'Not Found',
        instance: `/api/voyages/${id}`,
      });
    });

    it('returns 400 for an identifier that is not a UUID', async () => {
      const response = await http().get('/api/voyages/TF-2026-0001').expect(400);

      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.errors).toEqual([{ path: 'param.voyageId', message: 'Invalid UUID' }]);
    });
  });

  describe('unexpected failures', () => {
    it('return a generic 500 problem without leaking internals', async () => {
      const spy = vi
        .spyOn(ctx.app.get(VoyagesService), 'list')
        .mockRejectedValueOnce(new Error('connection reset by peer'));
      try {
        const response = await http().get('/api/voyages').expect(500);
        const problem = ProblemDetailsSchema.parse(response.body);
        expect(problem.detail).toBe('An unexpected error occurred.');
        expect(JSON.stringify(problem)).not.toContain('connection reset');
      } finally {
        spy.mockRestore();
      }
    });
  });
});
