import { createHash, randomBytes } from 'node:crypto';
import {
  ContractDocumentSchema,
  type DocumentaryInstructionContent,
  DocumentaryInstructionSchema,
  type IssueNoticeRequest,
  NoticeSchema,
  ProblemDetailsSchema,
  VoyageStreamMessageSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UserRole } from '../src/generated/prisma/client.js';
import { CounterpartyContracts } from '../src/modules/voyages/counterparty-contracts.js';
import { VoyageEventBus } from '../src/modules/voyages/voyage-event-bus.js';
import { VoyageEventStreams } from '../src/modules/voyages/voyage-event-streams.js';
import { sessionCookie, signIn } from './support/auth.js';
import {
  failAuditWrites,
  failCommitsWriting,
  holdLock,
  waitForLockWaiters,
} from './support/concurrency.js';
import {
  createOrganization,
  createReferenceData,
  createSession,
  createTradeString,
  createUser,
  createVoyage,
  resetDatabase,
} from './support/database.js';
import { TestEventBus } from './support/event-bus.js';
import { type EventStream, openEventStream } from './support/event-stream.js';
import { TestStorage } from './support/storage.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/*
 * Voyage event streams over real HTTP connections against PostgreSQL: the real application,
 * guards and services, with the test's own SSE client (`openEventStream`). Who receives what is
 * asserted on the bytes each connection received.
 *
 * Saying that a stream received nothing needs a point in time after which it would have. Two are
 * used. A stream that will receive a later signal is given one (a barrier): signals reach a
 * stream in the order they were published, so anything before the barrier would have arrived
 * first. A stream that can receive no signal at all waits for two heartbeats after the command
 * was answered: the change was published before the answer, and a heartbeat is only written
 * while the stream has no delivery in progress.
 */

const HOUR = 3_600_000;
const fromNow = (hours: number) => new Date(Date.now() + hours * HOUR);
const MISSING_ID = '01990000-0000-7000-8009-999999999999';

