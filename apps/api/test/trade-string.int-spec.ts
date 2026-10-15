import {
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  type TradeString,
  TradeStringSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { signIn } from './support/auth.js';
import {
  createOrganization,
  createReferenceData,
  createTradeString,
  createUser,
  createVoyage,
  resetDatabase,
} from './support/database.js';
import { createTestApp, type TestApp } from './support/test-app.js';

describe('Trade string (GET /api/voyages/:voyageId/trade-string)', () => {
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

  async function anOrganizationSignedIn(name: string, countryCode = 'NL') {
    const organization = await createOrganization(ctx.prisma, name, countryCode);
    const user = await createUser(ctx.prisma, organization.id);
    const cookie = await signIn(ctx.server, user.email);
    return { organization, user, cookie };
  }

  const path = (voyageId: string) => `/api/voyages/${voyageId}/trade-string`;

  /**
   * TF-STRING: Exporter → Zenith Trading → Alpine Trading → Buyer, with a surveyor and a
   * shipping agent. The traders' contract order is the reverse of their alphabetical order, and
   * participants are inserted in yet another order, so only the contract positions can produce
   * the expected sequence. Outsider participates in nothing.
   */
  async function scenario() {
    const refs = await createReferenceData(ctx.prisma);
    const exporter = await anOrganizationSignedIn('Exporter Co', 'BR');
    const zenith = await anOrganizationSignedIn('Zenith Trading', 'CH');
    const alpine = await anOrganizationSignedIn('Alpine Trading', 'SG');
    const buyer = await anOrganizationSignedIn('Buyer GmbH', 'DE');
    const surveyor = await anOrganizationSignedIn('Survey BV');
    const agent = await anOrganizationSignedIn('Agency Ltda', 'BR');
    const outsider = await anOrganizationSignedIn('Outsider BV');
    const voyage = await createVoyage(ctx.prisma, refs, {
      reference: 'TF-STRING',
      participants: [
        { organizationId: surveyor.organization.id, role: 'SURVEYOR' },
        { organizationId: buyer.organization.id, role: 'FINAL_BUYER' },
        { organizationId: alpine.organization.id, role: 'TRADER' },
        { organizationId: agent.organization.id, role: 'SHIPPING_AGENT' },
        { organizationId: exporter.organization.id, role: 'EXPORTER' },
        { organizationId: zenith.organization.id, role: 'TRADER' },
      ],
    });
    await createTradeString(ctx.prisma, voyage.id, [
      exporter.organization.id,
      zenith.organization.id,
      alpine.organization.id,
      buyer.organization.id,
    ]);
    return { refs, voyage, exporter, zenith, alpine, buyer, surveyor, agent, outsider };
  }

  const describeString = (tradeString: TradeString) =>
    tradeString.parties.map(({ role, organization }) => `${role}:${organization.name}`);

  describe('reading the topology', () => {
    it('returns parties in contract order, with the edges connecting them', async () => {
      const { voyage, exporter, zenith, alpine, buyer } = await scenario();

      const response = await http().get(path(voyage.id)).set('Cookie', exporter.cookie).expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
      const tradeString = TradeStringSchema.parse(response.body);
      expect(describeString(tradeString)).toEqual([
        'EXPORTER:Exporter Co',
        'TRADER:Zenith Trading',
        'TRADER:Alpine Trading',
        'FINAL_BUYER:Buyer GmbH',
      ]);
      expect(tradeString.parties[1]?.organization).toEqual({
        id: zenith.organization.id,
        name: 'Zenith Trading',
        countryCode: 'CH',
      });
      expect(tradeString.edges).toEqual([
        {
          position: 1,
          sellerOrganizationId: exporter.organization.id,
          buyerOrganizationId: zenith.organization.id,
        },
        {
          position: 2,
          sellerOrganizationId: zenith.organization.id,
          buyerOrganizationId: alpine.organization.id,
        },
        {
          position: 3,
          sellerOrganizationId: alpine.organization.id,
          buyerOrganizationId: buyer.organization.id,
        },
      ]);
    });

    it('shows the same topology to every participant, service providers included', async () => {
      const { voyage, exporter, zenith, alpine, buyer, surveyor, agent } = await scenario();

      const bodies = [];
      for (const { cookie } of [exporter, zenith, alpine, buyer, surveyor, agent]) {
        bodies.push((await http().get(path(voyage.id)).set('Cookie', cookie).expect(200)).body);
      }

      for (const body of bodies) {
        expect(body).toEqual(bodies[0]);
      }
    });

    it('leaves service providers out of the string', async () => {
      const { voyage, exporter } = await scenario();

      const response = await http().get(path(voyage.id)).set('Cookie', exporter.cookie).expect(200);

      const names = TradeStringSchema.parse(response.body).parties.map((p) => p.organization.name);
      expect(names).not.toContain('Survey BV');
      expect(names).not.toContain('Agency Ltda');
    });

    it('answers an empty string for a voyage without contracts', async () => {
      const refs = await createReferenceData(ctx.prisma);
      const exporter = await anOrganizationSignedIn('Exporter Co', 'BR');
      const voyage = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-NEW',
        participants: [{ organizationId: exporter.organization.id, role: 'EXPORTER' }],
      });

      const response = await http().get(path(voyage.id)).set('Cookie', exporter.cookie).expect(200);

      expect(response.body).toEqual({ parties: [], edges: [] });
    });

    it('answers an empty string for a voyage created through the API', async () => {
      const refs = await createReferenceData(ctx.prisma);
      const organization = await createOrganization(ctx.prisma, 'Exporter Co', 'BR');
      const operator = await createUser(ctx.prisma, organization.id, { role: 'OPERATOR' });
      const cookie = await signIn(ctx.server, operator.email);
      const created = await http()
        .post('/api/voyages')
        .set('Cookie', cookie)
        .send({
          vesselId: refs.vessel.id,
          commodityId: refs.commodity.id,
          quantity: { amount: '50000', unit: 'MT' },
          loadPortId: refs.loadPort.id,
          dischargePortId: refs.dischargePort.id,
          laycan: { start: '2026-11-01', end: '2026-11-10' },
        })
        .expect(201);

      const response = await http()
        .get(path((created.body as { id: string }).id))
        .set('Cookie', cookie)
        .expect(200);

      expect(response.body).toEqual({ parties: [], edges: [] });
    });
  });

  describe('what the response does not contain', () => {
    it('holds exactly the topology fields, and no participant or contract identifiers', async () => {
      const { voyage, exporter } = await scenario();
      const contracts = await ctx.prisma.tradeContract.findMany({ where: { voyageId: voyage.id } });
      const participants = await ctx.prisma.voyageParticipant.findMany({
        where: { voyageId: voyage.id },
      });

      const response = await http().get(path(voyage.id)).set('Cookie', exporter.cookie).expect(200);

      // The raw body, before any schema could strip unknown fields.
      const body = response.body as {
        parties: { organization: object }[];
        edges: object[];
      };
      const keys = (value: object) => Object.keys(value).sort();
      expect(keys(body)).toEqual(['edges', 'parties']);
      for (const party of body.parties) {
        expect(keys(party)).toEqual(['organization', 'role']);
        expect(keys(party.organization)).toEqual(['countryCode', 'id', 'name']);
      }
      for (const edge of body.edges) {
        expect(keys(edge)).toEqual(['buyerOrganizationId', 'position', 'sellerOrganizationId']);
      }

      const raw = JSON.stringify(body);
      for (const { id } of [...contracts, ...participants]) {
        expect(raw).not.toContain(id);
      }
      expect(raw).not.toMatch(/price|reference|terms|createdAt/i);
    });
  });

  describe('access', () => {
    it('requires authentication, before validating the identifier', async () => {
      const { voyage } = await scenario();

      for (const voyagePath of [path(voyage.id), path('not-a-uuid')]) {
        const response = await http().get(voyagePath).expect(401);
        expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
        expect(ProblemDetailsSchema.parse(response.body)).toMatchObject({ status: 401 });
      }
    });

    it('answers an outsider exactly like a request for a missing voyage', async () => {
      const { voyage, outsider } = await scenario();
      const missingId = '01990000-0000-7000-8006-999999999999';

      const forbidden = await http()
        .get(path(voyage.id))
        .set('Cookie', outsider.cookie)
        .expect(404);
      const missing = await http().get(path(missingId)).set('Cookie', outsider.cookie).expect(404);

      expect(forbidden.headers['content-type']).toBe(missing.headers['content-type']);
      const { instance: forbiddenInstance, ...forbiddenProblem } = ProblemDetailsSchema.parse(
        forbidden.body,
      );
      const { instance: missingInstance, ...missingProblem } = ProblemDetailsSchema.parse(
        missing.body,
      );
      expect(forbiddenProblem).toEqual(missingProblem);
      expect(forbiddenProblem).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'Voyage was not found.',
      });
      expect(forbiddenInstance).toBe(path(voyage.id));
      expect(missingInstance).toBe(path(missingId));
    });

    it('ignores organization ids supplied by the client', async () => {
      const { voyage, outsider, exporter } = await scenario();

      await http()
        .get(`${path(voyage.id)}?organizationId=${exporter.organization.id}`)
        .set('Cookie', outsider.cookie)
        .set('X-Organization-Id', exporter.organization.id)
        .expect(404);
    });

    it('revokes access as soon as the organization stops participating', async () => {
      const { voyage, surveyor } = await scenario();
      await http().get(path(voyage.id)).set('Cookie', surveyor.cookie).expect(200);

      await ctx.prisma.voyageParticipant.deleteMany({
        where: { voyageId: voyage.id, organizationId: surveyor.organization.id },
      });

      await http().get(path(voyage.id)).set('Cookie', surveyor.cookie).expect(404);
    });

    it('rejects an identifier that is not a UUID', async () => {
      const { exporter } = await scenario();

      const response = await http()
        .get(path('TF-2026-0001'))
        .set('Cookie', exporter.cookie)
        .expect(400);

      expect(ProblemDetailsSchema.parse(response.body).errors).toEqual([
        { path: 'param.voyageId', message: 'Invalid UUID' },
      ]);
    });
  });

  describe('a stored chain that breaks the domain rules', () => {
    it('is a server error, never shown as a valid string', async () => {
      const { voyage, exporter } = await scenario();
      // Positions 1, 2, 4: rows the database accepts, a chain the domain does not.
      await ctx.prisma.tradeContract.update({
        where: { voyageId_position: { voyageId: voyage.id, position: 3 } },
        data: { position: 4 },
      });

      const response = await http().get(path(voyage.id)).set('Cookie', exporter.cookie).expect(500);

      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.detail).toBe('An unexpected error occurred.');
      expect(JSON.stringify(problem)).not.toMatch(/position|contract/i);
    });
  });
});

