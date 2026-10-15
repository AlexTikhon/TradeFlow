import {
  CounterpartyContractListResponseSchema,
  type IssueNoticeRequest,
  NoticeListResponseSchema,
  NoticeSchema,
  PROBLEM_CONTENT_TYPE,
  ProblemDetailsSchema,
  ProblemTypes,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '../src/generated/prisma/client.js';
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

const HOUR = 3_600_000;
const fromNow = (hours: number) => new Date(Date.now() + hours * HOUR);
const MISSING_ID = '01990000-0000-7000-8009-999999999999';

describe('Notices', () => {
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

  /** An organization with a signed-in operator and a signed-in viewer. */
  async function anOrganization(name: string, countryCode = 'NL') {
    const organization = await createOrganization(ctx.prisma, name, countryCode);
    const user = async (role: UserRole) => {
      const row = await createUser(ctx.prisma, organization.id, { role });
      return { user: row, cookie: await signIn(ctx.server, row.email) };
    };
    return { organization, operator: await user('OPERATOR'), viewer: await user('VIEWER') };
  }

  /**
   * TF-N: Exporter → Trader → Buyer, with a surveyor and a shipping agent. Contract 1 is the
   * exporter's sale to the trader, contract 2 the trader's sale to the buyer. TF-OTHER: the
   * exporter sells straight to the buyer. Outsider participates in nothing.
   */
  async function scenario() {
    const refs = await createReferenceData(ctx.prisma);
    const exporter = await anOrganization('Exporter Co', 'BR');
    const trader = await anOrganization('Trader SA', 'CH');
    const buyer = await anOrganization('Buyer GmbH', 'DE');
    const surveyor = await anOrganization('Survey BV');
    const agent = await anOrganization('Agency Ltda', 'BR');
    const outsider = await anOrganization('Outsider BV');
    const voyage = await createVoyage(ctx.prisma, refs, {
      reference: 'TF-N',
      participants: [
        { organizationId: exporter.organization.id, role: 'EXPORTER' },
        { organizationId: trader.organization.id, role: 'TRADER' },
        { organizationId: buyer.organization.id, role: 'FINAL_BUYER' },
        { organizationId: surveyor.organization.id, role: 'SURVEYOR' },
        { organizationId: agent.organization.id, role: 'SHIPPING_AGENT' },
      ],
    });
    await createTradeString(ctx.prisma, voyage.id, [
      exporter.organization.id,
      trader.organization.id,
      buyer.organization.id,
    ]);
    const other = await createVoyage(ctx.prisma, refs, {
      reference: 'TF-OTHER',
      participants: [
        { organizationId: exporter.organization.id, role: 'EXPORTER' },
        { organizationId: buyer.organization.id, role: 'FINAL_BUYER' },
      ],
    });
    await createTradeString(ctx.prisma, other.id, [
      exporter.organization.id,
      buyer.organization.id,
    ]);
    const contractAt = async (voyageId: string, position: number) =>
      (
        await ctx.prisma.tradeContract.findUniqueOrThrow({
          where: { voyageId_position: { voyageId, position } },
        })
      ).id;
    return {
      voyage,
      other,
      exporter,
      trader,
      buyer,
      surveyor,
      agent,
      outsider,
      /** Exporter → Trader on TF-N. */
      c1: await contractAt(voyage.id, 1),
      /** Trader → Buyer on TF-N. */
      c2: await contractAt(voyage.id, 2),
      /** Exporter → Buyer on TF-OTHER. */
      d1: await contractAt(other.id, 1),
    };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const noticesPath = (voyageId: string) => `/api/voyages/${voyageId}/notices`;
  const noticePath = (voyageId: string, noticeId: string) => `${noticesPath(voyageId)}/${noticeId}`;
  const acknowledgementPath = (voyageId: string, noticeId: string) =>
    `${noticePath(voyageId, noticeId)}/acknowledgement`;
  const myContractsPath = (voyageId: string) => `/api/voyages/${voyageId}/my-contracts`;

  const etaRequest = (contractId: string, overrides: Partial<IssueNoticeRequest> = {}) => ({
    contractId,
    estimatedArrivalAt: fromNow(96).toISOString(),
    acknowledgementDueAt: fromNow(24).toISOString(),
    message: 'Vessel sailed Santos; ETA Rotterdam as stated.',
    ...overrides,
  });

  const issue = (cookie: string, voyageId: string, body: unknown) =>
    http()
      .post(noticesPath(voyageId))
      .set('Cookie', cookie)
      .send(body as object);

  const acknowledge = (cookie: string, voyageId: string, noticeId: string) =>
    http().post(acknowledgementPath(voyageId, noticeId)).set('Cookie', cookie);

  /** Issues through the API as `cookie` and returns the notice. */
  async function issued(cookie: string, voyageId: string, contractId: string) {
    const response = await issue(cookie, voyageId, etaRequest(contractId)).expect(201);
    return NoticeSchema.parse(response.body);
  }

  /**
   * Writes a notice row directly, for states the API refuses to create on demand (a deadline
   * that has already passed). The issuer is the contract's seller.
   */
  async function insertNotice(
    s: Scenario,
    {
      contractId = s.c1,
      voyageId = s.voyage.id,
      issuer = s.exporter,
      issuedAt = fromNow(-48),
      dueAt = fromNow(-24),
      arrivalAt = fromNow(72),
    } = {},
  ) {
    return ctx.prisma.notice.create({
      data: {
        voyageId,
        tradeContractId: contractId,
        type: 'ETA',
        estimatedArrivalAt: arrivalAt,
        acknowledgementDueAt: dueAt,
        issuedByUserId: issuer.operator.user.id,
        issuedByOrganizationId: issuer.organization.id,
        issuedAt,
      },
    });
  }

  /** Every row the commands could write. */
  const writes = async () => ({
    notices: await ctx.prisma.notice.count(),
    acknowledged: await ctx.prisma.notice.count({ where: { status: 'ACKNOWLEDGED' } }),
    auditEvents: await ctx.prisma.auditEvent.count(),
  });

  /** A problem without its `instance`, which names the request path. */
  const problemOf = (body: unknown) => {
    const { instance: _instance, ...problem } = ProblemDetailsSchema.parse(body);
    return problem;
  };
  const notFound = (detail: string) => ({
    type: ProblemTypes.Generic,
    title: 'Not Found',
    status: 404,
    detail,
  });

  describe('my contracts (GET /api/voyages/:voyageId/my-contracts)', () => {
    it("lists only the organization's own contracts, in position order, with its side", async () => {
      const s = await scenario();

      const response = await http()
        .get(myContractsPath(s.voyage.id))
        .set('Cookie', s.trader.viewer.cookie)
        .expect(200);

      expect(response.headers['cache-control']).toBe('no-store');
      const { items } = CounterpartyContractListResponseSchema.parse(response.body);
      expect(items).toEqual([
        {
          id: s.c1,
          position: 1,
          side: 'BUYER',
          seller: { id: s.exporter.organization.id, name: 'Exporter Co', countryCode: 'BR' },
          buyer: { id: s.trader.organization.id, name: 'Trader SA', countryCode: 'CH' },
        },
        {
          id: s.c2,
          position: 2,
          side: 'SELLER',
          seller: { id: s.trader.organization.id, name: 'Trader SA', countryCode: 'CH' },
          buyer: { id: s.buyer.organization.id, name: 'Buyer GmbH', countryCode: 'DE' },
        },
      ]);
      // The raw body, before any schema could strip unknown fields.
      const keys = (response.body as { items: object[] }).items.map((item) =>
        Object.keys(item).sort(),
      );
      expect(keys).toEqual([
        ['buyer', 'id', 'position', 'seller', 'side'],
        ['buyer', 'id', 'position', 'seller', 'side'],
      ]);
    });

    it("never lists another voyage's contracts or contracts the organization is not party to", async () => {
      const s = await scenario();

      const exporter = await http()
        .get(myContractsPath(s.voyage.id))
        .set('Cookie', s.exporter.operator.cookie)
        .expect(200);
      expect(
        CounterpartyContractListResponseSchema.parse(exporter.body).items.map((c) => c.id),
      ).toEqual([s.c1]);

      for (const provider of [s.surveyor, s.agent]) {
        const response = await http()
          .get(myContractsPath(s.voyage.id))
          .set('Cookie', provider.operator.cookie)
          .expect(200);
        expect(response.body).toEqual({ items: [] });
      }
    });

    it('answers an outsider exactly like a request for a missing voyage', async () => {
      const s = await scenario();
      const missingVoyage = '01990000-0000-7000-8006-999999999999';

      const forbidden = await http()
        .get(myContractsPath(s.voyage.id))
        .set('Cookie', s.outsider.operator.cookie)
        .expect(404);
      const missing = await http()
        .get(myContractsPath(missingVoyage))
        .set('Cookie', s.outsider.operator.cookie)
        .expect(404);

      expect(problemOf(forbidden.body)).toEqual(problemOf(missing.body));
      expect(problemOf(forbidden.body)).toEqual(notFound('Voyage was not found.'));
    });

    it('requires a session', async () => {
      const s = await scenario();
      await http().get(myContractsPath(s.voyage.id)).expect(401);
    });
  });

  describe('issuing (POST /api/voyages/:voyageId/notices)', () => {
    it("lets an operator of the contract's seller issue, with a server-derived issuer and time", async () => {
      const s = await scenario();
      const body = etaRequest(s.c1);
      const before = Date.now();

      const response = await issue(s.exporter.operator.cookie, s.voyage.id, body).expect(201);

      const after = Date.now();
      const notice = NoticeSchema.parse(response.body);
      expect(response.headers.location).toBe(`/api/voyages/${s.voyage.id}/notices/${notice.id}`);
      expect(notice).toMatchObject({
        voyageId: s.voyage.id,
        type: 'ETA',
        status: 'ISSUED',
        contract: { id: s.c1, position: 1, side: 'SELLER' },
        estimatedArrivalAt: body.estimatedArrivalAt,
        acknowledgementDueAt: body.acknowledgementDueAt,
        message: body.message,
        issuedBy: {
          name: `Test User ${s.exporter.operator.user.email}`,
          organization: { id: s.exporter.organization.id, name: 'Exporter Co' },
        },
        acknowledgedAt: null,
        acknowledgedBy: null,
        overdue: false,
      });
      const issuedAt = Date.parse(notice.issuedAt);
      expect(issuedAt).toBeGreaterThanOrEqual(before);
      expect(issuedAt).toBeLessThanOrEqual(after);

      const row = await ctx.prisma.notice.findUniqueOrThrow({ where: { id: notice.id } });
      expect(row).toMatchObject({
        voyageId: s.voyage.id,
        tradeContractId: s.c1,
        issuedByUserId: s.exporter.operator.user.id,
        issuedByOrganizationId: s.exporter.organization.id,
      });
    });

    it('records exactly one NOTICE_ISSUED event in the same transaction', async () => {
      const s = await scenario();

      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      const events = await ctx.prisma.auditEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'NOTICE_ISSUED',
        voyageId: s.voyage.id,
        actorUserId: s.exporter.operator.user.id,
        actorOrganizationId: s.exporter.organization.id,
        payload: {
          noticeId: notice.id,
          contractId: s.c1,
          type: 'ETA',
          estimatedArrivalAt: notice.estimatedArrivalAt,
          acknowledgementDueAt: notice.acknowledgementDueAt,
          message: notice.message,
          issuedAt: notice.issuedAt,
        },
      });
      expect(events[0]?.occurredAt.getTime()).toBeGreaterThanOrEqual(Date.parse(notice.issuedAt));
    });

    it('lets a trader issue under the contract it sells under', async () => {
      const s = await scenario();
      const notice = await issued(s.trader.operator.cookie, s.voyage.id, s.c2);
      expect(notice.contract).toMatchObject({ id: s.c2, side: 'SELLER' });
    });

    it('stores no message when none is given', async () => {
      const s = await scenario();
      const { message: _message, ...body } = etaRequest(s.c1);

      const response = await issue(s.exporter.operator.cookie, s.voyage.id, body).expect(201);

      expect(NoticeSchema.parse(response.body).message).toBeNull();
    });

    it("refuses a viewer of the seller's organization and writes nothing", async () => {
      const s = await scenario();

      const response = await issue(s.exporter.viewer.cookie, s.voyage.id, etaRequest(s.c1)).expect(
        403,
      );

      expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
      expect(ProblemDetailsSchema.parse(response.body).detail).toBe(
        'Your role does not allow you to issue notices.',
      );
      expect(await writes()).toEqual({ notices: 0, acknowledged: 0, auditEvents: 0 });
    });

    it("refuses an operator of the contract's buyer", async () => {
      const s = await scenario();

      const response = await issue(s.trader.operator.cookie, s.voyage.id, etaRequest(s.c1)).expect(
        403,
      );

      expect(ProblemDetailsSchema.parse(response.body).detail).toBe(
        'Only the seller under a contract may issue its notices.',
      );
      expect(await writes()).toEqual({ notices: 0, acknowledged: 0, auditEvents: 0 });
    });

    it('answers every contract the organization is not party to like a missing one', async () => {
      const s = await scenario();
      const cases: [string, string, string][] = [
        ['a missing contract', s.exporter.operator.cookie, MISSING_ID],
        ['a participant that is not a counterparty', s.exporter.operator.cookie, s.c2],
        ['a surveyor', s.surveyor.operator.cookie, s.c1],
        ['a shipping agent', s.agent.operator.cookie, s.c1],
        ['an outsider', s.outsider.operator.cookie, s.c1],
      ];

      for (const [label, cookie, contractId] of cases) {
        const response = await issue(cookie, s.voyage.id, etaRequest(contractId));
        expect({ label, status: response.status }).toEqual({ label, status: 404 });
        expect(problemOf(response.body)).toEqual(notFound('Contract was not found.'));
      }
      expect(await writes()).toEqual({ notices: 0, acknowledged: 0, auditEvents: 0 });
    });

    it("cannot issue under another voyage's contract, even the organization's own", async () => {
      const s = await scenario();

      // The exporter sells under d1 on TF-OTHER, but the request names TF-N.
      const crossed = await issue(s.exporter.operator.cookie, s.voyage.id, etaRequest(s.d1));
      expect(crossed.status).toBe(404);
      expect(problemOf(crossed.body)).toEqual(notFound('Contract was not found.'));
      // And the other way round.
      await issue(s.exporter.operator.cookie, s.other.id, etaRequest(s.c1)).expect(404);

      expect(await writes()).toEqual({ notices: 0, acknowledged: 0, auditEvents: 0 });
    });

    it('rejects a body that tries to set the issuer, the time, the status or the voyage', async () => {
      const s = await scenario();

      const response = await issue(s.exporter.operator.cookie, s.voyage.id, {
        ...etaRequest(s.c1),
        issuedByUserId: s.buyer.operator.user.id,
        issuedByOrganizationId: s.buyer.organization.id,
        issuedAt: fromNow(-1000).toISOString(),
        status: 'ACKNOWLEDGED',
        voyageId: s.other.id,
      }).expect(400);

      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.type).toBe(ProblemTypes.ValidationFailed);
      for (const field of ['issuedByUserId', 'issuedByOrganizationId', 'issuedAt', 'status']) {
        expect(problem.errors?.[0]?.message).toContain(field);
      }
      expect(await writes()).toEqual({ notices: 0, acknowledged: 0, auditEvents: 0 });
    });

    it('ignores identities supplied in headers and the query string', async () => {
      const s = await scenario();

      const response = await http()
        .post(`${noticesPath(s.voyage.id)}?organizationId=${s.trader.organization.id}`)
        .set('Cookie', s.exporter.operator.cookie)
        .set('X-Organization-Id', s.trader.organization.id)
        .set('X-User-Id', s.trader.operator.user.id)
        .send(etaRequest(s.c1))
        .expect(201);

      const notice = NoticeSchema.parse(response.body);
      expect(notice.issuedBy.organization.id).toBe(s.exporter.organization.id);
      expect(await ctx.prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject(
        {
          issuedByUserId: s.exporter.operator.user.id,
          issuedByOrganizationId: s.exporter.organization.id,
        },
      );
      expect(await ctx.prisma.auditEvent.findFirstOrThrow()).toMatchObject({
        actorUserId: s.exporter.operator.user.id,
        actorOrganizationId: s.exporter.organization.id,
      });
    });

    it.each<[string, (contractId: string) => unknown, string[], string]>([
      [
        'a deadline in the past',
        (c) => etaRequest(c, { acknowledgementDueAt: fromNow(-1).toISOString() }),
        ['body.acknowledgementDueAt'],
        'The acknowledgement deadline must be in the future',
      ],
      [
        'a deadline after the estimated arrival',
        (c) =>
          etaRequest(c, {
            estimatedArrivalAt: fromNow(24).toISOString(),
            acknowledgementDueAt: fromNow(48).toISOString(),
          }),
        ['body.acknowledgementDueAt'],
        'The acknowledgement deadline must not be after the estimated arrival',
      ],
      [
        'an arrival without a time zone',
        (c) => etaRequest(c, { estimatedArrivalAt: '2026-12-01T10:00:00' }),
        ['body.estimatedArrivalAt'],
        'Expected a date and time with a time zone offset',
      ],
      [
        'a message that is too long',
        (c) => etaRequest(c, { message: 'x'.repeat(1001) }),
        ['body.message'],
        'Use at most 1000 characters',
      ],
      [
        'a blank message',
        (c) => etaRequest(c, { message: '   ' }),
        ['body.message'],
        'Leave the message out, or write something',
      ],
      [
        'a malformed contract id',
        (c) => etaRequest(c, { contractId: 'contract-1' }),
        ['body.contractId'],
        'Invalid UUID',
      ],
    ])('rejects %s and writes nothing', async (_case, body, paths, message) => {
      const s = await scenario();

      const response = await issue(s.exporter.operator.cookie, s.voyage.id, body(s.c1)).expect(400);

      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.type).toBe(ProblemTypes.ValidationFailed);
      expect(problem.errors?.map((error) => error.path)).toEqual(paths);
      expect(problem.errors?.[0]?.message).toBe(message);
      expect(await writes()).toEqual({ notices: 0, acknowledged: 0, auditEvents: 0 });
    });

    it('accepts the longest message, and a deadline equal to the arrival', async () => {
      const s = await scenario();
      const at = fromNow(48).toISOString();

      const response = await issue(
        s.exporter.operator.cookie,
        s.voyage.id,
        etaRequest(s.c1, {
          estimatedArrivalAt: at,
          acknowledgementDueAt: at,
          message: 'x'.repeat(1000),
        }),
      ).expect(201);

      expect(NoticeSchema.parse(response.body).message).toHaveLength(1000);
    });

    it('requires a session before looking at the body, and refuses cross-site requests', async () => {
      const s = await scenario();

      await http().post(noticesPath(s.voyage.id)).send({ nonsense: true }).expect(401);
      await issue(s.exporter.operator.cookie, s.voyage.id, etaRequest(s.c1))
        .set('Sec-Fetch-Site', 'cross-site')
        .expect(403);

      expect(await writes()).toEqual({ notices: 0, acknowledged: 0, auditEvents: 0 });
    });

    it('rolls the notice back when its audit event cannot be written', async () => {
      const s = await scenario();
      await failAuditWrites(async () => {
        const response = await issue(
          s.exporter.operator.cookie,
          s.voyage.id,
          etaRequest(s.c1),
        ).expect(500);
        expect(ProblemDetailsSchema.parse(response.body).detail).toBe(
          'An unexpected error occurred.',
        );
      });
      expect(await writes()).toEqual({ notices: 0, acknowledged: 0, auditEvents: 0 });
    });
  });

  describe('reading', () => {
    it('shows a notice to both counterparties, operators and viewers alike, from their side', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      for (const [reader, side] of [
        [s.exporter.operator, 'SELLER'],
        [s.exporter.viewer, 'SELLER'],
        [s.trader.operator, 'BUYER'],
        [s.trader.viewer, 'BUYER'],
      ] as const) {
        const list = await http().get(noticesPath(s.voyage.id)).set('Cookie', reader.cookie);
        expect(list.status).toBe(200);
        const items = NoticeListResponseSchema.parse(list.body).items;
        expect(items.map((item) => [item.id, item.contract.side])).toEqual([[notice.id, side]]);

        const one = await http()
          .get(noticePath(s.voyage.id, notice.id))
          .set('Cookie', reader.cookie)
          .expect(200);
        expect(NoticeSchema.parse(one.body)).toEqual({
          ...notice,
          contract: { ...notice.contract, side },
        });
      }
    });

    it('hides it from every other participant, service providers included', async () => {
      const s = await scenario();
      // Trader → Buyer: the exporter takes part in the voyage but not in this contract.
      const notice = await issued(s.trader.operator.cookie, s.voyage.id, s.c2);

      for (const reader of [s.exporter, s.surveyor, s.agent]) {
        for (const { cookie } of [reader.operator, reader.viewer]) {
          const list = await http().get(noticesPath(s.voyage.id)).set('Cookie', cookie).expect(200);
          expect(list.body).toEqual({ items: [] });

          const hidden = await http()
            .get(noticePath(s.voyage.id, notice.id))
            .set('Cookie', cookie)
            .expect(404);
          const missing = await http()
            .get(noticePath(s.voyage.id, MISSING_ID))
            .set('Cookie', cookie)
            .expect(404);
          expect(problemOf(hidden.body)).toEqual(problemOf(missing.body));
          expect(problemOf(hidden.body)).toEqual(notFound('Notice was not found.'));
        }
      }
    });

    it('answers an outsider like a request for a missing notice or voyage', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      const { cookie } = s.outsider.operator;

      const hidden = await http().get(noticePath(s.voyage.id, notice.id)).set('Cookie', cookie);
      const missing = await http().get(noticePath(s.voyage.id, MISSING_ID)).set('Cookie', cookie);
      expect([hidden.status, missing.status]).toEqual([404, 404]);
      expect(problemOf(hidden.body)).toEqual(problemOf(missing.body));

      const list = await http().get(noticesPath(s.voyage.id)).set('Cookie', cookie).expect(404);
      expect(problemOf(list.body)).toEqual(notFound('Voyage was not found.'));
    });

    it("cannot reach a notice through another voyage's path", async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      // The exporter is a counterparty on both voyages, but the notice belongs to TF-N.
      const crossed = await http()
        .get(noticePath(s.other.id, notice.id))
        .set('Cookie', s.exporter.operator.cookie)
        .expect(404);
      expect(problemOf(crossed.body)).toEqual(notFound('Notice was not found.'));
      const list = await http()
        .get(noticesPath(s.other.id))
        .set('Cookie', s.exporter.operator.cookie)
        .expect(200);
      expect(list.body).toEqual({ items: [] });
    });

    it('lists the most recently issued first', async () => {
      const s = await scenario();
      const first = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      const second = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      const response = await http()
        .get(noticesPath(s.voyage.id))
        .set('Cookie', s.trader.viewer.cookie)
        .expect(200);

      expect(NoticeListResponseSchema.parse(response.body).items.map((n) => n.id)).toEqual([
        second.id,
        first.id,
      ]);
    });

    it('derives overdue from the deadline while unacknowledged, and stores nothing for it', async () => {
      const s = await scenario();
      const late = await insertNotice(s, { dueAt: fromNow(-1) });
      const onTime = await insertNotice(s, { dueAt: fromNow(1) });

      const response = await http()
        .get(noticesPath(s.voyage.id))
        .set('Cookie', s.trader.operator.cookie)
        .expect(200);

      const overdue = Object.fromEntries(
        NoticeListResponseSchema.parse(response.body).items.map((n) => [n.id, n.overdue]),
      );
      expect(overdue).toEqual({ [late.id]: true, [onTime.id]: false });
      const rows = await ctx.prisma.notice.findMany();
      expect(rows.map((row) => row.status)).toEqual(['ISSUED', 'ISSUED']);
    });
  });

  describe('acknowledging (POST .../notices/:noticeId/acknowledgement)', () => {
    it("lets an operator of the contract's buyer acknowledge receipt, once", async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      const before = Date.now();

      const response = await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(
        200,
      );

      const after = Date.now();
      const acknowledged = NoticeSchema.parse(response.body);
      expect(acknowledged).toEqual({
        ...notice,
        contract: { ...notice.contract, side: 'BUYER' },
        status: 'ACKNOWLEDGED',
        acknowledgedAt: expect.any(String) as string,
        acknowledgedBy: {
          name: `Test User ${s.trader.operator.user.email}`,
          organization: { id: s.trader.organization.id, name: 'Trader SA', countryCode: 'CH' },
        },
        overdue: false,
      });
      const at = Date.parse(acknowledged.acknowledgedAt ?? '');
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);

      // The seller sees the acknowledgement.
      const seen = await http()
        .get(noticePath(s.voyage.id, notice.id))
        .set('Cookie', s.exporter.viewer.cookie)
        .expect(200);
      expect(NoticeSchema.parse(seen.body)).toMatchObject({
        status: 'ACKNOWLEDGED',
        acknowledgedAt: acknowledged.acknowledgedAt,
      });

      const again = await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(409);
      expect(problemOf(again.body)).toEqual({
        type: ProblemTypes.Generic,
        title: 'Conflict',
        status: 409,
        detail: 'This notice has already been acknowledged.',
      });
      expect(await writes()).toEqual({ notices: 1, acknowledged: 1, auditEvents: 2 });
    });

    it('records exactly one NOTICE_ACKNOWLEDGED event with the server-derived actor', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      const response = await http()
        .post(`${acknowledgementPath(s.voyage.id, notice.id)}?userId=${s.exporter.viewer.user.id}`)
        .set('Cookie', s.trader.operator.cookie)
        .set('X-Organization-Id', s.buyer.organization.id)
        .set('X-User-Id', s.buyer.operator.user.id)
        .expect(200);

      const { acknowledgedAt } = NoticeSchema.parse(response.body);
      const events = await ctx.prisma.auditEvent.findMany({
        where: { action: 'NOTICE_ACKNOWLEDGED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        voyageId: s.voyage.id,
        actorUserId: s.trader.operator.user.id,
        actorOrganizationId: s.trader.organization.id,
        payload: { noticeId: notice.id, contractId: s.c1, acknowledgedAt, late: false },
      });
      expect(await ctx.prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject(
        {
          acknowledgedByUserId: s.trader.operator.user.id,
          acknowledgedByOrganizationId: s.trader.organization.id,
        },
      );
    });

    it('rejects a body that tries to set the acknowledging user or time', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      const response = await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id)
        .send({ acknowledgedByUserId: s.buyer.operator.user.id, acknowledgedAt: '2020-01-01' })
        .expect(400);

      expect(ProblemDetailsSchema.parse(response.body).type).toBe(ProblemTypes.ValidationFailed);
      expect(await writes()).toEqual({ notices: 1, acknowledged: 0, auditEvents: 1 });

      // An empty object is accepted, like no body at all.
      await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).send({}).expect(200);
    });

    it('accepts a late acknowledgement and records that it was late', async () => {
      const s = await scenario();
      const notice = await insertNotice(s, { dueAt: fromNow(-1) });

      const response = await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(
        200,
      );

      const acknowledged = NoticeSchema.parse(response.body);
      expect(acknowledged).toMatchObject({ status: 'ACKNOWLEDGED', overdue: false });
      expect(Date.parse(acknowledged.acknowledgedAt ?? '')).toBeGreaterThan(
        Date.parse(acknowledged.acknowledgementDueAt),
      );
      expect(await ctx.prisma.auditEvent.findFirstOrThrow()).toMatchObject({
        action: 'NOTICE_ACKNOWLEDGED',
        payload: { noticeId: notice.id, late: true },
      });
    });

    it("refuses a viewer of the buyer's organization and an operator of the seller's", async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      const viewer = await acknowledge(s.trader.viewer.cookie, s.voyage.id, notice.id).expect(403);
      expect(ProblemDetailsSchema.parse(viewer.body).detail).toBe(
        'Your role does not allow you to acknowledge notices.',
      );
      const seller = await acknowledge(s.exporter.operator.cookie, s.voyage.id, notice.id).expect(
        403,
      );
      expect(ProblemDetailsSchema.parse(seller.body).detail).toBe(
        'Only the buyer under a contract may acknowledge its notices.',
      );

      expect(await writes()).toEqual({ notices: 1, acknowledged: 0, auditEvents: 1 });
    });

    it('answers everyone else like a request for a missing notice', async () => {
      const s = await scenario();
      // Trader → Buyer, so the exporter is a participant but not a counterparty.
      const notice = await issued(s.trader.operator.cookie, s.voyage.id, s.c2);

      for (const { cookie } of [
        s.exporter.operator,
        s.surveyor.operator,
        s.agent.operator,
        s.outsider.operator,
      ]) {
        const hidden = await acknowledge(cookie, s.voyage.id, notice.id).expect(404);
        const missing = await acknowledge(cookie, s.voyage.id, MISSING_ID).expect(404);
        expect(problemOf(hidden.body)).toEqual(problemOf(missing.body));
        expect(problemOf(hidden.body)).toEqual(notFound('Notice was not found.'));
      }
      // The buyer on TF-OTHER cannot reach it through that voyage's path either.
      await acknowledge(s.buyer.operator.cookie, s.other.id, notice.id).expect(404);

      expect(await writes()).toEqual({ notices: 1, acknowledged: 0, auditEvents: 1 });
    });

    it('produces one transition and one event when two acknowledgements race', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      const colleague = await createUser(ctx.prisma, s.trader.organization.id, {
        role: 'OPERATOR',
      });
      const contenders = [
        { userId: s.trader.operator.user.id, cookie: s.trader.operator.cookie },
        { userId: colleague.id, cookie: await signIn(ctx.server, colleague.email) },
      ];

      // Hold the notice's row lock, so that both requests read it as ISSUED, pass every check
      // and then queue on the conditional update, before either can commit.
      let release: () => void = () => undefined;
      const released = new Promise<void>((resolve) => {
        release = resolve;
      });
      let locked: () => void = () => undefined;
      const lockTaken = new Promise<void>((resolve) => {
        locked = resolve;
      });
      const holder = ctx.prisma.$transaction(
        async (tx) => {
          await tx.$queryRaw`SELECT id FROM notices WHERE id = ${notice.id}::uuid FOR UPDATE`;
          locked();
          await released;
        },
        { timeout: 10_000 },
      );
      await lockTaken;

      const responses = Promise.all(
        contenders.map(({ cookie }) =>
          acknowledge(cookie, s.voyage.id, notice.id).then((response) => response),
        ),
      );
      await waitForLockWaiters(2);
      release();
      await holder;
      const [first, second] = await responses;

      expect([first?.status, second?.status].sort()).toEqual([200, 409]);
      const winner = first?.status === 200 ? contenders[0] : contenders[1];
      const events = await ctx.prisma.auditEvent.findMany({
        where: { action: 'NOTICE_ACKNOWLEDGED' },
      });
      expect(events).toHaveLength(1);
      expect(events[0]?.actorUserId).toBe(winner?.userId);
      expect(await ctx.prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject(
        { status: 'ACKNOWLEDGED', acknowledgedByUserId: winner?.userId },
      );
    });

    it('leaves the notice unacknowledged when its audit event cannot be written', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      await failAuditWrites(async () => {
        const response = await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(
          500,
        );
        const problem = ProblemDetailsSchema.parse(response.body);
        expect(problem.detail).toBe('An unexpected error occurred.');
        expect(JSON.stringify(problem)).not.toContain('audit store');
      });

      expect(await ctx.prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject(
        {
          status: 'ISSUED',
          acknowledgedByUserId: null,
          acknowledgedByOrganizationId: null,
          acknowledgedAt: null,
        },
      );
      expect(await writes()).toEqual({ notices: 1, acknowledged: 0, auditEvents: 1 });
      // Nothing was half-done: the acknowledgement can still be made.
      await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(200);
    });
  });

  describe('immutability', () => {
    it('offers no way to edit or delete a notice', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      for (const method of ['put', 'patch', 'delete'] as const) {
        await http()
          [method](noticePath(s.voyage.id, notice.id))
          .set('Cookie', s.exporter.operator.cookie)
          .send({ message: 'edited' })
          .expect(404);
      }
      expect(
        (await ctx.prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })).message,
      ).toBe(notice.message);
    });

    /**
     * Updates one column with plain SQL, as any writer with table access could. (Raw queries
     * report the trigger's message; the ORM maps its SQLSTATE to a generic error.)
     */
    const update = (noticeId: string, column: string, value: unknown) =>
      ctx.prisma.$executeRawUnsafe(
        `UPDATE notices SET ${column} = $1 WHERE id = $2::uuid`,
        value,
        noticeId,
      );

    it.each<[string, string, (s: Scenario) => unknown]>([
      ['the estimated arrival', 'estimated_arrival_at', () => fromNow(200)],
      ['the deadline', 'acknowledgement_due_at', () => fromNow(50)],
      ['the message', 'message', () => 'edited'],
      ['the issuer', 'issued_by_user_id', (s) => s.exporter.viewer.user.id],
      ['the time of issue', 'issued_at', () => fromNow(-5)],
      ['the contract', 'trade_contract_id', (s) => s.c2],
    ])('refuses any writer changing %s of an issued notice', async (_field, column, value) => {
      const s = await scenario();
      const notice = await insertNotice(s, { dueAt: fromNow(24) });

      await expect(update(notice.id, column, value(s))).rejects.toThrow(
        /issued content is immutable/,
      );
    });

    it('refuses any change to an acknowledged notice, including undoing it', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(200);

      await expect(ctx.prisma.$executeRaw`
        UPDATE notices SET status = 'ISSUED', acknowledged_at = NULL,
          acknowledged_by_user_id = NULL, acknowledged_by_organization_id = NULL
        WHERE id = ${notice.id}::uuid`).rejects.toThrow(/acknowledged notice cannot change/);
      await expect(
        update(notice.id, 'acknowledged_by_user_id', s.trader.viewer.user.id),
      ).rejects.toThrow(/acknowledged notice cannot change/);
      // Through the ORM as well, whatever error it reports.
      await expect(
        ctx.prisma.notice.update({
          where: { id: notice.id },
          data: { acknowledgedAt: new Date() },
        }),
      ).rejects.toThrow();
      expect(await ctx.prisma.notice.findUniqueOrThrow({ where: { id: notice.id } })).toMatchObject(
        { status: 'ACKNOWLEDGED', acknowledgedByUserId: s.trader.operator.user.id },
      );
    });
  });

  describe('notices database constraints', () => {
    /** Inserts with plain SQL, as any writer could: the database alone must refuse bad rows. */
    const insert = (
      s: Scenario,
      {
        voyageId = s.voyage.id,
        contractId = s.c1,
        issuedAt = fromNow(-1),
        dueAt = fromNow(1),
        arrivalAt = fromNow(2),
        message = null as string | null,
        status = 'ISSUED',
        acknowledgedAt = null as Date | null,
      } = {},
    ) => ctx.prisma.$executeRaw`
      INSERT INTO notices (voyage_id, trade_contract_id, type, status, estimated_arrival_at,
        acknowledgement_due_at, message, issued_by_user_id, issued_by_organization_id, issued_at,
        acknowledged_by_user_id, acknowledged_by_organization_id, acknowledged_at)
      VALUES (${voyageId}::uuid, ${contractId}::uuid, 'ETA', ${status}::notice_status,
        ${arrivalAt}, ${dueAt}, ${message}, ${s.exporter.operator.user.id}::uuid,
        ${s.exporter.organization.id}::uuid, ${issuedAt},
        ${acknowledgedAt ? s.trader.operator.user.id : null}::uuid,
        ${acknowledgedAt ? s.trader.organization.id : null}::uuid, ${acknowledgedAt})`;

    it('accepts a well-formed notice', async () => {
      const s = await scenario();
      await expect(insert(s)).resolves.toBe(1);
    });

    it.each<[string, (s: Scenario) => Parameters<typeof insert>[1], RegExp]>([
      [
        "another voyage's contract",
        (s) => ({ voyageId: s.voyage.id, contractId: s.d1 }),
        /notices_voyage_id_trade_contract_id_fkey/,
      ],
      [
        'a deadline before the time of issue',
        () => ({ dueAt: fromNow(-2) }),
        /notices_due_after_issue/,
      ],
      [
        'a deadline after the arrival',
        () => ({ dueAt: fromNow(3) }),
        /notices_due_not_after_arrival/,
      ],
      ['a blank message', () => ({ message: ' \n ' }), /notices_message_length/],
      [
        'a message that is too long',
        () => ({ message: 'x'.repeat(1001) }),
        /notices_message_length/,
      ],
      [
        'an acknowledged notice without its acknowledgement',
        () => ({ status: 'ACKNOWLEDGED' }),
        /notices_acknowledgement_matches_status/,
      ],
      [
        'an issued notice with an acknowledgement',
        () => ({ acknowledgedAt: fromNow(0) }),
        /notices_acknowledgement_matches_status/,
      ],
      [
        'an acknowledgement before the time of issue',
        () => ({ status: 'ACKNOWLEDGED', acknowledgedAt: fromNow(-2) }),
        /notices_acknowledged_after_issue/,
      ],
    ])('rejects %s', async (_case, overrides, constraint) => {
      const s = await scenario();
      await expect(insert(s, overrides(s))).rejects.toThrow(constraint);
    });

    it('keeps a contract with notices from being deleted', async () => {
      const s = await scenario();
      await insertNotice(s);
      await expect(ctx.prisma.tradeContract.delete({ where: { id: s.c1 } })).rejects.toThrow();
    });

    it('allows one NOTICE_ACKNOWLEDGED event per notice', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(200);

      await expect(
        ctx.prisma.auditEvent.create({
          data: {
            action: 'NOTICE_ACKNOWLEDGED',
            actorUserId: s.trader.operator.user.id,
            actorOrganizationId: s.trader.organization.id,
            voyageId: s.voyage.id,
            payload: { noticeId: notice.id },
          },
        }),
      ).rejects.toThrow();
      await expect(
        ctx.prisma.auditEvent.create({
          data: {
            action: 'NOTICE_ISSUED',
            actorUserId: s.exporter.operator.user.id,
            actorOrganizationId: s.exporter.organization.id,
            voyageId: s.voyage.id,
            payload: { contractId: s.c1 },
          },
        }),
      ).rejects.toThrow(/audit_events_notice_payload/);
    });
  });

  describe('the shared trade string', () => {
    it('stays exactly as it was: no contract ids, no notices', async () => {
      const s = await scenario();
      const tradeString = (cookie: string) =>
        http().get(`/api/voyages/${s.voyage.id}/trade-string`).set('Cookie', cookie).expect(200);
      const before = (await tradeString(s.surveyor.viewer.cookie)).body as unknown;

      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(200);

      for (const reader of [s.exporter, s.trader, s.buyer, s.surveyor, s.agent]) {
        const body = (await tradeString(reader.viewer.cookie)).body as {
          parties: object[];
          edges: object[];
        };
        expect(body).toEqual(before);
        expect(Object.keys(body).sort()).toEqual(['edges', 'parties']);
        for (const edge of body.edges) {
          expect(Object.keys(edge).sort()).toEqual([
            'buyerOrganizationId',
            'position',
            'sellerOrganizationId',
          ]);
        }
        const raw = JSON.stringify(body);
        for (const id of [s.c1, s.c2, notice.id]) {
          expect(raw).not.toContain(id);
        }
        expect(raw).not.toMatch(/notice|eta|acknowledg/i);
      }
    });
  });

  /** Runs `act` while every insert into `audit_events` fails, like an unavailable audit store. */
  async function failAuditWrites(act: () => Promise<void>) {
    await ctx.prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_audit_unavailable() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'audit store unavailable'; END $$`);
    await ctx.prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_audit_unavailable BEFORE INSERT ON audit_events
      FOR EACH ROW EXECUTE FUNCTION test_audit_unavailable()`);
    try {
      await act();
    } finally {
      await ctx.prisma.$executeRawUnsafe('DROP TRIGGER test_audit_unavailable ON audit_events');
      await ctx.prisma.$executeRawUnsafe('DROP FUNCTION test_audit_unavailable()');
    }
  }

  /** Waits until `count` sessions of this database are blocked on a lock. */
  async function waitForLockWaiters(count: number) {
    const deadline = Date.now() + 5_000;
    for (;;) {
      const [row] = await ctx.prisma.$queryRaw<{ waiting: number }[]>`
        SELECT count(*)::int AS waiting FROM pg_stat_activity
        WHERE datname = current_database() AND wait_event_type = 'Lock'`;
      if ((row?.waiting ?? 0) >= count) return;
      if (Date.now() > deadline) {
        throw new Error(`Expected ${count} sessions waiting on a lock, saw ${row?.waiting ?? 0}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }
});
