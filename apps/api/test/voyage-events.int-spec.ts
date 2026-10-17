import {
  type IssueNoticeRequest,
  NoticeSchema,
  ProblemDetailsSchema,
  VoyageStreamMessageSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '../src/generated/prisma/client.js';
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
  });
});