describe('trade_contracts database constraints', () => {
  let ctx: TestApp;

  beforeAll(async () => {
    ctx = await createTestApp();
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
  });

  /** Two voyages with their own exporter, trader and buyer participants. */
  async function twoVoyages() {
    const refs = await createReferenceData(ctx.prisma);
    const [exporter, trader, buyer] = await Promise.all([
      createOrganization(ctx.prisma, 'Exporter Co', 'BR'),
      createOrganization(ctx.prisma, 'Trader SA', 'CH'),
      createOrganization(ctx.prisma, 'Buyer GmbH', 'DE'),
    ]);
    const parties = [
      { organizationId: exporter.id, role: 'EXPORTER' as const },
      { organizationId: trader.id, role: 'TRADER' as const },
      { organizationId: buyer.id, role: 'FINAL_BUYER' as const },
    ];
    const voyages = [];
    for (const reference of ['TF-A', 'TF-B']) {
      const voyage = await createVoyage(ctx.prisma, refs, { reference, participants: parties });
      const rows = await ctx.prisma.voyageParticipant.findMany({ where: { voyageId: voyage.id } });
      const participant = (organizationId: string) =>
        rows.find((row) => row.organizationId === organizationId)?.id ?? '';
      voyages.push({
        id: voyage.id,
        exporter: participant(exporter.id),
        trader: participant(trader.id),
        buyer: participant(buyer.id),
      });
    }
    const [a, b] = voyages;
    if (!a || !b) throw new Error('unreachable');
    return { a, b };
  }

  /** Inserts with plain SQL, as any writer could: the database alone must refuse bad rows. */
  const insert = (voyageId: string, position: number, seller: string, buyer: string) =>
    ctx.prisma.$executeRaw`
      INSERT INTO trade_contracts (voyage_id, position, seller_participant_id, buyer_participant_id)
      VALUES (${voyageId}::uuid, ${position}, ${seller}::uuid, ${buyer}::uuid)`;

  it('accepts a well-formed contract', async () => {
    const { a } = await twoVoyages();
    await expect(insert(a.id, 1, a.exporter, a.buyer)).resolves.toBe(1);
  });

  it('rejects a seller who participates in another voyage', async () => {
    const { a, b } = await twoVoyages();
    await expect(insert(a.id, 1, b.exporter, a.buyer)).rejects.toThrow(
      /trade_contracts_voyage_id_seller_participant_id_fkey/,
    );
  });

  it('rejects a buyer who participates in another voyage', async () => {
    const { a, b } = await twoVoyages();
    await expect(insert(a.id, 1, a.exporter, b.buyer)).rejects.toThrow(
      /trade_contracts_voyage_id_buyer_participant_id_fkey/,
    );
  });

  it('rejects a duplicate position in the same voyage', async () => {
    const { a } = await twoVoyages();
    await insert(a.id, 1, a.exporter, a.trader);
    await expect(insert(a.id, 1, a.trader, a.buyer)).rejects.toThrow(
      /trade_contracts_voyage_id_position_key/,
    );
  });

  it('allows the same position in different voyages', async () => {
    const { a, b } = await twoVoyages();
    await insert(a.id, 1, a.exporter, a.buyer);
    await expect(insert(b.id, 1, b.exporter, b.buyer)).resolves.toBe(1);
  });

  it.each([0, -1])('rejects position %s', async (position) => {
    const { a } = await twoVoyages();
    await expect(insert(a.id, position, a.exporter, a.buyer)).rejects.toThrow(
      /trade_contracts_position_positive/,
    );
  });

  it('rejects a participant selling to itself', async () => {
    const { a } = await twoVoyages();
    await expect(insert(a.id, 1, a.trader, a.trader)).rejects.toThrow(
      /trade_contracts_distinct_counterparties/,
    );
  });

  it('rejects a participant selling twice (a branch)', async () => {
    const { a } = await twoVoyages();
    await insert(a.id, 1, a.exporter, a.trader);
    await expect(insert(a.id, 2, a.exporter, a.buyer)).rejects.toThrow(
      /trade_contracts_voyage_id_seller_participant_id_key/,
    );
  });

  it('rejects a participant buying twice', async () => {
    const { a } = await twoVoyages();
    await insert(a.id, 1, a.exporter, a.buyer);
    await expect(insert(a.id, 2, a.trader, a.buyer)).rejects.toThrow(
      /trade_contracts_voyage_id_buyer_participant_id_key/,
    );
  });

  it('refuses to remove a participant a contract names, but lets the voyage go as a whole', async () => {
    const { a } = await twoVoyages();
    await insert(a.id, 1, a.exporter, a.buyer);

    await expect(ctx.prisma.voyageParticipant.delete({ where: { id: a.buyer } })).rejects.toThrow();
    expect(await ctx.prisma.voyageParticipant.count({ where: { id: a.buyer } })).toBe(1);

    await ctx.prisma.voyage.delete({ where: { id: a.id } });
    expect(await ctx.prisma.tradeContract.count({ where: { voyageId: a.id } })).toBe(0);
  });
});
