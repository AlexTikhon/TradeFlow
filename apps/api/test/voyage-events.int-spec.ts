import {
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
import { failAuditWrites, holdLock, waitForLockWaiters } from './support/concurrency.js';
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
  const bus = new TestEventBus();
  const streamOptions = { recheckIntervalMs: FAST_RECHECK_MS, maxPendingContracts: 32 };
  const opened: EventStream[] = [];
  const http = () => request(ctx.server);
  const streams = () => ctx.app.get(VoyageEventStreams);

  beforeAll(async () => {
    ctx = await createTestApp({ eventBus: bus, eventStreams: streamOptions });
  });

  afterAll(async () => {
    await ctx.app.close();
  });

  beforeEach(async () => {
    streamOptions.recheckIntervalMs = FAST_RECHECK_MS;
    bus.reset();
    await resetDatabase(ctx.prisma);
  });

  afterEach(async () => {
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
