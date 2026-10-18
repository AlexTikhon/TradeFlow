import { randomBytes } from 'node:crypto';
import {
  ContractDocumentSchema,
  CounterpartyContractListResponseSchema,
  type DocumentaryInstructionContent,
  DocumentaryInstructionSchema,
  PROBLEM_CONTENT_TYPE,
  type ProblemDetails,
  ProblemDetailsSchema,
  ProblemTypes,
  type TradeString,
  TradeStringSchema,
  VoyageDetailSchema,
  VoyageListResponseSchema,
  VoyageTimelinePageSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole, VoyageStatus } from '../src/generated/prisma/client.js';
import { TRADE_STRING_ALREADY_CONFIGURED } from '../src/modules/voyages/trade-string.service.js';
import { signIn } from './support/auth.js';
import {
  type Change,
  failAuditWrites,
  holdLock,
  waitForLockWaiters,
} from './support/concurrency.js';
import {
  createOrganization,
  createReferenceData,
  createTradeString,
  createUser,
  createVoyage,
  resetDatabase,
} from './support/database.js';
import { TestStorage } from './support/storage.js';
import { createTestApp, type TestApp } from './support/test-app.js';

const MISSING_ID = '01990000-0000-7000-8000-999999999999';

const instructions: DocumentaryInstructionContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  requirements: [{ document: 'BILL_OF_LADING', originals: 3, copies: 3 }],
};

const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(4096)]);

const NOT_EXPORTER = "Only the voyage's exporter may set up its trade string.";
const VIEWER_REFUSED = 'Your role does not allow you to set up trade strings.';
const OTHER_PARTICIPANTS =
  'This voyage already has participants other than its exporter, so its trade string cannot be set up here.';

