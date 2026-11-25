import { createHash, randomBytes } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import {
  ContractDocumentSchema,
  type DocumentaryInstructionContent,
  DocumentaryInstructionSchema,
  documentEntityTag,
  instructionEntityTag,
  PROBLEM_CONTENT_TYPE,
  ProblemTypes,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { DEMO_WRITE_BUDGET_EXHAUSTED } from '../src/common/http/demo-write-budget-exhausted.exception.js';
import { loadConfig } from '../src/config/app-config.js';
import type { UserRole } from '../src/generated/prisma/client.js';
import { signIn } from './support/auth.js';
import { failAuditWrites, holdLock, waitForLockWaiters } from './support/concurrency.js';
import {
  createOrganization,
  createReferenceData,
  createTradeString,
  createUser,
  createVoyage,
  resetDatabase,
} from './support/database.js';
import { TestEventBus } from './support/event-bus.js';
import { openEventStream } from './support/event-stream.js';
import { TestStorage } from './support/storage.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/*
 * The portfolio demo's write budget (ADR 0021) against PostgreSQL, through the real HTTP
 * pipeline. Most tests run one application with protection enabled and an allowance of 50, and
 * set the durable count directly to reach the state they need (one left, none left); the tests
 * of restarts, of the very first admissions and of the default (disabled) mode start
 * applications of their own against the same database.
 */

const ALLOWANCE = 50;

/** The configuration a protected demo runs with: the real loader, explicit variables. */
const protectedConfig = (allowance: number) =>
  loadConfig({
    ...process.env,
    PORTFOLIO_DEMO_WRITE_PROTECTION: 'enabled',
    PORTFOLIO_DEMO_WRITE_ALLOWANCE: String(allowance),
  });

/** Revision 1 requires a bill of lading and a certificate of origin. */
const firstContent: DocumentaryInstructionContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 3 },
    { document: 'CERTIFICATE_OF_ORIGIN', originals: 1, copies: 1 },
  ],
};

const secondContent: DocumentaryInstructionContent = {
  ...firstContent,
  consignee: 'To order of Banco Segundo S.A.',
};

/** Bytes that start like a PDF. */
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(16 * 1024)]);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/** Collects a response body as bytes (a supertest parser). */
const asBytes = ((response: IncomingMessage, done: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => {
    done(null, Buffer.concat(chunks));
  });
}) as unknown as Parameters<request.Test['parse']>[0];

const DAY_MS = 24 * 60 * 60 * 1000;
const noticeBody = (contractId: string) => ({
  contractId,
  estimatedArrivalAt: new Date(Date.now() + 5 * DAY_MS).toISOString(),
  acknowledgementDueAt: new Date(Date.now() + 2 * DAY_MS).toISOString(),
});