const READY = JSON.stringify({ type: 'READY' });
const ISSUED = JSON.stringify({ type: 'NOTICE_ISSUED' });
const ACKNOWLEDGED = JSON.stringify({ type: 'NOTICE_ACKNOWLEDGED' });
const REVISED = JSON.stringify({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
const DI_ACKNOWLEDGED = JSON.stringify({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
const UPLOADED = JSON.stringify({ type: 'DOCUMENT_VERSION_UPLOADED' });
const REVIEWED = JSON.stringify({ type: 'DOCUMENT_VERSION_REVIEWED' });

const firstContent: DocumentaryInstructionContent = {
  consignee: 'To order of Confidential Bank S.A.',
  notifyParty: 'Trader SA\nRue du Rhône 1, Geneva',
  requirements: [{ document: 'BILL_OF_LADING', originals: 3, copies: 3 }],
};

const secondContent: DocumentaryInstructionContent = {
  consignee: 'To order of Confidential Bank S.A.',
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 2 },
    { document: 'CERTIFICATE_OF_ORIGIN', originals: 1, copies: 1 },
  ],
};

/** Rechecks often, so idle streams notice an ended session and heartbeats serve as barriers. */
const FAST_RECHECK_MS = 100;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('Voyage event streams', () => {
  let ctx: TestApp;
  let storage: TestStorage;
  const bus = new TestEventBus();
  const streamOptions = { recheckIntervalMs: FAST_RECHECK_MS, maxPendingContracts: 32 };
  const opened: EventStream[] = [];
  const http = () => request(ctx.server);
  const streams = () => ctx.app.get(VoyageEventStreams);

  beforeAll(async () => {
    storage = await TestStorage.create();
    ctx = await createTestApp({ eventBus: bus, eventStreams: streamOptions, storage });
  });

  afterAll(async () => {
    await ctx.app.close();
    await storage.dispose();
  });

  beforeEach(async () => {
    streamOptions.recheckIntervalMs = FAST_RECHECK_MS;
    bus.reset();
    await resetDatabase(ctx.prisma);
    await storage.clear();
  });

  afterEach(async () => {
    storage.reset();
    for (const stream of opened.splice(0)) stream.close();
    // The server has let go of every stream (and stopped rechecking) before the next test.
    await until(() => streams().size === 0 && bus.listenerCount() === 0);
  });

  async function until(condition: () => boolean, timeoutMs = 3_000) {
    const deadline = Date.now() + timeoutMs;
    while (!condition()) {
      if (Date.now() > deadline) throw new Error('Condition not met in time');
      await sleep(10);
    }
  }

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
   * TF-E: Exporter → Trader (c1) → Buyer (c2), with a surveyor. TF-OTHER: Exporter → Buyer.
   * Outsider participates in nothing.
   */
  async function scenario() {
    const refs = await createReferenceData(ctx.prisma);
    const exporter = await anOrganization('Exporter Co', 'BR');
    const trader = await anOrganization('Trader SA', 'CH');
    const buyer = await anOrganization('Buyer GmbH', 'DE');
    const surveyor = await anOrganization('Survey BV');
    const outsider = await anOrganization('Outsider BV');
    const voyage = await createVoyage(ctx.prisma, refs, {
      reference: 'TF-E',
      participants: [
        { organizationId: exporter.organization.id, role: 'EXPORTER' },
        { organizationId: trader.organization.id, role: 'TRADER' },
        { organizationId: buyer.organization.id, role: 'FINAL_BUYER' },
        { organizationId: surveyor.organization.id, role: 'SURVEYOR' },
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
      outsider,
      c1: await contractAt(voyage.id, 1),
      c2: await contractAt(voyage.id, 2),
      d1: await contractAt(other.id, 1),
    };
  }

  const eventsPath = (voyageId: string) => `/api/voyages/${voyageId}/events`;
  const noticesPath = (voyageId: string) => `/api/voyages/${voyageId}/notices`;

  /** Opens a stream that the test closes afterwards, whatever happens. */
  async function connect(cookie: string | undefined, voyageId: string) {
    const stream = await openEventStream(ctx.server, eventsPath(voyageId), cookie);
    opened.push(stream);
    return stream;
  }

  /** Opens a stream and waits for READY: from then on, every change is signalled. */
  async function listen(cookie: string, voyageId: string) {
    const stream = await connect(cookie, voyageId);
    expect(stream.status).toBe(200);
    expect(await stream.next()).toEqual({ type: 'READY' });
    return stream;
  }

  const etaRequest = (contractId: string): IssueNoticeRequest => ({
    contractId,
    estimatedArrivalAt: fromNow(96).toISOString(),
    acknowledgementDueAt: fromNow(24).toISOString(),
    message: 'Confidential: vessel delayed by the charterer.',
  });

  const issue = (cookie: string, voyageId: string, contractId: string) =>
    http().post(noticesPath(voyageId)).set('Cookie', cookie).send(etaRequest(contractId));

  async function issued(cookie: string, voyageId: string, contractId: string) {
    return NoticeSchema.parse((await issue(cookie, voyageId, contractId).expect(201)).body);
  }

  const acknowledge = (cookie: string, voyageId: string, noticeId: string) =>
    http()
      .post(`${noticesPath(voyageId)}/${noticeId}/acknowledgement`)
      .set('Cookie', cookie);

  /** Waits until a stream that can receive no signal is past every delivery started so far. */
  async function settled(stream: EventStream) {
    await stream.comment(stream.comments.length + 2);
  }

  const instructionPath = (voyageId: string, contractId: string) =>
    `/api/voyages/${voyageId}/contracts/${contractId}/documentary-instructions`;

  const putInstruction = (
    cookie: string,
    voyageId: string,
    contractId: string,
    body: unknown,
    headers: Record<string, string>,
  ) =>
    http()
      .put(instructionPath(voyageId, contractId))
      .set('Cookie', cookie)
      .set(headers)
      .send(body as object);

  /** The first instructions under `contractId` (If-None-Match: *). */
  const give = (cookie: string, voyageId: string, contractId: string, body = firstContent) =>
    putInstruction(cookie, voyageId, contractId, body, { 'If-None-Match': '*' });

  /** The next revision, based on `version` (If-Match). */
  const revise = (
    cookie: string,
    voyageId: string,
    contractId: string,
    version: number,
    body: unknown = secondContent,
  ) => putInstruction(cookie, voyageId, contractId, body, { 'If-Match': `"${version}"` });

  /** Acknowledges revision `revision` as read at `version`; no If-Match when it is omitted. */
  const acknowledgeRevision = (
    cookie: string,
    voyageId: string,
    contractId: string,
    revision: number,
    version?: number,
  ) => {
    const call = http()
      .post(`${instructionPath(voyageId, contractId)}/revisions/${revision}/acknowledgement`)
      .set('Cookie', cookie);
    return version === undefined ? call : call.set('If-Match', `"${version}"`);
  };

  async function given(cookie: string, voyageId: string, contractId: string) {
    const response = await give(cookie, voyageId, contractId).expect(201);
    return DocumentaryInstructionSchema.parse(response.body);
  }

  const instructionWrites = async () => ({
    instructions: await ctx.prisma.documentaryInstruction.count(),
    revisions: await ctx.prisma.documentaryInstructionRevision.count(),
    acknowledgements: await ctx.prisma.documentaryInstructionAcknowledgement.count(),
    auditEvents: await ctx.prisma.auditEvent.count(),
  });

  describe('opening a stream', () => {
    it('streams to a participant: event-stream headers, then READY', async () => {
      const s = await scenario();
      const stream = await connect(s.surveyor.viewer.cookie, s.voyage.id);

      expect(stream.status).toBe(200);
      expect(stream.headers['content-type']).toBe('text/event-stream; charset=utf-8');
      expect(stream.headers['cache-control']).toBe('no-store');
      expect(stream.headers['x-accel-buffering']).toBe('no');
      expect(VoyageStreamMessageSchema.parse(await stream.next())).toEqual({ type: 'READY' });
    });

    it('answers 401 without a session, and with an ended one', async () => {
      const s = await scenario();
      const anonymous = await connect(undefined, s.voyage.id);
      expect(anonymous.status).toBe(401);
      expect(ProblemDetailsSchema.parse(anonymous.problem).status).toBe(401);

      await http().post('/api/auth/sign-out').set('Cookie', s.exporter.viewer.cookie).expect(204);
      expect((await connect(s.exporter.viewer.cookie, s.voyage.id)).status).toBe(401);
    });

    it('answers outsiders exactly as for a voyage that does not exist', async () => {
      const s = await scenario();
      const outsider = await connect(s.outsider.operator.cookie, s.voyage.id);
      const missing = await connect(s.exporter.operator.cookie, MISSING_ID);

      expect(outsider.status).toBe(404);
      expect(missing.status).toBe(404);
      const withoutInstance = (body: unknown) => {
        const { instance: _instance, ...problem } = ProblemDetailsSchema.parse(body);
        return problem;
      };
      expect(withoutInstance(outsider.problem)).toEqual(withoutInstance(missing.problem));
      expect(streams().size).toBe(0);
    });

    it('refuses a malformed voyage id', async () => {
      await scenario();
      const stream = await connect((await anOrganization('Someone')).viewer.cookie, 'not-a-uuid');
      expect(stream.status).toBe(400);
    });
  });

  describe('who is told', () => {
    it("tells only the contract's counterparties, and only the type of change", async () => {
      const s = await scenario();
      const sellerOperator = await listen(s.exporter.operator.cookie, s.voyage.id);
      const sellerViewer = await listen(s.exporter.viewer.cookie, s.voyage.id);
      // The trader buys under c1 and sells under c2.
      const buyerViewer = await listen(s.trader.viewer.cookie, s.voyage.id);
      // A party to c2 only, a service provider, and both parties to a contract on another
      // voyage.
      const nextBuyer = await listen(s.buyer.viewer.cookie, s.voyage.id);
      const surveyor = await listen(s.surveyor.viewer.cookie, s.voyage.id);
      const exporterElsewhere = await listen(s.exporter.viewer.cookie, s.other.id);
      const buyerElsewhere = await listen(s.buyer.viewer.cookie, s.other.id);

      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      for (const stream of [sellerOperator, sellerViewer, buyerViewer]) {
        expect(await stream.next()).toEqual({ type: 'NOTICE_ISSUED' });
      }
      await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(200);
      for (const stream of [sellerOperator, sellerViewer, buyerViewer]) {
        expect(await stream.next()).toEqual({ type: 'NOTICE_ACKNOWLEDGED' });
      }

      // Barriers: a notice under c2 reaches both its parties, one under d1 both parties there.
      await issued(s.trader.operator.cookie, s.voyage.id, s.c2);
      await issued(s.exporter.operator.cookie, s.other.id, s.d1);
      for (const stream of [nextBuyer, buyerViewer, exporterElsewhere, buyerElsewhere]) {
        expect(await stream.next()).toEqual({ type: 'NOTICE_ISSUED' });
      }
      // And another notice under c1 for the exporter, who is no party to c2.
      await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      for (const stream of [sellerOperator, sellerViewer, buyerViewer]) {
        expect(await stream.next()).toEqual({ type: 'NOTICE_ISSUED' });
      }
      await settled(surveyor);

      expect(sellerOperator.data).toEqual([READY, ISSUED, ACKNOWLEDGED, ISSUED]);
      expect(sellerViewer.data).toEqual([READY, ISSUED, ACKNOWLEDGED, ISSUED]);
      expect(buyerViewer.data).toEqual([READY, ISSUED, ACKNOWLEDGED, ISSUED, ISSUED]);
      expect(nextBuyer.data).toEqual([READY, ISSUED]);
      expect(surveyor.data).toEqual([READY]);
      expect(exporterElsewhere.data).toEqual([READY, ISSUED]);
      expect(buyerElsewhere.data).toEqual([READY, ISSUED]);
      // Exactly the type: no ids, no message, no audit payload.
      for (const raw of buyerViewer.data) {
        expect(raw).not.toContain(notice.id);
        expect(raw).not.toContain(s.c1);
        expect(raw).not.toContain('Confidential');
      }
    });

    it('tells nobody about a refused command', async () => {
      const s = await scenario();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.operator.cookie, s.voyage.id);

      // A viewer (403), the buyer issuing (403), an invalid deadline (400), someone else's
      // contract (404).
      await issue(s.exporter.viewer.cookie, s.voyage.id, s.c1).expect(403);
      await issue(s.trader.operator.cookie, s.voyage.id, s.c1).expect(403);
      await http()
        .post(noticesPath(s.voyage.id))
        .set('Cookie', s.exporter.operator.cookie)
        .send({ ...etaRequest(s.c1), acknowledgementDueAt: fromNow(-1).toISOString() })
        .expect(400);
      await issue(s.exporter.operator.cookie, s.voyage.id, s.c2).expect(404);
      expect(bus.published).toEqual([]);

      await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      expect(await seller.next()).toEqual({ type: 'NOTICE_ISSUED' });
      expect(await buyer.next()).toEqual({ type: 'NOTICE_ISSUED' });
      expect(seller.data).toEqual([READY, ISSUED]);
      expect(buyer.data).toEqual([READY, ISSUED]);
    });
  });

  describe('after commit only', () => {
    it('signals nothing when the issue rolls back', async () => {
      const s = await scenario();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.viewer.cookie, s.voyage.id);

      await failAuditWrites(ctx.prisma, async () => {
        await issue(s.exporter.operator.cookie, s.voyage.id, s.c1).expect(500);
      });
      expect(await ctx.prisma.notice.count()).toBe(0);
      expect(bus.published).toEqual([]);

      // The barrier: the next change is the first either stream hears of.
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      expect(await seller.next()).toEqual({ type: 'NOTICE_ISSUED' });
      expect(await buyer.next()).toEqual({ type: 'NOTICE_ISSUED' });

      await failAuditWrites(ctx.prisma, async () => {
        await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(500);
      });
      await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id).expect(200);
      expect(await seller.next()).toEqual({ type: 'NOTICE_ACKNOWLEDGED' });
      expect(await buyer.next()).toEqual({ type: 'NOTICE_ACKNOWLEDGED' });

      expect(seller.data).toEqual([READY, ISSUED, ACKNOWLEDGED]);
      expect(buyer.data).toEqual([READY, ISSUED, ACKNOWLEDGED]);
      expect(bus.published.map(({ type }) => type)).toEqual([
        'NOTICE_ISSUED',
        'NOTICE_ACKNOWLEDGED',
      ]);
    });

    it('signals one acknowledgement when two race', async () => {
      const s = await scenario();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      const colleague = await createUser(ctx.prisma, s.trader.organization.id, {
        role: 'OPERATOR',
      });
      const colleagueCookie = await signIn(ctx.server, colleague.email);
      const seller = await listen(s.exporter.viewer.cookie, s.voyage.id);
      const buyer = await listen(s.trader.viewer.cookie, s.voyage.id);

      // Both requests pass every check and queue on the conditional update.
      const lock = await holdLock(
        ctx.prisma,
        (tx) => tx.$queryRaw`SELECT id FROM notices WHERE id = ${notice.id}::uuid FOR UPDATE`,
      );
      const responses = Promise.all(
        [s.trader.operator.cookie, colleagueCookie].map((cookie) =>
          acknowledge(cookie, s.voyage.id, notice.id).then((response) => response.status),
        ),
      );
      await waitForLockWaiters(ctx.prisma, 2);
      await lock.release();
      expect((await responses).sort()).toEqual([200, 409]);

      // The barrier: a second notice.
      await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      for (const stream of [seller, buyer]) {
        expect(await stream.next()).toEqual({ type: 'NOTICE_ACKNOWLEDGED' });
        expect(await stream.next()).toEqual({ type: 'NOTICE_ISSUED' });
        expect(stream.data).toEqual([READY, ACKNOWLEDGED, ISSUED]);
      }
      expect(bus.published.map(({ type }) => type)).toEqual([
        'NOTICE_ISSUED',
        'NOTICE_ACKNOWLEDGED',
        'NOTICE_ISSUED',
      ]);
    });

    it('keeps a committed command successful when the notification fails', async () => {
      const s = await scenario();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.operator.cookie, s.voyage.id);

      bus.failNext();
      const notice = await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      expect(await ctx.prisma.notice.findUnique({ where: { id: notice.id } })).not.toBeNull();
      expect(await ctx.prisma.auditEvent.count({ where: { action: 'NOTICE_ISSUED' } })).toBe(1);

      bus.failNext();
      const acknowledged = await acknowledge(s.trader.operator.cookie, s.voyage.id, notice.id)
        .expect(200)
        .then(({ body }) => NoticeSchema.parse(body));
      expect(acknowledged.status).toBe('ACKNOWLEDGED');
      expect(await ctx.prisma.auditEvent.count({ where: { action: 'NOTICE_ACKNOWLEDGED' } })).toBe(
        1,
      );

      // Nothing was signalled, and the streams are still open and working (the barrier).
      await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      expect(await seller.next()).toEqual({ type: 'NOTICE_ISSUED' });
      expect(await buyer.next()).toEqual({ type: 'NOTICE_ISSUED' });
      expect(seller.data).toEqual([READY, ISSUED]);
      expect(buyer.data).toEqual([READY, ISSUED]);
    });
  });

  describe('documentary instructions', () => {
    // Under c1 the exporter sells and the trader buys: the trader gives, the exporter acknowledges.

    it("tells only the contract's counterparties, and only the type of change", async () => {
      const s = await scenario();
      const sellerOperator = await listen(s.exporter.operator.cookie, s.voyage.id);
      const sellerViewer = await listen(s.exporter.viewer.cookie, s.voyage.id);
      const buyerViewer = await listen(s.trader.viewer.cookie, s.voyage.id);
      // A party to c2 only, a service provider, and a party to a contract on another voyage.
      const nextBuyer = await listen(s.buyer.viewer.cookie, s.voyage.id);
      const surveyor = await listen(s.surveyor.viewer.cookie, s.voyage.id);
      const exporterElsewhere = await listen(s.exporter.viewer.cookie, s.other.id);
      const c1Parties = [sellerOperator, sellerViewer, buyerViewer];

      const instruction = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      for (const stream of c1Parties) {
        expect(await stream.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      }
      await acknowledgeRevision(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(200);
      for (const stream of c1Parties) {
        expect(await stream.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
      }
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 2).expect(200);
      for (const stream of c1Parties) {
        expect(await stream.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      }

      // Barriers: instructions under c2 reach both its parties, under d1 both parties there.
      await given(s.buyer.operator.cookie, s.voyage.id, s.c2);
      await given(s.buyer.operator.cookie, s.other.id, s.d1);
      for (const stream of [nextBuyer, buyerViewer, exporterElsewhere]) {
        expect(await stream.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      }
      await settled(surveyor);
      await settled(sellerOperator);

      expect(sellerOperator.data).toEqual([READY, REVISED, DI_ACKNOWLEDGED, REVISED]);
      expect(sellerViewer.data).toEqual([READY, REVISED, DI_ACKNOWLEDGED, REVISED]);
      expect(buyerViewer.data).toEqual([READY, REVISED, DI_ACKNOWLEDGED, REVISED, REVISED]);
      expect(nextBuyer.data).toEqual([READY, REVISED]);
      expect(surveyor.data).toEqual([READY]);
      expect(exporterElsewhere.data).toEqual([READY, REVISED]);
      // Exactly the type: no ids, no version, no contents.
      for (const raw of buyerViewer.data) {
        expect(Object.keys(JSON.parse(raw) as object)).toEqual(['type']);
        expect(raw).not.toContain(instruction.id);
        expect(raw).not.toContain(s.c1);
        expect(raw).not.toContain('Confidential');
      }
    });

    it('tells nobody about a refused or failed-precondition command', async () => {
      const s = await scenario();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.operator.cookie, s.voyage.id);
      const { cookie: buyerCookie } = s.trader.operator;
      const { cookie: sellerCookie } = s.exporter.operator;
      const bothHear = async (type: string) => {
        for (const stream of [seller, buyer]) expect(await stream.next()).toEqual({ type });
      };

      // The seller giving (403), a viewer of the buyer (403), no precondition (428), invalid
      // content (400), someone else's contract (404), and a revision of nothing (412).
      await give(sellerCookie, s.voyage.id, s.c1).expect(403);
      await give(s.trader.viewer.cookie, s.voyage.id, s.c1).expect(403);
      await putInstruction(buyerCookie, s.voyage.id, s.c1, firstContent, {}).expect(428);
      await give(buyerCookie, s.voyage.id, s.c1, { ...firstContent, requirements: [] }).expect(400);
      await give(sellerCookie, s.voyage.id, s.c2).expect(404);
      await revise(buyerCookie, s.voyage.id, s.c1, 1).expect(412);
      expect(bus.published).toEqual([]);

      await given(buyerCookie, s.voyage.id, s.c1);
      await bothHear('DOCUMENTARY_INSTRUCTION_REVISED');

      // A second creation (412), a stale If-Match (412), a revision that changes nothing (400);
      // an acknowledgement without If-Match (428), at a stale version (412), by the buyer (403),
      // of a revision that does not exist (404).
      await give(buyerCookie, s.voyage.id, s.c1).expect(412);
      await revise(buyerCookie, s.voyage.id, s.c1, 7).expect(412);
      await revise(buyerCookie, s.voyage.id, s.c1, 1, firstContent).expect(400);
      await acknowledgeRevision(sellerCookie, s.voyage.id, s.c1, 1).expect(428);
      await acknowledgeRevision(sellerCookie, s.voyage.id, s.c1, 1, 7).expect(412);
      await acknowledgeRevision(buyerCookie, s.voyage.id, s.c1, 1, 1).expect(403);
      await acknowledgeRevision(sellerCookie, s.voyage.id, s.c1, 2, 1).expect(404);

      await acknowledgeRevision(sellerCookie, s.voyage.id, s.c1, 1, 1).expect(200);
      await bothHear('DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED');
      // Acknowledged once already (409); then superseded by revision 2 (409).
      await acknowledgeRevision(sellerCookie, s.voyage.id, s.c1, 1, 2).expect(409);
      await revise(buyerCookie, s.voyage.id, s.c1, 2).expect(200);
      await bothHear('DOCUMENTARY_INSTRUCTION_REVISED');
      await acknowledgeRevision(sellerCookie, s.voyage.id, s.c1, 1, 3).expect(409);

      // The barrier: one more change, after every refusal above.
      await acknowledgeRevision(sellerCookie, s.voyage.id, s.c1, 2, 3).expect(200);
      await bothHear('DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED');
      for (const stream of [seller, buyer]) {
        expect(stream.data).toEqual([READY, REVISED, DI_ACKNOWLEDGED, REVISED, DI_ACKNOWLEDGED]);
      }
      expect(bus.published.map(({ type }) => type)).toEqual([
        'DOCUMENTARY_INSTRUCTION_REVISED',
        'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
        'DOCUMENTARY_INSTRUCTION_REVISED',
        'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
      ]);
    });

    it('signals nothing when a write rolls back', async () => {
      const s = await scenario();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.viewer.cookie, s.voyage.id);

      await failAuditWrites(ctx.prisma, async () => {
        await give(s.trader.operator.cookie, s.voyage.id, s.c1).expect(500);
      });
      expect(await instructionWrites()).toEqual({
        instructions: 0,
        revisions: 0,
        acknowledgements: 0,
        auditEvents: 0,
      });
      expect(bus.published).toEqual([]);

      // The barrier: the next change is the first either stream hears of.
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      expect(await seller.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      expect(await buyer.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });

      await failAuditWrites(ctx.prisma, async () => {
        await acknowledgeRevision(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(500);
        await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).expect(500);
      });
      expect(await instructionWrites()).toEqual({
        instructions: 1,
        revisions: 1,
        acknowledgements: 0,
        auditEvents: 1,
      });
      await acknowledgeRevision(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(200);
      expect(await seller.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
      expect(await buyer.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });

      expect(seller.data).toEqual([READY, REVISED, DI_ACKNOWLEDGED]);
      expect(buyer.data).toEqual([READY, REVISED, DI_ACKNOWLEDGED]);
      expect(bus.published.map(({ type }) => type)).toEqual([
        'DOCUMENTARY_INSTRUCTION_REVISED',
        'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
      ]);
    });

    /** Holds the instruction row's lock until both requests are blocked on it, then releases. */
    async function race(instructionId: string, contenders: (() => PromiseLike<number>)[]) {
      const lock = await holdLock(
        ctx.prisma,
        (tx) =>
          tx.$queryRaw`SELECT id FROM documentary_instructions WHERE id = ${instructionId}::uuid FOR UPDATE`,
      );
      const statuses = Promise.all(contenders.map((send) => Promise.resolve(send())));
      await waitForLockWaiters(ctx.prisma, contenders.length);
      await lock.release();
      return (await statuses).sort();
    }

    it('signals one acknowledgement when two race', async () => {
      const s = await scenario();
      const instruction = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      const colleague = await createUser(ctx.prisma, s.exporter.organization.id, {
        role: 'OPERATOR',
      });
      const colleagueCookie = await signIn(ctx.server, colleague.email);
      const seller = await listen(s.exporter.viewer.cookie, s.voyage.id);
      const buyer = await listen(s.trader.viewer.cookie, s.voyage.id);

      const statuses = await race(
        instruction.id,
        [s.exporter.operator.cookie, colleagueCookie].map(
          (cookie) => () =>
            acknowledgeRevision(cookie, s.voyage.id, s.c1, 1, 1).then(({ status }) => status),
        ),
      );
      // The loser finds the version moved on.
      expect(statuses).toEqual([200, 412]);
      expect(await ctx.prisma.documentaryInstructionAcknowledgement.count()).toBe(1);

      // The barrier: a revision based on the acknowledged version.
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 2).expect(200);
      for (const stream of [seller, buyer]) {
        expect(await stream.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
        expect(await stream.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
        expect(stream.data).toEqual([READY, DI_ACKNOWLEDGED, REVISED]);
      }
      expect(bus.published.map(({ type }) => type)).toEqual([
        'DOCUMENTARY_INSTRUCTION_REVISED',
        'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
        'DOCUMENTARY_INSTRUCTION_REVISED',
      ]);
    });

    it('signals one revision when two revisions of the same version race', async () => {
      const s = await scenario();
      const instruction = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      const colleague = await createUser(ctx.prisma, s.trader.organization.id, {
        role: 'OPERATOR',
      });
      const colleagueCookie = await signIn(ctx.server, colleague.email);
      const seller = await listen(s.exporter.viewer.cookie, s.voyage.id);

      const statuses = await race(instruction.id, [
        () => revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).then(({ status }) => status),
        () =>
          revise(colleagueCookie, s.voyage.id, s.c1, 1, {
            ...secondContent,
            consignee: 'To order of Another Bank AG',
          }).then(({ status }) => status),
      ]);
      expect(statuses).toEqual([200, 412]);

      // The barrier: the seller acknowledges the winning revision.
      await acknowledgeRevision(s.exporter.operator.cookie, s.voyage.id, s.c1, 2, 2).expect(200);
      expect(await seller.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      expect(await seller.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
      expect(seller.data).toEqual([READY, REVISED, DI_ACKNOWLEDGED]);
    });

    it('keeps a committed command successful when the notification fails', async () => {
      const s = await scenario();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.operator.cookie, s.voyage.id);

      bus.failNext();
      const created = await give(s.trader.operator.cookie, s.voyage.id, s.c1).expect(201);
      expect(created.headers.etag).toBe('"1"');
      expect(DocumentaryInstructionSchema.parse(created.body).version).toBe(1);

      bus.failNext();
      const acknowledged = await acknowledgeRevision(
        s.exporter.operator.cookie,
        s.voyage.id,
        s.c1,
        1,
        1,
      ).expect(200);
      expect(
        DocumentaryInstructionSchema.parse(acknowledged.body).currentRevision.acknowledgement,
      ).not.toBeNull();

      bus.failNext();
      const revised = await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 2).expect(200);
      expect(revised.headers.etag).toBe('"3"');
      expect(await instructionWrites()).toEqual({
        instructions: 1,
        revisions: 2,
        acknowledgements: 1,
        auditEvents: 3,
      });

      // Nothing was signalled, and the streams are still open and working (the barrier).
      await acknowledgeRevision(s.exporter.operator.cookie, s.voyage.id, s.c1, 2, 3).expect(200);
      expect(await seller.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
      expect(await buyer.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
      expect(seller.data).toEqual([READY, DI_ACKNOWLEDGED]);
      expect(buyer.data).toEqual([READY, DI_ACKNOWLEDGED]);
    });
  });

  describe('documents and their reviews', () => {
    // Under c1 the exporter sells and the trader buys: the trader's instructions require a bill
    // of lading, the exporter presents it, and the trader approves or rejects each file.

    const REASON = 'Confidential: the consignee does not match the instructions.';
    const APPROVE = { decision: 'APPROVED' };
    const reject = () => ({ decision: 'REJECTED', reason: REASON });

    /** Bytes that start like a PDF, `size` bytes in all. */
    const pdf = (size = 16 * 1024) =>
      Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(size - 9)]);
    const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

    interface DocumentAt {
      voyageId: string;
      contractId: string;
      revision?: number;
      type?: string;
    }

    const versionsPath = ({
      voyageId,
      contractId,
      revision = 1,
      type = 'BILL_OF_LADING',
    }: DocumentAt) =>
      `${instructionPath(voyageId, contractId)}/revisions/${revision}/documents/${type}/versions`;

    interface UploadOptions {
      bytes?: Buffer;
      fileName?: string;
      /** The preconditions; the first version (If-None-Match: *) by default. */
      headers?: Record<string, string>;
    }

    /** A real multipart upload, as a browser's FormData would send it. */
    const upload = (
      cookie: string,
      at: DocumentAt,
      { bytes = pdf(), fileName = 'bill-of-lading.pdf', headers }: UploadOptions = {},
    ) =>
      http()
        .post(versionsPath(at))
        .set('Cookie', cookie)
        .set(headers ?? { 'If-None-Match': '*' })
        .attach('file', bytes, { filename: fileName, contentType: 'application/pdf' });

    /** A replacement of the latest file, based on document version `version` (If-Match). */
    const replace = (
      cookie: string,
      at: DocumentAt,
      version: number,
      options: UploadOptions = {},
    ) =>
      upload(cookie, at, {
        fileName: 'bill-of-lading-v2.pdf',
        ...options,
        headers: { 'If-Match': `"${version}"` },
      });

    async function uploaded(cookie: string, at: DocumentAt, options?: UploadOptions) {
      return ContractDocumentSchema.parse((await upload(cookie, at, options).expect(201)).body);
    }

    /** A decision on file version `file`, based on document version `version`; null sends none. */
    const review = (
      cookie: string,
      at: DocumentAt,
      file: number,
      body: object,
      version: number | null,
    ) => {
      const call = http()
        .post(`${versionsPath(at)}/${file}/review`)
        .set('Cookie', cookie);
      return (version === null ? call : call.set('If-Match', `"${version}"`)).send(body);
    };

    /** The bytes of file version `file`, as the user of `cookie` downloads them. */
    const download = async (cookie: string, at: DocumentAt, file: number) =>
      (
        await http()
          .get(`${versionsPath(at)}/${file}/content`)
          .set('Cookie', cookie)
          .buffer(true)
          .parse((response, done) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
              done(null, Buffer.concat(chunks));
            });
          })
          .expect(200)
      ).body as Buffer;

    const documentWrites = async () => ({
      documents: await ctx.prisma.document.count(),
      versions: await ctx.prisma.documentVersion.count(),
      reviews: await ctx.prisma.documentReview.count(),
      auditEvents: await ctx.prisma.auditEvent.count({
        where: { action: { in: ['DOCUMENT_VERSION_UPLOADED', 'DOCUMENT_VERSION_REVIEWED'] } },
      }),
    });

    /** The storage keys document versions name, sorted like `storage.files('objects')`. */
    const keptObjects = async () =>
      (await ctx.prisma.documentVersion.findMany()).map(({ storageKey }) => storageKey).sort();

    /** The scenario with revision 1 under c1 given, and nothing published so far. */
    async function presenting() {
      const s = await scenario();
      const instruction = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      bus.reset();
      const bl: DocumentAt = { voyageId: s.voyage.id, contractId: s.c1 };
      return { ...s, instruction, bl };
    }

    /** Another operator of the organization, signed in. */
    async function colleagueOf(organizationId: string) {
      const user = await createUser(ctx.prisma, organizationId, { role: 'OPERATOR' });
      return signIn(ctx.server, user.email);
    }

    /**
     * Holds a row's lock and starts the contenders one after another, each blocked on the row
     * before the next starts, then lets them go together. Answers come back in contender order.
     *
     * Who wins depends on the lock the contenders wait for. Contenders that write the row itself
     * (a review or a replacement updates the document) queue for it, and PostgreSQL grants it in
     * that order, so the first contender wins. Contenders that only share-lock it (a first upload
     * share-locks the instruction) are all let through at once when it is released; the unique
     * document key then decides between them, in no particular order.
     */
    async function race(
      table: 'documentary_instructions' | 'documents',
      id: string,
      contenders: (() => request.Test)[],
    ) {
      const lock = await holdLock(ctx.prisma, (tx) =>
        tx.$queryRawUnsafe(`SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE`, id),
      );
      const answers: Promise<request.Response>[] = [];
      try {
        for (const [index, send] of contenders.entries()) {
          answers.push(send().then((answer) => answer));
          await waitForLockWaiters(ctx.prisma, index + 1);
        }
      } finally {
        await lock.release();
      }
      return (await Promise.all(answers)).map(({ status }) => status);
    }

    it("tells only the contract's counterparties, and only the type of change", async () => {
      const s = await presenting();
      const sellerOperator = await listen(s.exporter.operator.cookie, s.voyage.id);
      const sellerViewer = await listen(s.exporter.viewer.cookie, s.voyage.id);
      const buyerViewer = await listen(s.trader.viewer.cookie, s.voyage.id);
      // A party to c2 only, a service provider, and a party to a contract on another voyage.
      const nextBuyer = await listen(s.buyer.viewer.cookie, s.voyage.id);
      const surveyor = await listen(s.surveyor.viewer.cookie, s.voyage.id);
      const exporterElsewhere = await listen(s.exporter.viewer.cookie, s.other.id);
      const c1Parties = [sellerOperator, sellerViewer, buyerViewer];
      const c1PartiesHear = async (type: string) => {
        for (const stream of c1Parties) expect(await stream.next()).toEqual({ type });
      };

      const firstBytes = pdf();
      const secondBytes = pdf();
      const document = await uploaded(s.exporter.operator.cookie, s.bl, {
        bytes: firstBytes,
        fileName: 'confidential-bl.pdf',
      });
      await c1PartiesHear('DOCUMENT_VERSION_UPLOADED');
      await review(s.trader.operator.cookie, s.bl, 1, APPROVE, 1).expect(200);
      await c1PartiesHear('DOCUMENT_VERSION_REVIEWED');
      await replace(s.exporter.operator.cookie, s.bl, 2, {
        bytes: secondBytes,
        fileName: 'confidential-bl-v2.pdf',
      }).expect(201);
      await c1PartiesHear('DOCUMENT_VERSION_UPLOADED');
      await review(s.trader.operator.cookie, s.bl, 2, reject(), 3).expect(200);
      await c1PartiesHear('DOCUMENT_VERSION_REVIEWED');

      // Barriers: instructions under c2 reach both its parties, under d1 both parties there.
      await given(s.buyer.operator.cookie, s.voyage.id, s.c2);
      await given(s.buyer.operator.cookie, s.other.id, s.d1);
      for (const stream of [nextBuyer, buyerViewer, exporterElsewhere]) {
        expect(await stream.next()).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      }
      await settled(surveyor);
      await settled(sellerOperator);

      const c1Changes = [READY, UPLOADED, REVIEWED, UPLOADED, REVIEWED];
      expect(sellerOperator.data).toEqual(c1Changes);
      expect(sellerViewer.data).toEqual(c1Changes);
      expect(buyerViewer.data).toEqual([...c1Changes, REVISED]);
      expect(nextBuyer.data).toEqual([READY, REVISED]);
      expect(surveyor.data).toEqual([READY]);
      expect(exporterElsewhere.data).toEqual([READY, REVISED]);
      // Exactly the type: no ids, file names, checksums, storage keys or reasons.
      const storageKeys = await keptObjects();
      expect(storageKeys).toHaveLength(2);
      const secrets = [
        document.id,
        s.c1,
        s.instruction.id,
        'confidential-bl',
        sha256(firstBytes),
        sha256(secondBytes),
        REASON,
        ...storageKeys,
      ];
      for (const raw of [...sellerViewer.data, ...buyerViewer.data]) {
        expect(Object.keys(JSON.parse(raw) as object)).toEqual(['type']);
        for (const secret of secrets) expect(raw).not.toContain(secret);
      }
    });

    it('tells nobody about a refused or failed-precondition upload or review', async () => {
      const s = await presenting();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.operator.cookie, s.voyage.id);
      const { cookie: sellerCookie } = s.exporter.operator;
      const { cookie: buyerCookie } = s.trader.operator;
      const bothHear = async (type: string) => {
        for (const stream of [seller, buyer]) expect(await stream.next()).toEqual({ type });
      };

      // Uploads by a viewer of the seller or by the buyer (403), without a precondition (428),
      // replacing nothing (412), of a type or a revision the instructions do not require (404),
      // under someone else's contract (404), of a file that is not a PDF (415) or is empty (400).
      await upload(s.exporter.viewer.cookie, s.bl).expect(403);
      await upload(buyerCookie, s.bl).expect(403);
      await upload(sellerCookie, s.bl, { headers: {} }).expect(428);
      await replace(sellerCookie, s.bl, 1).expect(412);
      await upload(sellerCookie, { ...s.bl, type: 'CERTIFICATE_OF_ORIGIN' }).expect(404);
      await upload(sellerCookie, { ...s.bl, revision: 2 }).expect(404);
      await upload(sellerCookie, { ...s.bl, contractId: s.c2 }).expect(404);
      await upload(sellerCookie, s.bl, { bytes: Buffer.from('<html>not a PDF</html>') }).expect(
        415,
      );
      await upload(sellerCookie, s.bl, { bytes: Buffer.alloc(0) }).expect(400);
      expect(bus.published).toEqual([]);
      expect(await storage.files('objects')).toEqual([]);

      await uploaded(sellerCookie, s.bl);
      await bothHear('DOCUMENT_VERSION_UPLOADED');

      // A second first version and a stale replacement (412); reviews by the seller or a viewer
      // of the buyer (403), without If-Match (428), at a stale version (412), of a file version
      // that does not exist (404), and a rejection without its reason (400).
      await upload(sellerCookie, s.bl).expect(412);
      await replace(sellerCookie, s.bl, 7).expect(412);
      await review(sellerCookie, s.bl, 1, APPROVE, 1).expect(403);
      await review(s.trader.viewer.cookie, s.bl, 1, APPROVE, 1).expect(403);
      await review(buyerCookie, s.bl, 1, APPROVE, null).expect(428);
      await review(buyerCookie, s.bl, 1, APPROVE, 7).expect(412);
      await review(buyerCookie, s.bl, 2, APPROVE, 1).expect(404);
      await review(buyerCookie, s.bl, 1, { decision: 'REJECTED' }, 1).expect(400);

      await review(buyerCookie, s.bl, 1, APPROVE, 1).expect(200);
      await bothHear('DOCUMENT_VERSION_REVIEWED');
      // Decided once already (409); then replaced by version 2, so no longer the latest (409).
      await review(buyerCookie, s.bl, 1, reject(), 2).expect(409);
      await replace(sellerCookie, s.bl, 2).expect(201);
      await bothHear('DOCUMENT_VERSION_UPLOADED');
      await review(buyerCookie, s.bl, 1, reject(), 3).expect(409);

      // The barrier: one more change, after every refusal above.
      await review(buyerCookie, s.bl, 2, reject(), 3).expect(200);
      await bothHear('DOCUMENT_VERSION_REVIEWED');
      for (const stream of [seller, buyer]) {
        expect(stream.data).toEqual([READY, UPLOADED, REVIEWED, UPLOADED, REVIEWED]);
      }
      expect(bus.published.map(({ type }) => type)).toEqual([
        'DOCUMENT_VERSION_UPLOADED',
        'DOCUMENT_VERSION_REVIEWED',
        'DOCUMENT_VERSION_UPLOADED',
        'DOCUMENT_VERSION_REVIEWED',
      ]);
    });

    it('signals nothing when a write rolls back, or its commit has an unknown outcome', async () => {
      const s = await presenting();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.viewer.cookie, s.voyage.id);
      const { cookie: sellerCookie } = s.exporter.operator;
      const { cookie: buyerCookie } = s.trader.operator;
      const nothingWritten = { documents: 0, versions: 0, reviews: 0, auditEvents: 0 };

      // Rolled back: the audit event cannot be written, or the bytes cannot be kept. Either
      // way the upload's bytes are compensated.
      await failAuditWrites(ctx.prisma, async () => {
        await upload(sellerCookie, s.bl).expect(500);
      });
      storage.failNext('promote');
      await upload(sellerCookie, s.bl).expect(500);
      expect(await documentWrites()).toEqual(nothingWritten);
      expect(await storage.files('objects')).toEqual([]);
      // The commit fails once sent: the API cannot know it did not commit, so it keeps the
      // bytes for reconciliation, and announces nothing.
      await failCommitsWriting(ctx.prisma, 'document_versions', async () => {
        await upload(sellerCookie, s.bl).expect(500);
      });
      expect(await documentWrites()).toEqual(nothingWritten);
      expect(await storage.files('objects')).toHaveLength(1);
      expect(bus.published).toEqual([]);

      // The barrier: the next change is the first either stream hears of.
      await uploaded(sellerCookie, s.bl);
      expect(await seller.next()).toEqual({ type: 'DOCUMENT_VERSION_UPLOADED' });
      expect(await buyer.next()).toEqual({ type: 'DOCUMENT_VERSION_UPLOADED' });

      await failAuditWrites(ctx.prisma, async () => {
        await review(buyerCookie, s.bl, 1, APPROVE, 1).expect(500);
      });
      await failCommitsWriting(ctx.prisma, 'document_reviews', async () => {
        await review(buyerCookie, s.bl, 1, APPROVE, 1).expect(500);
      });
      expect(await documentWrites()).toEqual({
        documents: 1,
        versions: 1,
        reviews: 0,
        auditEvents: 1,
      });
      await review(buyerCookie, s.bl, 1, reject(), 1).expect(200);
      expect(await seller.next()).toEqual({ type: 'DOCUMENT_VERSION_REVIEWED' });
      expect(await buyer.next()).toEqual({ type: 'DOCUMENT_VERSION_REVIEWED' });

      expect(seller.data).toEqual([READY, UPLOADED, REVIEWED]);
      expect(buyer.data).toEqual([READY, UPLOADED, REVIEWED]);
      expect(bus.published.map(({ type }) => type)).toEqual([
        'DOCUMENT_VERSION_UPLOADED',
        'DOCUMENT_VERSION_REVIEWED',
      ]);
    });

    it('signals one upload when two first versions race', async () => {
      const s = await presenting();
      const colleague = await colleagueOf(s.exporter.organization.id);
      const seller = await listen(s.exporter.viewer.cookie, s.voyage.id);
      const buyer = await listen(s.trader.viewer.cookie, s.voyage.id);

      // Both have their bytes kept and wait for the revision's lock to commit. Both only
      // share-lock it, so either may win: which one is not part of what is tested.
      const statuses = await race('documentary_instructions', s.instruction.id, [
        () => upload(s.exporter.operator.cookie, s.bl),
        () => upload(colleague, s.bl),
      ]);
      expect([...statuses].sort()).toEqual([201, 412]);
      expect(await documentWrites()).toEqual({
        documents: 1,
        versions: 1,
        reviews: 0,
        auditEvents: 1,
      });
      // The loser's bytes were removed, whichever it was; publishing touched neither.
      const kept = await keptObjects();
      expect(kept).toHaveLength(1);
      expect(await storage.files('objects')).toEqual(kept);

      // The barrier: the buyer decides on the winning file.
      await review(s.trader.operator.cookie, s.bl, 1, APPROVE, 1).expect(200);
      for (const stream of [seller, buyer]) {
        expect(await stream.next()).toEqual({ type: 'DOCUMENT_VERSION_UPLOADED' });
        expect(await stream.next()).toEqual({ type: 'DOCUMENT_VERSION_REVIEWED' });
        expect(stream.data).toEqual([READY, UPLOADED, REVIEWED]);
      }
      expect(bus.published.map(({ type }) => type)).toEqual([
        'DOCUMENT_VERSION_UPLOADED',
        'DOCUMENT_VERSION_REVIEWED',
      ]);
    });

    it('signals one decision when two reviews of the same file race', async () => {
      const s = await presenting();
      const document = await uploaded(s.exporter.operator.cookie, s.bl);
      const colleague = await colleagueOf(s.trader.organization.id);
      const seller = await listen(s.exporter.viewer.cookie, s.voyage.id);
      const buyer = await listen(s.trader.viewer.cookie, s.voyage.id);

      const statuses = await race('documents', document.id, [
        () => review(s.trader.operator.cookie, s.bl, 1, APPROVE, 1),
        () => review(colleague, s.bl, 1, reject(), 1),
      ]);
      expect(statuses).toEqual([200, 412]);
      expect(await documentWrites()).toMatchObject({ reviews: 1 });

      // The barrier: a replacement based on the decision.
      await replace(s.exporter.operator.cookie, s.bl, 2).expect(201);
      for (const stream of [seller, buyer]) {
        expect(await stream.next()).toEqual({ type: 'DOCUMENT_VERSION_REVIEWED' });
        expect(await stream.next()).toEqual({ type: 'DOCUMENT_VERSION_UPLOADED' });
        expect(stream.data).toEqual([READY, REVIEWED, UPLOADED]);
      }
    });

    it.each(['review', 'replacement'] as const)(
      'signals only the winner when a review and a replacement race and the %s wins',
      async (winner) => {
        const s = await presenting();
        const document = await uploaded(s.exporter.operator.cookie, s.bl);
        const seller = await listen(s.exporter.viewer.cookie, s.voyage.id);
        const buyer = await listen(s.trader.viewer.cookie, s.voyage.id);
        bus.reset();

        // Both are based on version 1; whichever has the row first moves it to version 2.
        const decide = () => review(s.trader.operator.cookie, s.bl, 1, reject(), 1);
        const replaceIt = () => replace(s.exporter.operator.cookie, s.bl, 1);
        const statuses = await race(
          'documents',
          document.id,
          winner === 'review' ? [decide, replaceIt] : [replaceIt, decide],
        );
        expect(statuses).toEqual(winner === 'review' ? [200, 412] : [201, 412]);
        // A losing replacement's bytes were removed: every object kept is a version's.
        expect(await storage.files('objects')).toEqual(await keptObjects());

        // The barrier: the next change, based on the winner's version 2.
        if (winner === 'review') {
          await replace(s.exporter.operator.cookie, s.bl, 2).expect(201);
        } else {
          await review(s.trader.operator.cookie, s.bl, 2, APPROVE, 2).expect(200);
        }
        const signals = winner === 'review' ? [REVIEWED, UPLOADED] : [UPLOADED, REVIEWED];
        for (const stream of [seller, buyer]) {
          await stream.next();
          await stream.next();
          expect(stream.data).toEqual([READY, ...signals]);
        }
        expect(bus.published.map(({ type }) => JSON.stringify({ type }))).toEqual(signals);
      },
    );

    it('keeps a committed upload or review, and its file downloadable, when the notification fails', async () => {
      const s = await presenting();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const buyer = await listen(s.trader.operator.cookie, s.voyage.id);
      const { cookie: sellerCookie } = s.exporter.operator;
      const { cookie: buyerCookie } = s.trader.operator;
      const firstBytes = pdf();
      const secondBytes = pdf(40_000);

      bus.failNext();
      const created = await upload(sellerCookie, s.bl, { bytes: firstBytes }).expect(201);
      expect(created.headers.etag).toBe('"1"');
      expect(ContractDocumentSchema.parse(created.body).currentVersion.sha256).toBe(
        sha256(firstBytes),
      );

      bus.failNext();
      const approved = await review(buyerCookie, s.bl, 1, APPROVE, 1).expect(200);
      expect(approved.headers.etag).toBe('"2"');
      expect(ContractDocumentSchema.parse(approved.body).currentVersion.review?.decision).toBe(
        'APPROVED',
      );

      bus.failNext();
      const replaced = await replace(sellerCookie, s.bl, 2, { bytes: secondBytes }).expect(201);
      expect(replaced.headers.etag).toBe('"3"');
      expect(await documentWrites()).toEqual({
        documents: 1,
        versions: 2,
        reviews: 1,
        auditEvents: 3,
      });

      // Publishing failed after commit, outside the upload's compensation: both files are kept
      // under the keys their versions name, and both sides download exactly the bytes uploaded.
      expect(await storage.files('objects')).toEqual(await keptObjects());
      expect(await storage.files('objects')).toHaveLength(2);
      expect(await storage.files('staging')).toEqual([]);
      for (const cookie of [s.trader.viewer.cookie, s.exporter.viewer.cookie]) {
        expect(sha256(await download(cookie, s.bl, 1))).toBe(sha256(firstBytes));
        expect(sha256(await download(cookie, s.bl, 2))).toBe(sha256(secondBytes));
      }

      // Nothing was signalled, and the streams are still open and working (the barrier).
      await review(buyerCookie, s.bl, 2, reject(), 3).expect(200);
      expect(await seller.next()).toEqual({ type: 'DOCUMENT_VERSION_REVIEWED' });
      expect(await buyer.next()).toEqual({ type: 'DOCUMENT_VERSION_REVIEWED' });
      expect(seller.data).toEqual([READY, REVIEWED]);
      expect(buyer.data).toEqual([READY, REVIEWED]);
    });
  });

  describe('when the session or participation ends', () => {
    it('sends nothing to a revoked session, and closes its stream', async () => {
      // Rechecks too rare to matter: the delivery itself must notice.
      streamOptions.recheckIntervalMs = 60_000;
      const s = await scenario();
      const seller = await listen(s.exporter.operator.cookie, s.voyage.id);
      const revoked = await listen(s.trader.viewer.cookie, s.voyage.id);

      await http().post('/api/auth/sign-out').set('Cookie', s.trader.viewer.cookie).expect(204);
      await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);

      expect(await seller.next()).toEqual({ type: 'NOTICE_ISSUED' });
      await revoked.ended;
      expect(revoked.data).toEqual([READY]);
      await until(() => streams().size === 1);
    });

    it('closes an idle stream once its session is revoked, expires or changes organization', async () => {
      const s = await scenario();
      const kept = await listen(s.exporter.viewer.cookie, s.voyage.id);
      const revoked = await listen(s.trader.viewer.cookie, s.voyage.id);
      // A session about to run out.
      const expiring = await createSession(ctx.prisma, s.buyer.viewer.user.id, {
        createdAt: new Date(Date.now() - HOUR),
        expiresAt: new Date(Date.now() + 1_000),
      });
      const expired = await listen(sessionCookie(expiring), s.voyage.id);
      const moved = await listen(s.exporter.operator.cookie, s.voyage.id);

      await ctx.prisma.session.updateMany({
        where: { userId: s.trader.viewer.user.id },
        data: { revokedAt: new Date() },
      });
      await ctx.prisma.user.update({
        where: { id: s.exporter.operator.user.id },
        data: { organizationId: s.surveyor.organization.id },
      });

      // Within the recheck interval, without any change to deliver.
      await Promise.all([revoked.ended, expired.ended, moved.ended]);
      for (const stream of [revoked, expired, moved]) expect(stream.data).toEqual([READY]);
      // Heartbeats keep the stream that is still allowed open.
      await kept.comment(2);
      expect(kept.isEnded()).toBe(false);
    });

    it('closes a stream once its organization leaves the voyage', async () => {
      const s = await scenario();
      const surveyor = await listen(s.surveyor.viewer.cookie, s.voyage.id);

      await ctx.prisma.voyageParticipant.deleteMany({
        where: { voyageId: s.voyage.id, organizationId: s.surveyor.organization.id },
      });

      await surveyor.ended;
      expect(surveyor.data).toEqual([READY]);
      // And it cannot come back.
      expect((await connect(s.surveyor.viewer.cookie, s.voyage.id)).status).toBe(404);
    });
  });

  describe('cleanup', () => {
    it('lets go of a stream when its client disconnects', async () => {
      const s = await scenario();
      const leaving = await listen(s.exporter.viewer.cookie, s.voyage.id);
      const staying = await listen(s.trader.viewer.cookie, s.voyage.id);
      expect(streams().size).toBe(2);
      expect(bus.listenerCount(s.voyage.id)).toBe(2);

      leaving.close();
      await until(() => streams().size === 1 && bus.listenerCount(s.voyage.id) === 1);

      await issued(s.exporter.operator.cookie, s.voyage.id, s.c1);
      expect(await staying.next()).toEqual({ type: 'NOTICE_ISSUED' });

      staying.close();
      await until(() => streams().size === 0 && bus.listenerCount() === 0);
    });

    it('ends open streams when the application shuts down', async () => {
      const s = await scenario();
      const app = await createTestApp();
      const cookie = await signIn(app.server, s.trader.viewer.user.email);
      const stream = await openEventStream(app.server, eventsPath(s.voyage.id), cookie);
      opened.push(stream);
      expect(await stream.next()).toEqual({ type: 'READY' });

      await app.app.close();

      await stream.ended;
      expect(app.app.get(VoyageEventStreams).size).toBe(0);
    });

    it('answers a stream still being opened at shutdown, and opens nothing afterwards', async () => {
      const s = await scenario();
      // Recognisable among the timers the application starts.
      const recheckIntervalMs = 54_321;
      const app = await createTestApp({
        eventStreams: { recheckIntervalMs, maxPendingContracts: 32 },
      });
      const appStreams = app.app.get(VoyageEventStreams);
      const appBus = app.app.get(VoyageEventBus);
      const cookie = await signIn(app.server, s.trader.viewer.user.email);

      // The access check's result is held once its database read is done.
      const read = barrier();
      const release = barrier();
      const contracts = app.app.get(CounterpartyContracts);
      const listForVoyage = contracts.listForVoyage.bind(contracts);
      const check = vi.spyOn(contracts, 'listForVoyage').mockImplementation(async (...args) => {
        const result = await listForVoyage(...args);
        read.open();
        await release.passed;
        return result;
      });
      const destroyed = barrier();
      const onModuleDestroy = appStreams.onModuleDestroy.bind(appStreams);
      vi.spyOn(appStreams, 'onModuleDestroy').mockImplementation(() => {
        onModuleDestroy();
        destroyed.open();
      });
      const setInterval = vi.spyOn(globalThis, 'setInterval');

      try {
        const response = openEventStream(app.server, eventsPath(s.voyage.id), cookie);
        await read.passed;
        const closing = app.app.close();
        await destroyed.passed;

        // Answered and ended while the check is still held.
        const stream = await within(response, 'The opening stream was not answered');
        opened.push(stream);
        expect(stream.status).toBe(503);
        expect(ProblemDetailsSchema.parse(stream.problem).status).toBe(503);
        await within(stream.ended, 'The opening stream was not ended');
        expect(check).toHaveBeenCalledTimes(1);

        release.open();
        await check.mock.results[0]?.value;
        stream.close();
        await within(closing, 'The application did not close');

        expect(appStreams.size).toBe(0);
        expect(appBus.listenerCount()).toBe(0);
        expect(setInterval.mock.calls.filter(([, ms]) => ms === recheckIntervalMs)).toEqual([]);
      } finally {
        release.open();
        vi.restoreAllMocks();
      }
    });
  });
});

/** A point a test opens once; whatever awaits `passed` waits for it. */
function barrier() {
  let open: () => void = () => undefined;
  const passed = new Promise<void>((resolve) => (open = resolve));
  return { passed, open };
}

/** `promise`, or a failure naming what did not happen within `timeoutMs`. */
async function within<T>(promise: Promise<T>, what: string, timeoutMs = 3_000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          reject(new Error(`${what} within ${timeoutMs} ms`));
        }, timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}