describe('Setting up a trade string (POST /api/voyages/:voyageId/trade-string)', () => {
  let ctx: TestApp;
  let storage: TestStorage;
  let refs: Awaited<ReturnType<typeof createReferenceData>>;
  const api = () => request(ctx.server);

  beforeAll(async () => {
    storage = await TestStorage.create();
    ctx = await createTestApp({ storage });
  });

  afterAll(async () => {
    await ctx.app.close();
    await storage.dispose();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await storage.clear();
    refs = await createReferenceData(ctx.prisma);
  });

  /** An organization with a signed-in operator and a signed-in viewer. */
  async function anOrganization(name: string, countryCode = 'NL') {
    const organization = await createOrganization(ctx.prisma, name, countryCode);
    const member = async (role: UserRole) => {
      const user = await createUser(ctx.prisma, organization.id, { role });
      return { user, cookie: await signIn(ctx.server, user.email) };
    };
    return { organization, operator: await member('OPERATOR'), viewer: await member('VIEWER') };
  }
  type Party = Awaited<ReturnType<typeof anOrganization>>;

  /**
   * Cerrado creates a voyage through the API, so it is new and empty: Cerrado its only
   * participant, as exporter. Lacustra, Nordlys and Rhine Valley can be named in its chain;
   * Pampa participates in nothing.
   */
  async function scenario() {
    const cerrado = await anOrganization('Cerrado Grãos', 'BR');
    const lacustra = await anOrganization('Lacustra Commodities', 'CH');
    const nordlys = await anOrganization('Nordlys Trading', 'NO');
    const rhine = await anOrganization('Rhine Valley Crushers', 'DE');
    const pampa = await anOrganization('Pampa Litoral', 'AR');
    const created = await api()
      .post('/api/voyages')
      .set('Cookie', cerrado.operator.cookie)
      .send({
        vesselId: refs.vessel.id,
        commodityId: refs.commodity.id,
        quantity: { amount: '50000', unit: 'MT' },
        loadPortId: refs.loadPort.id,
        dischargePortId: refs.dischargePort.id,
        laycan: { start: '2026-11-01', end: '2026-11-10' },
      })
      .expect(201);
    const voyageId = VoyageDetailSchema.parse(created.body).id;
    return { cerrado, lacustra, nordlys, rhine, pampa, voyageId };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const path = (voyageId: string) => `/api/voyages/${voyageId}/trade-string`;
  const chainOf = (...parties: Party[]) =>
    parties.map(({ organization }) => ({ organizationId: organization.id }));

  /** A setup naming `parties` in order, with any extra headers. */
  const setUp = (
    cookie: string,
    voyageId: string,
    parties: unknown,
    headers: Record<string, string> = {},
  ) => api().post(path(voyageId)).set('Cookie', cookie).set(headers).send({ parties });

  const getTradeString = async (cookie: string, voyageId: string) =>
    TradeStringSchema.parse(
      (await api().get(path(voyageId)).set('Cookie', cookie).expect(200)).body,
    );

  const problemOf = (response: request.Response | undefined) => {
    if (!response) throw new Error('Expected a response');
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    return ProblemDetailsSchema.parse(response.body);
  };
  /** A problem without its `instance`, which names the request's own URL. */
  const withoutInstance = ({ instance: _instance, ...rest }: ProblemDetails) => rest;

  /** Every row a setup writes, anywhere. Refusals must leave all of them as they were. */
  const writes = async () => ({
    participants: await ctx.prisma.voyageParticipant.count(),
    contracts: await ctx.prisma.tradeContract.count(),
    events: (
      await ctx.prisma.auditEvent.findMany({ select: { action: true }, orderBy: { id: 'asc' } })
    ).map(({ action }) => action),
  });
  /** A new voyage and nothing else: its exporter, no contracts, its creation event. */
  const NOTHING_SET_UP = { participants: 1, contracts: 0, events: ['VOYAGE_CREATED'] };

  /** Everything stored about one voyage, to show that a refusal changed none of it. */
  const snapshot = async (voyageId: string) => ({
    voyage: await ctx.prisma.voyage.findUniqueOrThrow({ where: { id: voyageId } }),
    participants: await ctx.prisma.voyageParticipant.findMany({
      where: { voyageId },
      orderBy: { id: 'asc' },
    }),
    contracts: await ctx.prisma.tradeContract.findMany({
      where: { voyageId },
      orderBy: { position: 'asc' },
    }),
    events: await ctx.prisma.auditEvent.findMany({ where: { voyageId }, orderBy: { id: 'asc' } }),
  });

  /** The chain as stored: [organization, role] per participant, and each contract's two ends. */
  const stored = async (voyageId: string) => ({
    participants: (
      await ctx.prisma.voyageParticipant.findMany({
        where: { voyageId },
        select: { organizationId: true, role: true },
      })
    )
      .map(({ organizationId, role }) => `${organizationId}:${role}`)
      .sort(),
    contracts: (
      await ctx.prisma.tradeContract.findMany({
        where: { voyageId },
        select: {
          position: true,
          seller: { select: { organizationId: true } },
          buyer: { select: { organizationId: true } },
        },
        orderBy: { position: 'asc' },
      })
    ).map(({ position, seller, buyer }) => [position, seller.organizationId, buyer.organizationId]),
  });

  /** What `stored` holds after setting up `parties` (exporter first). */
  const expectedChain = (...parties: Party[]) => ({
    participants: parties
      .map(
        ({ organization }, index) =>
          `${organization.id}:${
            index === 0 ? 'EXPORTER' : index === parties.length - 1 ? 'FINAL_BUYER' : 'TRADER'
          }`,
      )
      .sort(),
    contracts: parties
      .slice(1)
      .map((buyer, index) => [index + 1, parties[index]?.organization.id, buyer.organization.id]),
  });

  describe('setting up a new voyage', () => {
    it('answers GET with empty lists before, and with the recorded chain after', async () => {
      const s = await scenario();
      expect(await getTradeString(s.cerrado.operator.cookie, s.voyageId)).toEqual({
        parties: [],
        edges: [],
      });

      const response = await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.lacustra, s.rhine),
      ).expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
      expect(response.headers.etag).toBeUndefined();
      expect(response.headers.location).toBeUndefined();
      const body = TradeStringSchema.parse(response.body);
      expect(body).toEqual({
        parties: [
          { organization: refOf(s.cerrado), role: 'EXPORTER' },
          { organization: refOf(s.lacustra), role: 'TRADER' },
          { organization: refOf(s.rhine), role: 'FINAL_BUYER' },
        ],
        edges: [edge(1, s.cerrado, s.lacustra), edge(2, s.lacustra, s.rhine)],
      } satisfies TradeString);
      expect(await getTradeString(s.cerrado.operator.cookie, s.voyageId)).toEqual(body);
      expect(await stored(s.voyageId)).toEqual(expectedChain(s.cerrado, s.lacustra, s.rhine));
      expect(await writes()).toEqual({
        participants: 3,
        contracts: 2,
        events: ['VOYAGE_CREATED', 'VOYAGE_TRADE_STRING_CONFIGURED'],
      });
    });

    it('records one audit event with the parties and contracts as committed', async () => {
      const s = await scenario();
      await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.lacustra, s.nordlys, s.rhine),
      ).expect(200);

      const event = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'VOYAGE_TRADE_STRING_CONFIGURED' },
      });
      const participants = await ctx.prisma.voyageParticipant.findMany({
        where: { voyageId: s.voyageId },
      });
      const contracts = await ctx.prisma.tradeContract.findMany({
        where: { voyageId: s.voyageId },
        orderBy: { position: 'asc' },
      });
      const participantOf = (party: Party) =>
        participants.find(({ organizationId }) => organizationId === party.organization.id)?.id;
      expect(event).toMatchObject({
        voyageId: s.voyageId,
        actorUserId: s.cerrado.operator.user.id,
        actorOrganizationId: s.cerrado.organization.id,
      });
      expect(event.payload).toEqual({
        parties: [
          [s.cerrado, 'EXPORTER'],
          [s.lacustra, 'TRADER'],
          [s.nordlys, 'TRADER'],
          [s.rhine, 'FINAL_BUYER'],
        ].map(([party, role]) => ({
          organizationId: (party as Party).organization.id,
          role,
          participantId: participantOf(party as Party),
        })),
        contracts: contracts.map(({ id, position }) => ({
          contractId: id,
          position,
          sellerOrganizationId: [s.cerrado, s.lacustra, s.nordlys][position - 1]?.organization.id,
          buyerOrganizationId: [s.lacustra, s.nordlys, s.rhine][position - 1]?.organization.id,
        })),
      });
    });

    it('gives the named organizations the voyage and the existing bilateral workflows', async () => {
      const s = await scenario();
      await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.lacustra, s.rhine),
      ).expect(200);

      // Lacustra now has the voyage, its whole string, and its two contracts.
      const list = await api()
        .get('/api/voyages')
        .set('Cookie', s.lacustra.viewer.cookie)
        .expect(200);
      expect(VoyageListResponseSchema.parse(list.body).items.map(({ id }) => id)).toEqual([
        s.voyageId,
      ]);
      expect((await getTradeString(s.lacustra.viewer.cookie, s.voyageId)).parties).toHaveLength(3);
      const mine = CounterpartyContractListResponseSchema.parse(
        (
          await api()
            .get(`/api/voyages/${s.voyageId}/my-contracts`)
            .set('Cookie', s.lacustra.operator.cookie)
            .expect(200)
        ).body,
      ).items;
      expect(mine.map(({ position, side }) => [position, side])).toEqual([
        [1, 'BUYER'],
        [2, 'SELLER'],
      ]);
      const contract1 = mine[0]?.id ?? '';

      // Lacustra gives instructions, Cerrado acknowledges them and uploads, Lacustra approves.
      const instructionPath = `/api/voyages/${s.voyageId}/contracts/${contract1}/documentary-instructions`;
      const given = await api()
        .put(instructionPath)
        .set('Cookie', s.lacustra.operator.cookie)
        .set('If-None-Match', '*')
        .send(instructions)
        .expect(201);
      expect(DocumentaryInstructionSchema.parse(given.body).version).toBe(1);
      await api()
        .post(`${instructionPath}/revisions/1/acknowledgement`)
        .set('Cookie', s.cerrado.operator.cookie)
        .set('If-Match', '"1"')
        .send({})
        .expect(200);
      const versions = `${instructionPath}/revisions/1/documents/BILL_OF_LADING/versions`;
      const uploaded = await api()
        .post(versions)
        .set('Cookie', s.cerrado.operator.cookie)
        .set('If-None-Match', '*')
        .attach('file', pdf(), { filename: 'bill-of-lading.pdf', contentType: 'application/pdf' })
        .expect(201);
      expect(ContractDocumentSchema.parse(uploaded.body).version).toBe(1);
      const reviewed = await api()
        .post(`${versions}/1/review`)
        .set('Cookie', s.lacustra.operator.cookie)
        .set('If-Match', '"1"')
        .send({ decision: 'APPROVED' })
        .expect(200);
      expect(ContractDocumentSchema.parse(reviewed.body).currentVersion.review?.decision).toBe(
        'APPROVED',
      );

      // Rhine Valley sees the voyage and contract 2 only: none of contract 1's facts.
      const rhineContracts = CounterpartyContractListResponseSchema.parse(
        (
          await api()
            .get(`/api/voyages/${s.voyageId}/my-contracts`)
            .set('Cookie', s.rhine.viewer.cookie)
            .expect(200)
        ).body,
      ).items;
      expect(rhineContracts.map(({ position, side }) => [position, side])).toEqual([[2, 'BUYER']]);
      const rhineInstructions = await api()
        .get(`/api/voyages/${s.voyageId}/documentary-instructions`)
        .set('Cookie', s.rhine.viewer.cookie)
        .expect(200);
      expect(rhineInstructions.body).toEqual({ items: [] });
      const rhineDocuments = await api()
        .get(`/api/voyages/${s.voyageId}/documents`)
        .set('Cookie', s.rhine.viewer.cookie)
        .expect(200);
      expect(rhineDocuments.body).toEqual({ items: [] });
      await api().get(instructionPath).set('Cookie', s.rhine.viewer.cookie).expect(404);
    });

    it('lets any operator of the exporter set it up, not only the voyage’s creator', async () => {
      const s = await scenario();
      const colleague = await createUser(ctx.prisma, s.cerrado.organization.id, {
        role: 'OPERATOR',
      });
      const cookie = await signIn(ctx.server, colleague.email);

      await setUp(cookie, s.voyageId, chainOf(s.cerrado, s.rhine)).expect(200);

      expect(await stored(s.voyageId)).toEqual(expectedChain(s.cerrado, s.rhine));
    });
  });

  describe('who may set it up', () => {
    it('answers 401 without a session, before reading the body', async () => {
      const s = await scenario();
      for (const parties of [chainOf(s.cerrado, s.rhine), 'nonsense']) {
        const response = await api().post(path(s.voyageId)).send({ parties }).expect(401);
        expect(problemOf(response).status).toBe(401);
      }
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });

    it('refuses a cross-site request from an operator of the exporter', async () => {
      const s = await scenario();
      await setUp(s.cerrado.operator.cookie, s.voyageId, chainOf(s.cerrado, s.rhine), {
        'Sec-Fetch-Site': 'cross-site',
      }).expect(403);
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });

    it('answers 403 to a viewer of the exporter, before the voyage is read', async () => {
      const s = await scenario();
      for (const voyageId of [s.voyageId, MISSING_ID]) {
        const response = await setUp(
          s.cerrado.viewer.cookie,
          voyageId,
          chainOf(s.cerrado, s.rhine),
        ).expect(403);
        expect(problemOf(response)).toMatchObject({
          type: ProblemTypes.Generic,
          status: 403,
          detail: VIEWER_REFUSED,
        });
      }
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });

    it('answers an outsider exactly as for a voyage that does not exist', async () => {
      const s = await scenario();
      const outsider = await setUp(
        s.pampa.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.pampa),
      ).expect(404);
      const missing = await setUp(
        s.pampa.operator.cookie,
        MISSING_ID,
        chainOf(s.cerrado, s.pampa),
      ).expect(404);

      expect(withoutInstance(problemOf(outsider))).toEqual(withoutInstance(problemOf(missing)));
      expect(problemOf(outsider).detail).toBe('Voyage was not found.');
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });

    it('answers 403 to a participant that is not the exporter, before any state check', async () => {
      const s = await scenario();
      await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.lacustra, s.rhine),
      ).expect(200);
      const before = await snapshot(s.voyageId);

      // Configured, so the state checks would answer 409: authorization comes first.
      const response = await setUp(
        s.lacustra.operator.cookie,
        s.voyageId,
        chainOf(s.lacustra, s.rhine),
      ).expect(403);

      expect(problemOf(response).detail).toBe(NOT_EXPORTER);
      expect(await snapshot(s.voyageId)).toEqual(before);
    });

    it('answers 403 to a service provider of a voyage that cannot be set up', async () => {
      const exporter = await anOrganization('Exporter SA', 'BR');
      const surveyor = await anOrganization('Atlas Surveyors');
      const voyage = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-SURVEYED',
        participants: [
          { organizationId: exporter.organization.id, role: 'EXPORTER' },
          { organizationId: surveyor.organization.id, role: 'SURVEYOR' },
        ],
      });

      const response = await setUp(
        surveyor.operator.cookie,
        voyage.id,
        chainOf(surveyor, exporter),
      ).expect(403);

      expect(problemOf(response).detail).toBe(NOT_EXPORTER);
    });

    it('refuses a malformed voyage id with 400', async () => {
      const s = await scenario();
      const response = await setUp(
        s.cerrado.operator.cookie,
        'not-a-uuid',
        chainOf(s.cerrado, s.rhine),
      ).expect(400);
      expect(problemOf(response).errors?.map(({ path: at }) => at)).toEqual(['param.voyageId']);
    });
  });

  describe('which voyages can be set up', () => {
    it('answers 409 to a second setup, with the same chain or another, and changes nothing', async () => {
      const s = await scenario();
      await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.lacustra, s.rhine),
      ).expect(200);
      const before = await snapshot(s.voyageId);

      for (const chain of [
        chainOf(s.cerrado, s.lacustra, s.rhine),
        chainOf(s.cerrado, s.nordlys),
      ]) {
        const response = await setUp(s.cerrado.operator.cookie, s.voyageId, chain).expect(409);
        expect(problemOf(response)).toMatchObject({
          type: ProblemTypes.Generic,
          status: 409,
          detail: TRADE_STRING_ALREADY_CONFIGURED,
        });
      }
      expect(await snapshot(s.voyageId)).toEqual(before);
    });

    it('answers "already set up" for a seeded chain, whatever else would refuse it', async () => {
      // Like TF-2026-0001: contracts, service providers, and in transit.
      const cerrado = await anOrganization('Cerrado Grãos', 'BR');
      const lacustra = await anOrganization('Lacustra Commodities', 'CH');
      const rhine = await anOrganization('Rhine Valley Crushers', 'DE');
      const surveyor = await anOrganization('Atlas Surveyors');
      const voyage = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-2026-0001',
        status: 'IN_TRANSIT',
        participants: [
          { organizationId: cerrado.organization.id, role: 'EXPORTER' },
          { organizationId: lacustra.organization.id, role: 'TRADER' },
          { organizationId: rhine.organization.id, role: 'FINAL_BUYER' },
          { organizationId: surveyor.organization.id, role: 'SURVEYOR' },
        ],
      });
      await createTradeString(ctx.prisma, voyage.id, [
        cerrado.organization.id,
        lacustra.organization.id,
        rhine.organization.id,
      ]);
      const before = await snapshot(voyage.id);
      const tradeString = await getTradeString(cerrado.viewer.cookie, voyage.id);

      const response = await setUp(cerrado.operator.cookie, voyage.id, chainOf(cerrado, rhine), {
        'If-None-Match': '*',
      }).expect(409);

      // The precondition is not evaluated: the voyage is refused for its state first.
      expect(problemOf(response).detail).toBe(TRADE_STRING_ALREADY_CONFIGURED);
      expect(await snapshot(voyage.id)).toEqual(before);
      expect(await getTradeString(cerrado.viewer.cookie, voyage.id)).toEqual(tradeString);
    });

    it('answers 409 for a planned voyage that already has other participants', async () => {
      // Like TF-2026-0003: parties have joined, but no contracts are recorded.
      const exporter = await anOrganization('Exporter SA', 'BR');
      const trader = await anOrganization('Trader AG', 'CH');
      const buyer = await anOrganization('Buyer GmbH', 'DE');
      const voyage = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-2026-0003',
        participants: [
          { organizationId: exporter.organization.id, role: 'EXPORTER' },
          { organizationId: trader.organization.id, role: 'TRADER' },
          { organizationId: buyer.organization.id, role: 'FINAL_BUYER' },
        ],
      });
      const before = await snapshot(voyage.id);

      const response = await setUp(
        exporter.operator.cookie,
        voyage.id,
        chainOf(exporter, trader, buyer),
      ).expect(409);

      expect(problemOf(response).detail).toBe(OTHER_PARTICIPANTS);
      expect(await snapshot(voyage.id)).toEqual(before);
      expect(await getTradeString(exporter.viewer.cookie, voyage.id)).toEqual({
        parties: [],
        edges: [],
      });
    });

    it.each<VoyageStatus>(['LOADING', 'IN_TRANSIT', 'COMPLETED', 'CANCELLED'])(
      'answers 409 for an empty voyage that is %s',
      async (status) => {
        const s = await scenario();
        await ctx.prisma.voyage.update({ where: { id: s.voyageId }, data: { status } });

        const response = await setUp(
          s.cerrado.operator.cookie,
          s.voyageId,
          chainOf(s.cerrado, s.rhine),
        ).expect(409);

        expect(problemOf(response).detail).toBe(
          `Only a PLANNED voyage can have its trade string set up; this one is ${status}.`,
        );
        expect(await writes()).toEqual(NOTHING_SET_UP);
      },
    );
  });

  describe('invalid requests write nothing', () => {
    it.each<[string, unknown, string[]]>([
      ['one party', 'one', ['body.parties']],
      ['eleven parties', 'eleven', ['body.parties']],
      ['an organization named twice', 'twice', ['body.parties.2.organizationId']],
      ['an id that is not a UUID', 'not-uuid', ['body.parties.1.organizationId']],
      ['a role sent along', 'with-role', ['body.parties.1']],
      ['no parties at all', 'none', ['body.parties']],
    ])('refuses %s with 400', async (_case, kind, paths) => {
      const s = await scenario();
      const many = await Promise.all(
        Array.from({ length: 10 }, (_, index) => createOrganization(ctx.prisma, `Trader ${index}`)),
      );
      const ids = (...organizations: { id: string }[]) =>
        organizations.map(({ id }) => ({ organizationId: id }));
      const bodies: Record<string, unknown> = {
        one: ids(s.cerrado.organization),
        eleven: ids(s.cerrado.organization, ...many),
        twice: ids(s.cerrado.organization, s.lacustra.organization, s.cerrado.organization),
        'not-uuid': [...ids(s.cerrado.organization), { organizationId: 'rhine' }],
        'with-role': [
          ...ids(s.cerrado.organization),
          { organizationId: s.rhine.organization.id, role: 'FINAL_BUYER' },
        ],
        none: undefined,
      };

      const response = await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        bodies[kind as string],
      ).expect(400);

      const problem = problemOf(response);
      expect(problem.type).toBe(ProblemTypes.ValidationFailed);
      expect(problem.errors?.map(({ path: at }) => at)).toEqual(paths);
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });

    it('refuses a body with fields beyond the parties', async () => {
      const s = await scenario();
      const response = await api()
        .post(path(s.voyageId))
        .set('Cookie', s.cerrado.operator.cookie)
        .send({ parties: chainOf(s.cerrado, s.rhine), status: 'LOADING' })
        .expect(400);
      expect(problemOf(response).errors?.map(({ path: at }) => at)).toEqual(['body']);
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });

    it('reports a chain not starting with the exporter and unknown organizations at once', async () => {
      const s = await scenario();
      const response = await setUp(s.cerrado.operator.cookie, s.voyageId, [
        { organizationId: s.lacustra.organization.id },
        { organizationId: MISSING_ID },
        { organizationId: s.cerrado.organization.id },
      ]).expect(400);

      expect(problemOf(response).errors).toEqual([
        {
          path: 'body.parties.0.organizationId',
          message: "The trade string must start with the voyage's exporter",
        },
        { path: 'body.parties.1.organizationId', message: 'No organization has this id' },
      ]);
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });

    it('rolls back the participants when a later write fails', async () => {
      const s = await scenario();
      await failInsertsInto('trade_contracts', async () => {
        await setUp(
          s.cerrado.operator.cookie,
          s.voyageId,
          chainOf(s.cerrado, s.lacustra, s.rhine),
        ).expect(500);
      });

      expect(await writes()).toEqual(NOTHING_SET_UP);
      await setUp(s.cerrado.operator.cookie, s.voyageId, chainOf(s.cerrado, s.rhine)).expect(200);
    });

    it('rolls back everything when the audit event cannot be recorded', async () => {
      const s = await scenario();
      await failAuditWrites(ctx.prisma, async () => {
        await setUp(
          s.cerrado.operator.cookie,
          s.voyageId,
          chainOf(s.cerrado, s.lacustra, s.rhine),
        ).expect(500);
      });

      expect(await writes()).toEqual(NOTHING_SET_UP);
      expect(await getTradeString(s.cerrado.operator.cookie, s.voyageId)).toEqual({
        parties: [],
        edges: [],
      });
      await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.lacustra, s.rhine),
      ).expect(200);
      expect(await stored(s.voyageId)).toEqual(expectedChain(s.cerrado, s.lacustra, s.rhine));
    });
  });

  describe('conditional headers', () => {
    it.each<[string, Record<string, string>]>([
      ['none', {}],
      ['If-Match: *', { 'If-Match': '*' }],
      ['If-None-Match with an entity tag', { 'If-None-Match': '"1"' }],
      ['If-None-Match with a comma inside its tag', { 'If-None-Match': '"a,b"' }],
      [
        'If-None-Match with a mixed list, commas quoted',
        { 'If-None-Match': 'W/"x,y" , "", "*",, "a,b,c"' },
      ],
      ['If-None-Match with an empty list', { 'If-None-Match': ' , ' }],
      [
        'If-Unmodified-Since, which has no date to compare',
        { 'If-Unmodified-Since': 'Sat, 01 Jan 2000 00:00:00 GMT' },
      ],
    ])('sets up the voyage with %s', async (_case, headers) => {
      const s = await scenario();
      await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.rhine),
        headers,
      ).expect(200);
      expect(await stored(s.voyageId)).toEqual(expectedChain(s.cerrado, s.rhine));
    });

    it.each<[string, Record<string, string>, RegExp]>([
      ['If-Match with an entity tag', { 'If-Match': '"1"' }, /^If-Match names an entity tag/],
      ['If-Match with a weak tag', { 'If-Match': 'W/"1"' }, /^If-Match names an entity tag/],
      ['If-Match with a comma inside its tag', { 'If-Match': '"a,b"' }, /^If-Match names/],
      [
        'If-Match with a mixed list, commas quoted',
        { 'If-Match': '"a,b", W/"c,d" ,"*"' },
        /^If-Match names/,
      ],
      ['If-Match: "*", a quoted tag rather than *', { 'If-Match': '"*"' }, /^If-Match names/],
      ['If-Match with an empty list', { 'If-Match': ' , ' }, /^If-Match names/],
      ['If-None-Match: *', { 'If-None-Match': '*' }, /^If-None-Match: \* cannot hold/],
      [
        'If-Match: * and If-None-Match: *',
        { 'If-Match': '*', 'If-None-Match': '*' },
        /^If-None-Match: \* cannot hold/,
      ],
    ])('answers 412 to %s and writes nothing', async (_case, headers, detail) => {
      const s = await scenario();
      const response = await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.rhine),
        headers,
      ).expect(412);

      expect(problemOf(response).detail).toMatch(detail);
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });

    it('evaluates a precondition before the chain itself', async () => {
      const s = await scenario();
      const response = await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.lacustra, s.rhine),
        { 'If-Match': '"1"' },
      ).expect(412);
      expect(problemOf(response).status).toBe(412);
    });

    it.each<[string, string]>([
      ['if-match', '1'],
      ['if-none-match', '"1'],
      ['if-none-match', '*, "1"'],
      ['if-match', '"a,b'],
      ['if-match', '"a b"'],
      ['if-none-match', '"a\tb"'],
      ['if-none-match', 'w/"x"'],
      ['if-match', '"a" "b"'],
      ['if-none-match', '"a,b", *'],
    ])('refuses a malformed %s header (%j) with 400', async (header, value) => {
      const s = await scenario();
      const response = await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.rhine),
        { [header]: value },
      ).expect(400);
      expect(problemOf(response).errors?.map(({ path: at }) => at)).toEqual([`header.${header}`]);
      expect(await writes()).toEqual(NOTHING_SET_UP);
    });
  });

  describe('competing setups', () => {
    /** Starts every setup against a held lock on the voyage, then lets them go together. */
    async function race(s: Scenario, chains: Party[][]) {
      const second = await createUser(ctx.prisma, s.cerrado.organization.id, { role: 'OPERATOR' });
      const cookies = [s.cerrado.operator.cookie, await signIn(ctx.server, second.email)];
      const lock = await holdLock(
        ctx.prisma,
        (tx) => tx.$queryRaw`SELECT id FROM voyages WHERE id = ${s.voyageId}::uuid FOR UPDATE`,
      );
      const answers = chains.map((chain, index) =>
        setUp(cookies[index] ?? '', s.voyageId, chainOf(...chain)).then((response) => response),
      );
      await waitForLockWaiters(ctx.prisma, chains.length);
      await lock.release();
      return Promise.all(answers);
    }

    it('lets exactly one of two identical setups through; the other gets 409', async () => {
      const s = await scenario();
      const chain = [s.cerrado, s.lacustra, s.rhine];

      const answers = await race(s, [chain, chain]);

      expect(answers.map(({ status }) => status).sort()).toEqual([200, 409]);
      const loser = answers.find(({ status }) => status === 409);
      expect(problemOf(loser).detail).toBe(TRADE_STRING_ALREADY_CONFIGURED);
      expect(await stored(s.voyageId)).toEqual(expectedChain(...chain));
      expect(await writes()).toEqual({
        participants: 3,
        contracts: 2,
        events: ['VOYAGE_CREATED', 'VOYAGE_TRADE_STRING_CONFIGURED'],
      });
    });

    it('keeps exactly the winner’s chain when two different setups race', async () => {
      const s = await scenario();
      const chains = [
        [s.cerrado, s.lacustra, s.rhine],
        [s.cerrado, s.nordlys],
      ];

      const answers = await race(s, chains);

      expect(answers.map(({ status }) => status).sort()).toEqual([200, 409]);
      const winnerIndex = answers.findIndex(({ status }) => status === 200);
      const winner = chains[winnerIndex] ?? [];
      const loser = answers[1 - winnerIndex];
      // Refused as already set up, never for the participants the winner added.
      expect(problemOf(loser).detail).toBe(TRADE_STRING_ALREADY_CONFIGURED);
      expect(answers[winnerIndex]?.body).toEqual(
        await getTradeString(s.cerrado.viewer.cookie, s.voyageId),
      );
      expect(await stored(s.voyageId)).toEqual(expectedChain(...winner));
      const events = await ctx.prisma.auditEvent.findMany({
        where: { action: 'VOYAGE_TRADE_STRING_CONFIGURED' },
      });
      expect(events).toHaveLength(1);
      expect(
        (events[0]?.payload as { parties: { organizationId: string }[] }).parties.map(
          ({ organizationId }) => organizationId,
        ),
      ).toEqual(winner.map(({ organization }) => organization.id));
    });
  });

  describe('the session, as it is once the lock is held', () => {
    /** One setup by Cerrado's operator, waiting on the voyage; `change` commits as it goes on. */
    async function setUpWhileWaiting(s: Scenario, change: Change) {
      const lock = await holdLock(
        ctx.prisma,
        (tx) => tx.$queryRaw`SELECT id FROM voyages WHERE id = ${s.voyageId}::uuid FOR UPDATE`,
      );
      const answer = setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.lacustra, s.rhine),
      ).then((response) => response);
      await waitForLockWaiters(ctx.prisma, 1);
      await lock.release(change);
      return answer;
    }

    /** Nothing was written, and another operator of the exporter can still set it up. */
    async function expectUntouched(s: Scenario) {
      expect(await writes()).toEqual(NOTHING_SET_UP);
      const colleague = await createUser(ctx.prisma, s.cerrado.organization.id, {
        role: 'OPERATOR',
      });
      await setUp(
        await signIn(ctx.server, colleague.email),
        s.voyageId,
        chainOf(s.cerrado, s.rhine),
      ).expect(200);
    }

    it('answers 401 when the session was revoked while the setup waited', async () => {
      const s = await scenario();
      const answer = await setUpWhileWaiting(s, (tx) =>
        tx.session.updateMany({
          where: { userId: s.cerrado.operator.user.id },
          data: { revokedAt: new Date() },
        }),
      );

      expect(answer.status).toBe(401);
      expect(problemOf(answer).detail).toBe(
        'Your session ended before the trade string was set up. Sign in and try again.',
      );
      await expectUntouched(s);
    });

    it('answers 403 when the user was made a viewer while the setup waited', async () => {
      const s = await scenario();
      const answer = await setUpWhileWaiting(s, (tx) =>
        tx.user.update({ where: { id: s.cerrado.operator.user.id }, data: { role: 'VIEWER' } }),
      );

      expect(answer.status).toBe(403);
      expect(problemOf(answer).detail).toBe(VIEWER_REFUSED);
      await expectUntouched(s);
    });

    it('answers 404 when the user moved to an organization outside the voyage meanwhile', async () => {
      const s = await scenario();
      const answer = await setUpWhileWaiting(s, (tx) =>
        tx.user.update({
          where: { id: s.cerrado.operator.user.id },
          data: { organizationId: s.pampa.organization.id },
        }),
      );

      expect(answer.status).toBe(404);
      expect(problemOf(answer).detail).toBe('Voyage was not found.');
      await expectUntouched(s);
    });

    it('answers 403 when the user moved to a participant that is not the exporter', async () => {
      const exporter = await anOrganization('Exporter SA', 'BR');
      const surveyor = await anOrganization('Atlas Surveyors');
      const voyage = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-MOVED',
        participants: [{ organizationId: exporter.organization.id, role: 'EXPORTER' }],
      });
      const lock = await holdLock(
        ctx.prisma,
        (tx) => tx.$queryRaw`SELECT id FROM voyages WHERE id = ${voyage.id}::uuid FOR UPDATE`,
      );
      const answer = setUp(exporter.operator.cookie, voyage.id, chainOf(exporter, surveyor)).then(
        (response) => response,
      );
      await waitForLockWaiters(ctx.prisma, 1);
      await lock.release(async (tx) => {
        await tx.voyageParticipant.create({
          data: { voyageId: voyage.id, organizationId: surveyor.organization.id, role: 'SURVEYOR' },
        });
        await tx.user.update({
          where: { id: exporter.operator.user.id },
          data: { organizationId: surveyor.organization.id },
        });
      });

      expect((await answer).status).toBe(403);
      expect(problemOf(await answer).detail).toBe(NOT_EXPORTER);
      expect(await ctx.prisma.tradeContract.count()).toBe(0);
    });
  });

  describe('the timeline', () => {
    const timelineOf = async (cookie: string, voyageId: string) =>
      VoyageTimelinePageSchema.parse(
        (await api().get(`/api/voyages/${voyageId}/timeline`).set('Cookie', cookie).expect(200))
          .body,
      ).items;

    it('shows every participant the setup, without its parties, and keeps contract events to their counterparties', async () => {
      const s = await scenario();
      await setUp(
        s.cerrado.operator.cookie,
        s.voyageId,
        chainOf(s.cerrado, s.lacustra, s.rhine),
      ).expect(200);
      const contract1 = (
        await ctx.prisma.tradeContract.findFirstOrThrow({
          where: { voyageId: s.voyageId, position: 1 },
        })
      ).id;
      await api()
        .put(`/api/voyages/${s.voyageId}/contracts/${contract1}/documentary-instructions`)
        .set('Cookie', s.lacustra.operator.cookie)
        .set('If-None-Match', '*')
        .send(instructions)
        .expect(201);

      const setupEvent = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'VOYAGE_TRADE_STRING_CONFIGURED' },
      });
      const expected = {
        id: setupEvent.id,
        occurredAt: setupEvent.occurredAt.toISOString(),
        actor: {
          name: s.cerrado.operator.user.fullName,
          organization: refOf(s.cerrado),
        },
        action: 'VOYAGE_TRADE_STRING_CONFIGURED',
      };

      const actions = async (party: Party) =>
        (await timelineOf(party.viewer.cookie, s.voyageId)).map(({ action }) => action);
      expect(await actions(s.cerrado)).toEqual([
        'DOCUMENTARY_INSTRUCTION_REVISED',
        'VOYAGE_TRADE_STRING_CONFIGURED',
        'VOYAGE_CREATED',
      ]);
      expect(await actions(s.lacustra)).toEqual([
        'DOCUMENTARY_INSTRUCTION_REVISED',
        'VOYAGE_TRADE_STRING_CONFIGURED',
        'VOYAGE_CREATED',
      ]);
      // Rhine Valley is not a party to contract 1: the voyage's own events only.
      expect(await actions(s.rhine)).toEqual(['VOYAGE_TRADE_STRING_CONFIGURED', 'VOYAGE_CREATED']);

      for (const party of [s.cerrado, s.lacustra, s.rhine]) {
        const response = await api()
          .get(`/api/voyages/${s.voyageId}/timeline`)
          .set('Cookie', party.viewer.cookie)
          .expect(200);
        const raw = (response.body as { items: Record<string, unknown>[] }).items.find(
          ({ action }) => action === 'VOYAGE_TRADE_STRING_CONFIGURED',
        );
        // Exactly the event's base: nothing from the payload.
        expect(raw).toEqual(expected);
      }
      await api()
        .get(`/api/voyages/${s.voyageId}/timeline`)
        .set('Cookie', s.pampa.viewer.cookie)
        .expect(404);
    });
  });

  /** Runs `act` while every insert into `table` fails. */
  async function failInsertsInto(table: string, act: () => Promise<void>) {
    await ctx.prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_insert_fails() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'insert refused'; END $$`);
    await ctx.prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_insert_fails BEFORE INSERT ON ${table}
      FOR EACH ROW EXECUTE FUNCTION test_insert_fails()`);
    try {
      await act();
    } finally {
      await ctx.prisma.$executeRawUnsafe(`DROP TRIGGER test_insert_fails ON ${table}`);
      await ctx.prisma.$executeRawUnsafe('DROP FUNCTION test_insert_fails()');
    }
  }
});

const refOf = ({
  organization,
}: {
  organization: { id: string; name: string; countryCode: string };
}) => ({
  id: organization.id,
  name: organization.name,
  countryCode: organization.countryCode,
});

const edge = (
  position: number,
  seller: { organization: { id: string } },
  buyer: { organization: { id: string } },
) => ({
  position,
  sellerOrganizationId: seller.organization.id,
  buyerOrganizationId: buyer.organization.id,
});