describe('Portfolio-demo write budget', () => {
  let ctx: TestApp;
  let storage: TestStorage;
  const events = new TestEventBus();
  const api = () => request(ctx.server);

  beforeAll(async () => {
    storage = await TestStorage.create();
    ctx = await createTestApp({ config: protectedConfig(ALLOWANCE), storage, eventBus: events });
  });

  afterAll(async () => {
    await ctx.app.close();
    await storage.dispose();
  });

  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    await storage.clear();
    events.reset();
  });

  afterEach(() => {
    storage.reset();
  });

  /** The durable count: how many business commands this database has admitted. */
  const admitted = async () =>
    (await ctx.prisma.demoWriteBudget.findUnique({ where: { id: 1 } }))?.admitted ?? 0;

  /** Sets the count, as if that many commands had been admitted. 0: the row does not exist. */
  async function setAdmitted(count: number): Promise<void> {
    await ctx.prisma.demoWriteBudget.deleteMany();
    if (count > 0) await ctx.prisma.demoWriteBudget.create({ data: { id: 1, admitted: count } });
  }

  /** Every row a business command could write. */
  const rows = async () => ({
    voyages: await ctx.prisma.voyage.count(),
    participants: await ctx.prisma.voyageParticipant.count(),
    contracts: await ctx.prisma.tradeContract.count(),
    notices: await ctx.prisma.notice.count(),
    acknowledgedNotices: await ctx.prisma.notice.count({ where: { status: 'ACKNOWLEDGED' } }),
    instructions: await ctx.prisma.documentaryInstruction.count(),
    revisions: await ctx.prisma.documentaryInstructionRevision.count(),
    instructionAcknowledgements: await ctx.prisma.documentaryInstructionAcknowledgement.count(),
    documents: await ctx.prisma.document.count(),
    documentVersions: await ctx.prisma.documentVersion.count(),
    reviews: await ctx.prisma.documentReview.count(),
    auditEvents: await ctx.prisma.auditEvent.count(),
  });

  /** What storage holds: staged bytes, and kept objects. */
  const stored = async () => ({
    staging: await storage.files('staging'),
    objects: await storage.files('objects'),
  });

  async function anOrganization(name: string, countryCode = 'NL') {
    const organization = await createOrganization(ctx.prisma, name, countryCode);
    const user = async (role: UserRole) => {
      const row = await createUser(ctx.prisma, organization.id, { role });
      return { user: row, cookie: await signIn(ctx.server, row.email) };
    };
    return { organization, operator: await user('OPERATOR'), viewer: await user('VIEWER') };
  }

  /**
   * TF-B1: Exporter sells to Buyer under contract 1. The buyer has given revision 1 of the
   * instructions (unacknowledged); the exporter has issued two notices, one acknowledged, and
   * uploaded version 1 of the bill of lading (pending review). TF-B2: a new voyage of the
   * exporter's, its trade string not set up. Outsider takes part in neither. Built through the
   * API, after which the count is set back to zero: every test starts with the whole allowance.
   */
  async function scenario() {
    const refs = await createReferenceData(ctx.prisma);
    const exporter = await anOrganization('Exporter Co', 'BR');
    const buyer = await anOrganization('Buyer GmbH', 'DE');
    const outsider = await anOrganization('Outsider BV');
    const voyage = await createVoyage(ctx.prisma, refs, {
      reference: 'TF-B1',
      participants: [
        { organizationId: exporter.organization.id, role: 'EXPORTER' },
        { organizationId: buyer.organization.id, role: 'FINAL_BUYER' },
      ],
    });
    await createTradeString(ctx.prisma, voyage.id, [
      exporter.organization.id,
      buyer.organization.id,
    ]);
    const unset = await createVoyage(ctx.prisma, refs, {
      reference: 'TF-B2',
      participants: [{ organizationId: exporter.organization.id, role: 'EXPORTER' }],
    });
    const c1 = (
      await ctx.prisma.tradeContract.findUniqueOrThrow({
        where: { voyageId_position: { voyageId: voyage.id, position: 1 } },
      })
    ).id;
    const voyagePath = `/api/voyages/${voyage.id}`;
    const instructionPath = `${voyagePath}/contracts/${c1}/documentary-instructions`;
    const documentPath = (type: string) => `${instructionPath}/revisions/1/documents/${type}`;

    DocumentaryInstructionSchema.parse(
      (
        await api()
          .put(instructionPath)
          .set('Cookie', buyer.operator.cookie)
          .set('If-None-Match', '*')
          .send(firstContent)
          .expect(201)
      ).body,
    );
    const issue = async () =>
      (
        (
          await api()
            .post(`${voyagePath}/notices`)
            .set('Cookie', exporter.operator.cookie)
            .send(noticeBody(c1))
            .expect(201)
        ).body as { id: string }
      ).id;
    const noticeId = await issue();
    const acknowledgedNoticeId = await issue();
    await api()
      .post(`${voyagePath}/notices/${acknowledgedNoticeId}/acknowledgement`)
      .set('Cookie', buyer.operator.cookie)
      .expect(200);
    const billOfLading = pdf();
    ContractDocumentSchema.parse(
      (
        await api()
          .post(`${documentPath('BILL_OF_LADING')}/versions`)
          .set('Cookie', exporter.operator.cookie)
          .set('If-None-Match', '*')
          .attach('file', billOfLading, {
            filename: 'bill-of-lading.pdf',
            contentType: 'application/pdf',
          })
          .expect(201)
      ).body,
    );
    await setAdmitted(0);
    events.reset();
    return {
      refs,
      exporter,
      buyer,
      outsider,
      voyage,
      unset,
      c1,
      voyagePath,
      instructionPath,
      documentPath,
      noticeId,
      acknowledgedNoticeId,
      billOfLading,
    };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  /** The instruction's and the bill of lading's entity tags, as a client would have read them. */
  const instructionTag = async (s: Scenario) =>
    instructionEntityTag(
      (
        await ctx.prisma.documentaryInstruction.findUniqueOrThrow({
          where: { tradeContractId: s.c1 },
        })
      ).version,
    );
  const billOfLadingTag = async (s: Scenario) =>
    documentEntityTag(
      (
        await ctx.prisma.document.findFirstOrThrow({
          where: { tradeContractId: s.c1, documentType: 'BILL_OF_LADING' },
        })
      ).version,
    );

  const voyageBody = (s: Scenario) => ({
    vesselId: s.refs.vessel.id,
    commodityId: s.refs.commodity.id,
    quantity: { amount: '45000', unit: 'MT' },
    loadPortId: s.refs.loadPort.id,
    dischargePortId: s.refs.dischargePort.id,
    laycan: { start: '2026-12-01', end: '2026-12-10' },
  });

  const createVoyageAs = (s: Scenario, cookie = s.exporter.operator.cookie) =>
    api().post('/api/voyages').set('Cookie', cookie).send(voyageBody(s));

  interface Command {
    name: string;
    path: string;
    send: () => Promise<request.Response>;
    succeeds: number;
  }

  /**
   * Every business command the API has, each valid in the scenario as it stands: the only thing
   * that can refuse it is the budget. Tags are read when a command is sent, and the order is one
   * in which they all succeed one after another (the revision last: it supersedes revision 1).
   */
  function businessCommands(s: Scenario): Command[] {
    const reviewPath = `${s.documentPath('BILL_OF_LADING')}/versions/1/review`;
    return [
      {
        name: 'create a voyage',
        path: '/api/voyages',
        send: async () => createVoyageAs(s),
        succeeds: 201,
      },
      {
        name: 'set up a trade string',
        path: `/api/voyages/${s.unset.id}/trade-string`,
        send: async () =>
          api()
            .post(`/api/voyages/${s.unset.id}/trade-string`)
            .set('Cookie', s.exporter.operator.cookie)
            .send({
              parties: [
                { organizationId: s.exporter.organization.id },
                { organizationId: s.buyer.organization.id },
              ],
            }),
        succeeds: 200,
      },
      {
        name: 'issue a notice',
        path: `${s.voyagePath}/notices`,
        send: async () =>
          api()
            .post(`${s.voyagePath}/notices`)
            .set('Cookie', s.exporter.operator.cookie)
            .send(noticeBody(s.c1)),
        succeeds: 201,
      },
      {
        name: 'acknowledge a notice',
        path: `${s.voyagePath}/notices/${s.noticeId}/acknowledgement`,
        send: async () =>
          api()
            .post(`${s.voyagePath}/notices/${s.noticeId}/acknowledgement`)
            .set('Cookie', s.buyer.operator.cookie),
        succeeds: 200,
      },
      {
        name: 'upload a document',
        path: `${s.documentPath('CERTIFICATE_OF_ORIGIN')}/versions`,
        send: async () =>
          api()
            .post(`${s.documentPath('CERTIFICATE_OF_ORIGIN')}/versions`)
            .set('Cookie', s.exporter.operator.cookie)
            .set('If-None-Match', '*')
            .attach('file', pdf(), {
              filename: 'certificate-of-origin.pdf',
              contentType: 'application/pdf',
            }),
        succeeds: 201,
      },
      {
        name: 'review a document',
        path: reviewPath,
        send: async () =>
          api()
            .post(reviewPath)
            .set('Cookie', s.buyer.operator.cookie)
            .set('If-Match', await billOfLadingTag(s))
            .send({ decision: 'APPROVED' }),
        succeeds: 200,
      },
      {
        name: 'acknowledge instructions',
        path: `${s.instructionPath}/revisions/1/acknowledgement`,
        send: async () =>
          api()
            .post(`${s.instructionPath}/revisions/1/acknowledgement`)
            .set('Cookie', s.exporter.operator.cookie)
            .set('If-Match', await instructionTag(s))
            .send({}),
        succeeds: 200,
      },
      {
        name: 'revise instructions',
        path: s.instructionPath,
        send: async () =>
          api()
            .put(s.instructionPath)
            .set('Cookie', s.buyer.operator.cookie)
            .set('If-Match', await instructionTag(s))
            .send(secondContent),
        succeeds: 200,
      },
    ];
  }

  function expectExhausted(response: request.Response, path: string): void {
    expect(response.status).toBe(429);
    expect(response.headers['content-type']).toContain(PROBLEM_CONTENT_TYPE);
    // Waiting does not help, so no retry time is given.
    expect(response.headers['retry-after']).toBeUndefined();
    expect(response.body).toEqual({
      type: ProblemTypes.DemoWriteBudgetExhausted,
      title: 'Demo change limit reached',
      status: 429,
      detail: DEMO_WRITE_BUDGET_EXHAUSTED,
      instance: path,
    });
  }

  it('admits commands up to the allowance, then refuses every business command, changing and storing nothing', async () => {
    const s = await scenario();
    await setAdmitted(ALLOWANCE - 1);

    await createVoyageAs(s).expect(201);
    expect(await admitted()).toBe(ALLOWANCE);
    expectExhausted(await createVoyageAs(s), '/api/voyages');

    const before = await rows();
    const storedBefore = await stored();
    events.reset();
    for (const command of businessCommands(s)) {
      expectExhausted(await command.send(), command.path);
    }
    expect(await rows()).toEqual(before);
    // Nothing staged, nothing promoted: the refused upload was never received.
    expect(await stored()).toEqual(storedBefore);
    expect(storedBefore.staging).toEqual([]);
    expect(events.published).toEqual([]);
    expect(await admitted()).toBe(ALLOWANCE);
  });

  it('refused only by the budget: with allowance left, the same eight commands succeed, each counted once', async () => {
    const s = await scenario();
    await setAdmitted(ALLOWANCE);
    const commands = businessCommands(s);
    for (const command of commands) expect((await command.send()).status).toBe(429);

    await setAdmitted(0);
    for (const command of commands) {
      const response = await command.send();
      expect(response.status, command.name).toBe(command.succeeds);
    }
    // Every business command is covered, and an upload is admitted once, not once per step.
    expect(await admitted()).toBe(commands.length);
    expect(await stored()).toMatchObject({ staging: [] });
    expect((await stored()).objects).toHaveLength(2);
  });

  it('keeps reads, downloads, live updates, sign-out and sign-in working once the allowance is used up', async () => {
    const s = await scenario();
    await setAdmitted(ALLOWANCE);
    const cookie = s.buyer.operator.cookie;
    const read = (path: string) => api().get(path).set('Cookie', cookie).expect(200);

    await read('/api/voyages');
    await read(s.voyagePath);
    await read(`${s.voyagePath}/trade-string`);
    await read(`${s.voyagePath}/my-contracts`);
    await read(`${s.voyagePath}/notices`);
    await read(`${s.voyagePath}/documentary-instructions`);
    await read(s.instructionPath);
    await read(`${s.voyagePath}/documents`);
    await read(`${s.voyagePath}/timeline`);
    await read('/api/action-items');
    await read('/api/vessels');
    await read('/api/organizations?search=Exp');
    const download = await api()
      .get(`${s.documentPath('BILL_OF_LADING')}/versions/1/content`)
      .set('Cookie', cookie)
      .buffer(true)
      .parse(asBytes)
      .expect(200);
    expect(sha256(download.body as Buffer)).toBe(sha256(s.billOfLading));

    const stream = await openEventStream(ctx.server, `${s.voyagePath}/events`, cookie);
    expect(stream.status).toBe(200);
    stream.close();

    await read('/api/auth/me');
    await api().post('/api/auth/sign-out').set('Cookie', cookie).expect(204);
    await api().get('/api/auth/me').set('Cookie', cookie).expect(401);
    const again = await signIn(ctx.server, s.buyer.operator.user.email);
    await api().get('/api/auth/me').set('Cookie', again).expect(200);
    expect(await admitted()).toBe(ALLOWANCE);
  });

  it('refuses unauthenticated, forbidden, invalid and stale commands as before, spending nothing, with or without allowance left', async () => {
    const s = await scenario();
    const reviewPath = `${s.documentPath('BILL_OF_LADING')}/versions`;
    const failures: { name: string; send: () => Promise<request.Response>; status: number }[] = [
      {
        name: 'create a voyage, signed out',
        send: async () => api().post('/api/voyages').send(voyageBody(s)),
        status: 401,
      },
      {
        name: 'create a voyage as a viewer',
        send: async () => createVoyageAs(s, s.exporter.viewer.cookie),
        status: 403,
      },
      {
        name: 'create a voyage with an invalid body',
        send: async () =>
          api()
            .post('/api/voyages')
            .set('Cookie', s.exporter.operator.cookie)
            .send({ ...voyageBody(s), quantity: { amount: '-1', unit: 'MT' } }),
        status: 400,
      },
      {
        name: 'set up the trade string of a voyage one takes no part in',
        send: async () =>
          api()
            .post(`/api/voyages/${s.unset.id}/trade-string`)
            .set('Cookie', s.outsider.operator.cookie)
            .send({
              parties: [
                { organizationId: s.outsider.organization.id },
                { organizationId: s.buyer.organization.id },
              ],
            }),
        status: 404,
      },
      {
        name: 'set up a trade string already set up',
        send: async () =>
          api()
            .post(`${s.voyagePath}/trade-string`)
            .set('Cookie', s.exporter.operator.cookie)
            .send({
              parties: [
                { organizationId: s.exporter.organization.id },
                { organizationId: s.buyer.organization.id },
              ],
            }),
        status: 409,
      },
      {
        name: 'issue a notice as the buyer',
        send: async () =>
          api()
            .post(`${s.voyagePath}/notices`)
            .set('Cookie', s.buyer.operator.cookie)
            .send(noticeBody(s.c1)),
        status: 403,
      },
      {
        name: 'issue a notice on a voyage one takes no part in',
        send: async () =>
          api()
            .post(`${s.voyagePath}/notices`)
            .set('Cookie', s.outsider.operator.cookie)
            .send(noticeBody(s.c1)),
        status: 404,
      },
      {
        name: 'acknowledge a notice as the seller',
        send: async () =>
          api()
            .post(`${s.voyagePath}/notices/${s.noticeId}/acknowledgement`)
            .set('Cookie', s.exporter.operator.cookie),
        status: 403,
      },
      {
        name: 'acknowledge a notice already acknowledged',
        send: async () =>
          api()
            .post(`${s.voyagePath}/notices/${s.acknowledgedNoticeId}/acknowledgement`)
            .set('Cookie', s.buyer.operator.cookie),
        status: 409,
      },
      {
        name: 'give instructions that already exist',
        send: async () =>
          api()
            .put(s.instructionPath)
            .set('Cookie', s.buyer.operator.cookie)
            .set('If-None-Match', '*')
            .send(secondContent),
        status: 412,
      },
      {
        name: 'revise instructions on a stale version',
        send: async () =>
          api()
            .put(s.instructionPath)
            .set('Cookie', s.buyer.operator.cookie)
            .set('If-Match', '"999"')
            .send(secondContent),
        status: 412,
      },
      {
        name: 'revise instructions without a precondition',
        send: async () =>
          api().put(s.instructionPath).set('Cookie', s.buyer.operator.cookie).send(secondContent),
        status: 428,
      },
      {
        name: 'acknowledge instructions on a stale version',
        send: async () =>
          api()
            .post(`${s.instructionPath}/revisions/1/acknowledgement`)
            .set('Cookie', s.exporter.operator.cookie)
            .set('If-Match', '"999"')
            .send({}),
        status: 412,
      },
      {
        name: 'acknowledge instructions as the buyer',
        send: async () =>
          api()
            .post(`${s.instructionPath}/revisions/1/acknowledgement`)
            .set('Cookie', s.buyer.operator.cookie)
            .set('If-Match', await instructionTag(s))
            .send({}),
        status: 403,
      },
      {
        name: 'upload a first version of a document that has one',
        send: async () =>
          api()
            .post(`${s.documentPath('BILL_OF_LADING')}/versions`)
            .set('Cookie', s.exporter.operator.cookie)
            .set('If-None-Match', '*')
            .attach('file', pdf(), { filename: 'b.pdf', contentType: 'application/pdf' }),
        status: 412,
      },
      {
        name: 'upload as a viewer',
        send: async () =>
          api()
            .post(`${s.documentPath('CERTIFICATE_OF_ORIGIN')}/versions`)
            .set('Cookie', s.exporter.viewer.cookie)
            .set('If-None-Match', '*')
            .attach('file', pdf(), { filename: 'c.pdf', contentType: 'application/pdf' }),
        status: 403,
      },
      {
        name: 'upload a document type the revision does not require',
        send: async () =>
          api()
            .post(`${s.documentPath('COMMERCIAL_INVOICE')}/versions`)
            .set('Cookie', s.exporter.operator.cookie)
            .set('If-None-Match', '*')
            .attach('file', pdf(), { filename: 'i.pdf', contentType: 'application/pdf' }),
        status: 404,
      },
      {
        name: 'review on a stale version',
        send: async () =>
          api()
            .post(`${reviewPath}/1/review`)
            .set('Cookie', s.buyer.operator.cookie)
            .set('If-Match', '"999"')
            .send({ decision: 'APPROVED' }),
        status: 412,
      },
      {
        name: 'review as the seller',
        send: async () =>
          api()
            .post(`${reviewPath}/1/review`)
            .set('Cookie', s.exporter.operator.cookie)
            .set('If-Match', await billOfLadingTag(s))
            .send({ decision: 'APPROVED' }),
        status: 403,
      },
      {
        name: 'review a file version that does not exist',
        send: async () =>
          api()
            .post(`${reviewPath}/2/review`)
            .set('Cookie', s.buyer.operator.cookie)
            .set('If-Match', await billOfLadingTag(s))
            .send({ decision: 'APPROVED' }),
        status: 404,
      },
    ];

    const before = await rows();
    const storedBefore = await stored();
    for (const count of [0, ALLOWANCE - 1, ALLOWANCE]) {
      await setAdmitted(count);
      for (const failure of failures) {
        const response = await failure.send();
        expect(response.status, `${failure.name} (count ${count})`).toBe(failure.status);
      }
      expect(await admitted()).toBe(count);
    }
    expect(await rows()).toEqual(before);
    expect(await stored()).toEqual(storedBefore);
    expect(events.published).toEqual([]);
  });

  it('never admits concurrent final commands past the allowance', async () => {
    const s = await scenario();
    await setAdmitted(ALLOWANCE - 1);
    const voyagesBefore = await ctx.prisma.voyage.count();

    // Every competitor reaches the counter while it is locked, then all go at once.
    const held = await holdLock(
      ctx.prisma,
      (tx) => tx.$queryRaw`SELECT admitted FROM demo_write_budget WHERE id = 1 FOR UPDATE`,
    );
    const competitors = 6;
    const responses = Promise.all(
      Array.from({ length: competitors }, () => createVoyageAs(s).then((response) => response)),
    );
    await waitForLockWaiters(ctx.prisma, competitors);
    await held.release();

    const statuses = (await responses).map(({ status }) => status).sort();
    expect(statuses).toEqual([201, 429, 429, 429, 429, 429]);
    expect(await ctx.prisma.voyage.count()).toBe(voyagesBefore + 1);
    expect(await admitted()).toBe(ALLOWANCE);
  });

  it('admits the first commands on a fresh dataset atomically too', async () => {
    const s = await scenario();
    const single = await createTestApp({ config: protectedConfig(1), storage, eventBus: events });
    try {
      const send = () =>
        request(single.server)
          .post('/api/voyages')
          .set('Cookie', s.exporter.operator.cookie)
          .send(voyageBody(s))
          .then((response) => response.status);
      const statuses = (await Promise.all(Array.from({ length: 5 }, send))).sort();
      expect(statuses).toEqual([201, 429, 429, 429, 429]);
      expect(await admitted()).toBe(1);
    } finally {
      await single.app.close();
    }
  });

  it('keeps the count across an API restart against the same database', async () => {
    const s = await scenario();
    const voyagesBefore = await ctx.prisma.voyage.count();
    const create = (app: TestApp) =>
      request(app.server)
        .post('/api/voyages')
        .set('Cookie', s.exporter.operator.cookie)
        .send(voyageBody(s));

    const first = await createTestApp({ config: protectedConfig(3), storage, eventBus: events });
    try {
      for (let i = 0; i < 3; i += 1) await create(first).expect(201);
      expectExhausted(await create(first), '/api/voyages');
    } finally {
      await first.app.close();
    }

    const restarted = await createTestApp({
      config: protectedConfig(3),
      storage,
      eventBus: events,
    });
    try {
      expectExhausted(await create(restarted), '/api/voyages');
    } finally {
      await restarted.app.close();
    }
    // The count was kept: a larger allowance admits exactly the difference.
    const raised = await createTestApp({ config: protectedConfig(4), storage, eventBus: events });
    try {
      await create(raised).expect(201);
      expectExhausted(await create(raised), '/api/voyages');
    } finally {
      await raised.app.close();
    }
    expect(await admitted()).toBe(4);
    expect(await ctx.prisma.voyage.count()).toBe(voyagesBefore + 4);
  });

  it('does not refund an admitted command that fails afterwards', async () => {
    const s = await scenario();
    const before = await rows();

    await failAuditWrites(ctx.prisma, async () => {
      await createVoyageAs(s).expect(500);
    });
    expect(await admitted()).toBe(1);

    storage.failNext('stage');
    await api()
      .post(`${s.documentPath('CERTIFICATE_OF_ORIGIN')}/versions`)
      .set('Cookie', s.exporter.operator.cookie)
      .set('If-None-Match', '*')
      .attach('file', pdf(), { filename: 'c.pdf', contentType: 'application/pdf' })
      .expect(500);
    expect(await admitted()).toBe(2);
    expect(await rows()).toEqual(before);
  });

  it('fails closed when the budget cannot be checked: the command is refused, nothing written or stored', async () => {
    const s = await scenario();
    const before = await rows();
    const storedBefore = await stored();
    await ctx.prisma.$executeRawUnsafe(`
      CREATE FUNCTION test_budget_unavailable() RETURNS trigger LANGUAGE plpgsql
      AS $$ BEGIN RAISE EXCEPTION 'budget store unavailable'; END $$`);
    await ctx.prisma.$executeRawUnsafe(`
      CREATE TRIGGER test_budget_unavailable BEFORE INSERT OR UPDATE ON demo_write_budget
      FOR EACH ROW EXECUTE FUNCTION test_budget_unavailable()`);
    try {
      for (const command of businessCommands(s)) {
        const response = await command.send();
        expect(response.status, command.name).toBe(503);
        expect(response.body).toMatchObject({
          type: ProblemTypes.Generic,
          status: 503,
          detail: 'An unexpected error occurred.',
        });
        expect(JSON.stringify(response.body)).not.toMatch(/budget|store/i);
      }
    } finally {
      await ctx.prisma.$executeRawUnsafe(
        'DROP TRIGGER test_budget_unavailable ON demo_write_budget',
      );
      await ctx.prisma.$executeRawUnsafe('DROP FUNCTION test_budget_unavailable()');
    }
    expect(await rows()).toEqual(before);
    expect(await stored()).toEqual(storedBefore);
    expect(events.published).toEqual([]);
    expect(await admitted()).toBe(0);
  });

  describe('disabled (the default)', () => {
    let plain: TestApp;

    beforeAll(async () => {
      plain = await createTestApp({ storage, eventBus: events });
    });

    afterAll(async () => {
      await plain.app.close();
    });

    it('neither counts nor refuses business commands, even where a used-up count exists', async () => {
      const s = await scenario();
      const create = () =>
        request(plain.server)
          .post('/api/voyages')
          .set('Cookie', s.exporter.operator.cookie)
          .send(voyageBody(s));

      for (let i = 0; i < 3; i += 1) await create().expect(201);
      expect(await ctx.prisma.demoWriteBudget.count()).toBe(0);

      // As if this database had once run a protected demo with an allowance of 1.
      await setAdmitted(1);
      for (let i = 0; i < 3; i += 1) await create().expect(201);
      expect(await admitted()).toBe(1);
    });
  });
});
