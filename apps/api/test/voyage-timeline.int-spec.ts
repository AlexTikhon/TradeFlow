import { randomBytes, randomUUID } from 'node:crypto';
import {
  type DocumentaryInstructionContent,
  NoticeSchema,
  ProblemDetailsSchema,
  ProblemTypes,
  type TimelineEvent,
  VoyageDetailSchema,
  type VoyageTimelinePage,
  VoyageTimelinePageSchema,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { AuditAction, Prisma, UserRole } from '../src/generated/prisma/client.js';
import { signIn } from './support/auth.js';
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

const MISSING_ID = '01990000-0000-7000-8008-999999999999';

const content: DocumentaryInstructionContent = {
  consignee: 'To order of Banco Confidencial S.A.',
  notifyParty: 'Secret Notify Party BV',
  requirements: [{ document: 'BILL_OF_LADING', originals: 3, copies: 3 }],
};
const REASON = 'The consignee on page 2 is confidential and wrong.';
const FILE_NAME = 'secret-bill-of-lading.pdf';
const NOTICE_MESSAGE = 'Private message to the trader only.';

/** Bytes that start like a PDF. */
const pdf = (size = 2048) =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(size - 9)]).subarray(0, size);

const fromNow = (hours: number) => new Date(Date.now() + hours * 3_600_000);

/** A problem without its `instance`, which names the request path. */
const withoutInstance = (body: unknown) => {
  const { instance: _instance, ...problem } = ProblemDetailsSchema.parse(body);
  return problem;
};

describe('Voyage timeline', () => {
  let ctx: TestApp;
  let storage: TestStorage;
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
  });

  afterEach(() => {
    storage.reset();
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
  type Party = Awaited<ReturnType<typeof anOrganization>>;

  /**
   * TF-T, created through the API by the exporter: Exporter → Trader (contract 1) → Buyer
   * (contract 2), with a surveyor and a shipping agent. TF-OTHER: Exporter → Buyer. Outsider
   * participates in nothing. No events beyond the creation yet.
   */
  async function scenario() {
    const refs = await createReferenceData(ctx.prisma);
    const exporter = await anOrganization('Exporter Co', 'BR');
    const trader = await anOrganization('Trader SA', 'CH');
    const buyer = await anOrganization('Buyer GmbH', 'DE');
    const surveyor = await anOrganization('Survey BV');
    const agent = await anOrganization('Agency Ltda', 'BR');
    const outsider = await anOrganization('Outsider BV');

    const created = VoyageDetailSchema.parse(
      (
        await api()
          .post('/api/voyages')
          .set('Cookie', exporter.operator.cookie)
          .send({
            vesselId: refs.vessel.id,
            commodityId: refs.commodity.id,
            quantity: { amount: '50000', unit: 'MT' },
            loadPortId: refs.loadPort.id,
            dischargePortId: refs.dischargePort.id,
            laycan: { start: '2026-11-01', end: '2026-11-10' },
          })
          .expect(201)
      ).body,
    );
    // Joining a voyage has no endpoint yet; the other parties are added as the seed adds them.
    await ctx.prisma.voyageParticipant.createMany({
      data: [
        { voyageId: created.id, organizationId: trader.organization.id, role: 'TRADER' },
        { voyageId: created.id, organizationId: buyer.organization.id, role: 'FINAL_BUYER' },
        { voyageId: created.id, organizationId: surveyor.organization.id, role: 'SURVEYOR' },
        { voyageId: created.id, organizationId: agent.organization.id, role: 'SHIPPING_AGENT' },
      ],
    });
    await createTradeString(ctx.prisma, created.id, [
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
      voyage: created,
      other,
      exporter,
      trader,
      buyer,
      surveyor,
      agent,
      outsider,
      c1: await contractAt(created.id, 1),
      c2: await contractAt(created.id, 2),
      d1: await contractAt(other.id, 1),
    };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const timelinePath = (voyageId: string) => `/api/voyages/${voyageId}/timeline`;

  const timeline = (cookie: string, voyageId: string, query: Record<string, string> = {}) =>
    api().get(timelinePath(voyageId)).query(query).set('Cookie', cookie);

  /** One page as the user of `cookie` reads it, checked against the shared contract. */
  async function pageAs(
    cookie: string,
    voyageId: string,
    query: Record<string, string> = {},
  ): Promise<VoyageTimelinePage> {
    const response = await timeline(cookie, voyageId, query).expect(200);
    return VoyageTimelinePageSchema.parse(response.body);
  }

  /** Every page, following cursors, as the user of `cookie` reads them. */
  async function allPagesAs(cookie: string, voyageId: string, limit: number) {
    const pages: VoyageTimelinePage[] = [];
    let cursor: string | null | undefined;
    do {
      const page = await pageAs(cookie, voyageId, {
        limit: String(limit),
        ...(cursor ? { cursor } : {}),
      });
      pages.push(page);
      cursor = page.nextCursor;
      if (pages.length > 50) throw new Error('The cursors do not end');
    } while (cursor);
    return pages;
  }

  const actions = (page: VoyageTimelinePage) => page.items.map(({ action }) => action);
  const decodeCursor = (cursor: string) =>
    JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;

  /** Runs every audited action through the API, under both contracts of TF-T. */
  async function everyAction(s: Scenario) {
    const etaRequest = (contractId: string) => ({
      contractId,
      estimatedArrivalAt: fromNow(96).toISOString(),
      acknowledgementDueAt: fromNow(24).toISOString(),
      message: NOTICE_MESSAGE,
    });
    const notice = NoticeSchema.parse(
      (
        await api()
          .post(`/api/voyages/${s.voyage.id}/notices`)
          .set('Cookie', s.exporter.operator.cookie)
          .send(etaRequest(s.c1))
          .expect(201)
      ).body,
    );
    await api()
      .post(`/api/voyages/${s.voyage.id}/notices/${notice.id}/acknowledgement`)
      .set('Cookie', s.trader.operator.cookie)
      .expect(200);

    const instructions = `/api/voyages/${s.voyage.id}/contracts/${s.c1}/documentary-instructions`;
    await api()
      .put(instructions)
      .set('Cookie', s.trader.operator.cookie)
      .set('If-None-Match', '*')
      .send(content)
      .expect(201);
    await api()
      .post(`${instructions}/revisions/1/acknowledgement`)
      .set('Cookie', s.exporter.operator.cookie)
      .set('If-Match', '"1"')
      .expect(200);

    const versions = `${instructions}/revisions/1/documents/BILL_OF_LADING/versions`;
    await api()
      .post(versions)
      .set('Cookie', s.exporter.operator.cookie)
      .set('If-None-Match', '*')
      .attach('file', pdf(), { filename: FILE_NAME, contentType: 'application/pdf' })
      .expect(201);
    await api()
      .post(`${versions}/1/review`)
      .set('Cookie', s.trader.operator.cookie)
      .set('If-Match', '"1"')
      .send({ decision: 'REJECTED', reason: REASON })
      .expect(200);

    // Under contract 2 the trader sells to the buyer.
    const second = NoticeSchema.parse(
      (
        await api()
          .post(`/api/voyages/${s.voyage.id}/notices`)
          .set('Cookie', s.trader.operator.cookie)
          .send(etaRequest(s.c2))
          .expect(201)
      ).body,
    );
    // And on the other voyage, the exporter sells to the buyer.
    await api()
      .post(`/api/voyages/${s.other.id}/notices`)
      .set('Cookie', s.exporter.operator.cookie)
      .send(etaRequest(s.d1))
      .expect(201);

    const stored = async (action: AuditAction) =>
      ctx.prisma.auditEvent.findFirstOrThrow({
        where: { voyageId: s.voyage.id, action },
        select: { payload: true },
      });
    const documentPayload = (await stored('DOCUMENT_VERSION_UPLOADED')).payload as {
      documentId: string;
      sha256: string;
    };
    const instructionPayload = (await stored('DOCUMENTARY_INSTRUCTION_REVISED')).payload as {
      instructionId: string;
    };
    return {
      noticeId: notice.id,
      secondNoticeId: second.id,
      documentId: documentPayload.documentId,
      sha256: documentPayload.sha256,
      instructionId: instructionPayload.instructionId,
    };
  }

  /**
   * Inserts events directly, for timings the API cannot produce on demand (equal times) and
   * for histories it no longer writes (uploads without a version). Same constraints apply.
   */
  async function insertEvents(
    s: Scenario,
    events: {
      action: AuditAction;
      occurredAt: Date;
      payload: Prisma.InputJsonObject;
      actor?: Party;
    }[],
  ) {
    for (const event of events) {
      const actor = event.actor ?? s.exporter;
      await ctx.prisma.auditEvent.create({
        data: {
          action: event.action,
          actorUserId: actor.operator.user.id,
          actorOrganizationId: actor.organization.id,
          voyageId: s.voyage.id,
          occurredAt: event.occurredAt,
          payload: event.payload,
        },
      });
    }
  }

  const noticeEvent = (contractId: string, occurredAt: Date, actor?: Party) => ({
    action: 'NOTICE_ISSUED' as const,
    occurredAt,
    payload: { noticeId: randomUUID(), contractId },
    ...(actor && { actor }),
  });

  describe('who sees which events', () => {
    it('shows each counterparty the events under its own contracts, newest first', async () => {
      const s = await scenario();
      const ids = await everyAction(s);

      const exporterView = await pageAs(s.exporter.operator.cookie, s.voyage.id);
      expect(actions(exporterView)).toEqual([
        'DOCUMENT_VERSION_REVIEWED',
        'DOCUMENT_VERSION_UPLOADED',
        'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
        'DOCUMENTARY_INSTRUCTION_REVISED',
        'NOTICE_ACKNOWLEDGED',
        'NOTICE_ISSUED',
        'VOYAGE_CREATED',
      ]);
      expect(exporterView.nextCursor).toBeNull();

      // The trader is a party to both contracts.
      const traderView = await pageAs(s.trader.operator.cookie, s.voyage.id);
      expect(actions(traderView)).toEqual(['NOTICE_ISSUED', ...actions(exporterView)]);
      expect(traderView.items[0]).toMatchObject({
        action: 'NOTICE_ISSUED',
        noticeId: ids.secondNoticeId,
        contract: { id: s.c2, position: 2 },
      });

      // The buyer is a party to contract 2 only.
      const buyerView = await pageAs(s.buyer.operator.cookie, s.voyage.id);
      expect(actions(buyerView)).toEqual(['NOTICE_ISSUED', 'VOYAGE_CREATED']);
      expect(buyerView.items[0]).toMatchObject({ noticeId: ids.secondNoticeId });
    });

    it('shows service providers only the voyage’s creation', async () => {
      const s = await scenario();
      await everyAction(s);

      for (const party of [s.surveyor, s.agent]) {
        for (const cookie of [party.operator.cookie, party.viewer.cookie]) {
          const page = await pageAs(cookie, s.voyage.id);
          expect(actions(page)).toEqual(['VOYAGE_CREATED']);
          expect(page.nextCursor).toBeNull();
        }
      }
    });

    it('shows viewers what the operators of their organization see', async () => {
      const s = await scenario();
      await everyAction(s);

      expect(await pageAs(s.exporter.viewer.cookie, s.voyage.id)).toEqual(
        await pageAs(s.exporter.operator.cookie, s.voyage.id),
      );
      expect(await pageAs(s.buyer.viewer.cookie, s.voyage.id)).toEqual(
        await pageAs(s.buyer.operator.cookie, s.voyage.id),
      );
    });

    it('answers an outsider exactly as for a voyage that does not exist', async () => {
      const s = await scenario();
      await everyAction(s);

      const hidden = await timeline(s.outsider.operator.cookie, s.voyage.id).expect(404);
      const missing = await timeline(s.outsider.operator.cookie, MISSING_ID).expect(404);
      expect(withoutInstance(hidden.body)).toEqual(withoutInstance(missing.body));
      expect(ProblemDetailsSchema.parse(hidden.body).detail).toBe('Voyage was not found.');
      // A participant of another voyage only: the same.
      const participant = await timeline(s.exporter.operator.cookie, MISSING_ID).expect(404);
      expect(withoutInstance(participant.body)).toEqual(withoutInstance(missing.body));
    });

    it('keeps each voyage’s events to itself', async () => {
      const s = await scenario();
      await everyAction(s);

      const other = await pageAs(s.buyer.operator.cookie, s.other.id);
      // TF-OTHER was created by the seed, not through the API: only its notice was audited.
      expect(other.items).toHaveLength(1);
      expect(other.items[0]).toMatchObject({
        action: 'NOTICE_ISSUED',
        contract: { id: s.d1, position: 1 },
      });
    });

    it('follows current participation: a provider that leaves stops seeing the timeline', async () => {
      const s = await scenario();
      await pageAs(s.surveyor.operator.cookie, s.voyage.id);

      await ctx.prisma.voyageParticipant.deleteMany({
        where: { voyageId: s.voyage.id, organizationId: s.surveyor.organization.id },
      });

      await timeline(s.surveyor.operator.cookie, s.voyage.id).expect(404);
    });

    it('requires a session', async () => {
      const s = await scenario();
      await api().get(timelinePath(s.voyage.id)).expect(401);
    });
  });

  describe('what an event says', () => {
    it('names actor, organization, time and identifiers, and nothing else', async () => {
      const s = await scenario();
      const ids = await everyAction(s);

      const response = await timeline(s.trader.operator.cookie, s.voyage.id).expect(200);
      const page = VoyageTimelinePageSchema.parse(response.body);
      const byAction = (action: TimelineEvent['action'], index = 0) =>
        (response.body as VoyageTimelinePage).items.filter((item) => item.action === action)[index];
      const exporterActor = {
        name: s.exporter.operator.user.fullName,
        organization: {
          id: s.exporter.organization.id,
          name: 'Exporter Co',
          countryCode: 'BR',
        },
      };
      const traderActor = {
        name: s.trader.operator.user.fullName,
        organization: { id: s.trader.organization.id, name: 'Trader SA', countryCode: 'CH' },
      };
      const c1 = { id: s.c1, position: 1 };
      const anId = expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown;
      const aTime = expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) as unknown;

      // Exact objects: a key added to a payload does not reach the response by accident.
      expect(byAction('VOYAGE_CREATED')).toEqual({
        id: anId,
        occurredAt: aTime,
        actor: exporterActor,
        action: 'VOYAGE_CREATED',
      });
      expect(byAction('NOTICE_ISSUED', 1)).toEqual({
        id: anId,
        occurredAt: aTime,
        actor: exporterActor,
        action: 'NOTICE_ISSUED',
        contract: c1,
        noticeId: ids.noticeId,
      });
      expect(byAction('NOTICE_ACKNOWLEDGED')).toEqual({
        id: anId,
        occurredAt: aTime,
        actor: traderActor,
        action: 'NOTICE_ACKNOWLEDGED',
        contract: c1,
        noticeId: ids.noticeId,
      });
      expect(byAction('DOCUMENTARY_INSTRUCTION_REVISED')).toEqual({
        id: anId,
        occurredAt: aTime,
        actor: traderActor,
        action: 'DOCUMENTARY_INSTRUCTION_REVISED',
        contract: c1,
        instructionId: ids.instructionId,
        revisionNumber: 1,
        version: 1,
      });
      expect(byAction('DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED')).toEqual({
        id: anId,
        occurredAt: aTime,
        actor: exporterActor,
        action: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
        contract: c1,
        instructionId: ids.instructionId,
        revisionNumber: 1,
        version: 2,
      });
      expect(byAction('DOCUMENT_VERSION_UPLOADED')).toEqual({
        id: anId,
        occurredAt: aTime,
        actor: exporterActor,
        action: 'DOCUMENT_VERSION_UPLOADED',
        contract: c1,
        documentId: ids.documentId,
        revisionNumber: 1,
        documentType: 'BILL_OF_LADING',
        versionNumber: 1,
        version: 1,
      });
      expect(byAction('DOCUMENT_VERSION_REVIEWED')).toEqual({
        id: anId,
        occurredAt: aTime,
        actor: traderActor,
        action: 'DOCUMENT_VERSION_REVIEWED',
        contract: c1,
        documentId: ids.documentId,
        revisionNumber: 1,
        documentType: 'BILL_OF_LADING',
        versionNumber: 1,
        decision: 'REJECTED',
        version: 2,
      });
      expect(page.items).toHaveLength(8);

      // The ids are the audit rows' own; the times are theirs too.
      const rows = await ctx.prisma.auditEvent.findMany({
        where: { voyageId: s.voyage.id },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        select: { id: true, occurredAt: true },
      });
      expect(page.items.map(({ id, occurredAt }) => ({ id, occurredAt }))).toEqual(
        rows.map(({ id, occurredAt }) => ({ id, occurredAt: occurredAt.toISOString() })),
      );

      // What the payloads record beyond identifiers stays in the audit table.
      const storageKey = (await ctx.prisma.documentVersion.findFirstOrThrow()).storageKey;
      const body = JSON.stringify(response.body);
      for (const secret of [
        REASON,
        FILE_NAME,
        NOTICE_MESSAGE,
        content.consignee,
        'Secret Notify Party',
        ids.sha256,
        storageKey,
        // Actors are named, not identified. (Test users' names embed their emails.)
        s.trader.operator.user.id,
        s.exporter.operator.user.id,
      ]) {
        expect(body).not.toContain(secret);
      }
      for (const key of ['payload', 'reason', 'fileName', 'sha256', 'requirements', 'late']) {
        expect(body).not.toContain(`"${key}"`);
      }
    });

    it('serves uploads recorded before document versions existed, with no version', async () => {
      const s = await scenario();
      const documentId = randomUUID();
      // As recorded before ADR 0014: no `version` key.
      await insertEvents(s, [
        {
          action: 'DOCUMENT_VERSION_UPLOADED',
          occurredAt: fromNow(1),
          payload: {
            documentId,
            contractId: s.c1,
            instructionId: randomUUID(),
            revisionNumber: 1,
            documentType: 'BILL_OF_LADING',
            versionNumber: 1,
            fileName: FILE_NAME,
            mediaType: 'application/pdf',
            sizeBytes: 2048,
            sha256: 'ab'.repeat(32),
            uploadedAt: fromNow(1).toISOString(),
          },
        },
      ]);

      const [legacy] = (await pageAs(s.trader.operator.cookie, s.voyage.id)).items;
      expect(legacy).toMatchObject({
        action: 'DOCUMENT_VERSION_UPLOADED',
        documentId,
        versionNumber: 1,
        version: null,
      });
      expect(JSON.stringify(legacy)).not.toContain(FILE_NAME);
      // Still hidden from everyone but the counterparties.
      expect(actions(await pageAs(s.buyer.operator.cookie, s.voyage.id))).toEqual([
        'VOYAGE_CREATED',
      ]);
    });
  });

  describe('pages', () => {
    it('fills every page with visible events, however many hidden ones lie between', async () => {
      const s = await scenario();
      // Five events under contract 1 (the exporter's), each followed by three under contract 2.
      const base = Date.now() + 60_000;
      const visible: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const event = noticeEvent(s.c1, new Date(base + i * 1000));
        visible.push(event.payload.noticeId);
        await insertEvents(s, [
          event,
          ...[1, 2, 3].map((j) => noticeEvent(s.c2, new Date(base + i * 1000 + j * 100), s.trader)),
        ]);
      }
      // Older than everything visible: hidden events only.
      await insertEvents(
        s,
        [1, 2, 3].map((j) => noticeEvent(s.c2, new Date(base - j * 1000), s.trader)),
      );

      const pages = await allPagesAs(s.exporter.operator.cookie, s.voyage.id, 2);

      expect(pages.map((page) => page.items.length)).toEqual([2, 2, 2]);
      const served = pages.flatMap((page) => page.items);
      expect(served.map((item) => ('noticeId' in item ? item.noticeId : item.action))).toEqual([
        ...[...visible].reverse(),
        'VOYAGE_CREATED',
      ]);
      // Each cursor is the last event served, never a hidden one.
      for (const page of pages.slice(0, -1)) {
        const last = page.items.at(-1);
        expect(decodeCursor(page.nextCursor ?? '')).toEqual([last?.occurredAt, last?.id]);
      }
    });

    it('says there is nothing more when only hidden events are left', async () => {
      const s = await scenario();
      const base = Date.now() + 60_000;
      await insertEvents(s, [
        noticeEvent(s.c1, new Date(base)),
        // Older than the exporter's newest event, and not the exporter's to see.
        ...[1, 2, 3].map((j) => noticeEvent(s.c2, new Date(base - j * 1000), s.trader)),
      ]);
      // The creation is older still; ask for exactly what is visible.
      const page = await pageAs(s.exporter.operator.cookie, s.voyage.id, { limit: '2' });
      expect(actions(page)).toEqual(['NOTICE_ISSUED', 'VOYAGE_CREATED']);
      expect(page.nextCursor).toBeNull();

      const first = await pageAs(s.exporter.operator.cookie, s.voyage.id, { limit: '1' });
      expect(first.nextCursor).not.toBeNull();
      const second = await pageAs(s.exporter.operator.cookie, s.voyage.id, {
        limit: '1',
        cursor: first.nextCursor ?? '',
      });
      expect(actions(second)).toEqual(['VOYAGE_CREATED']);
      expect(second.nextCursor).toBeNull();
    });

    it('splits events with the same time across pages without losing or repeating any', async () => {
      const s = await scenario();
      const at = new Date(Date.now() + 60_000);
      await insertEvents(s, [
        ...Array.from({ length: 5 }, () => noticeEvent(s.c1, at)),
        // Hidden events at the very same instant.
        ...Array.from({ length: 4 }, () => noticeEvent(s.c2, at, s.trader)),
      ]);
      const rows = await ctx.prisma.auditEvent.findMany({
        where: { voyageId: s.voyage.id, occurredAt: at },
        select: { id: true, payload: true },
      });
      const expected = rows
        .filter((row) => (row.payload as { contractId: string }).contractId === s.c1)
        .map(({ id }) => id)
        .sort()
        .reverse();

      const pages = await allPagesAs(s.exporter.operator.cookie, s.voyage.id, 2);

      expect(pages.map((page) => page.items.length)).toEqual([2, 2, 2]);
      const served = pages.flatMap((page) => page.items);
      expect(served.slice(0, 5).map(({ id }) => id)).toEqual(expected);
      expect(served.slice(0, 5).every(({ occurredAt }) => occurredAt === at.toISOString())).toBe(
        true,
      );
      expect(served.at(-1)?.action).toBe('VOYAGE_CREATED');
      expect(new Set(served.map(({ id }) => id)).size).toBe(served.length);
    });

    it('defaults to 20 events a page and accepts up to 50', async () => {
      const s = await scenario();
      const base = Date.now() + 60_000;
      await insertEvents(
        s,
        Array.from({ length: 54 }, (_, i) => noticeEvent(s.c1, new Date(base + i))),
      );

      expect((await pageAs(s.exporter.operator.cookie, s.voyage.id)).items).toHaveLength(20);
      const largest = await pageAs(s.exporter.operator.cookie, s.voyage.id, { limit: '50' });
      expect(largest.items).toHaveLength(50);
      const rest = await pageAs(s.exporter.operator.cookie, s.voyage.id, {
        limit: '50',
        cursor: largest.nextCursor ?? '',
      });
      expect(rest.items).toHaveLength(5);
      expect(rest.nextCursor).toBeNull();
    });

    it('keeps a cursor within what its bearer may see', async () => {
      const s = await scenario();
      const base = Date.now() + 60_000;
      await insertEvents(s, [
        noticeEvent(s.c1, new Date(base)),
        noticeEvent(s.c2, new Date(base - 1000), s.trader),
      ]);
      // The trader's cursor after the first event; the buyer replays it.
      const traderFirst = await pageAs(s.trader.operator.cookie, s.voyage.id, { limit: '1' });
      const replayed = await pageAs(s.buyer.operator.cookie, s.voyage.id, {
        cursor: traderFirst.nextCursor ?? '',
      });
      expect(replayed.items.map((item) => item.action)).toEqual([
        'NOTICE_ISSUED',
        'VOYAGE_CREATED',
      ]);
      expect(replayed.items[0]).toMatchObject({ contract: { id: s.c2 } });
      // And the outsider learns nothing from one.
      await timeline(s.outsider.operator.cookie, s.voyage.id, {
        cursor: traderFirst.nextCursor ?? '',
      }).expect(404);
    });
  });

  describe('invalid requests', () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

    it.each([
      ['not base64 JSON', 'bm90IGpzb24'],
      ['characters outside base64url', 'abc+/='],
      ['a cursor of the wrong shape', encode({ occurredAt: '2026-10-01T00:00:00.000Z' })],
      ['a time that is not one', encode(['yesterday', '01990000-0000-7000-8008-000000000001'])],
      ['an id that is not a UUID', encode(['2026-10-01T00:00:00.000Z', 'TF-2026-0001'])],
      ['an over-long cursor', 'a'.repeat(201)],
      ['an empty cursor', ''],
    ])('refuses %s with 400, for any voyage', async (_, cursor) => {
      const s = await scenario();

      for (const voyageId of [s.voyage.id, MISSING_ID]) {
        const response = await timeline(s.exporter.operator.cookie, voyageId, { cursor }).expect(
          400,
        );
        const problem = ProblemDetailsSchema.parse(response.body);
        expect(problem.type).toBe(ProblemTypes.ValidationFailed);
        expect(problem.errors?.map(({ path }) => path)).toEqual(['query.cursor']);
      }
    });

    it.each(['0', '51', '-1', '1.5', 'ten', '020'])('refuses limit %s with 400', async (limit) => {
      const s = await scenario();

      const response = await timeline(s.exporter.operator.cookie, s.voyage.id, { limit }).expect(
        400,
      );
      expect(ProblemDetailsSchema.parse(response.body).errors?.map(({ path }) => path)).toEqual([
        'query.limit',
      ]);
    });

    it('refuses a malformed voyage id with 400', async () => {
      const s = await scenario();
      await timeline(s.exporter.operator.cookie, 'TF-2026-0001').expect(400);
    });
  });

  it('changes nothing it reads', async () => {
    const s = await scenario();
    await everyAction(s);
    const before = await ctx.prisma.auditEvent.findMany({ orderBy: { id: 'asc' } });

    await allPagesAs(s.trader.operator.cookie, s.voyage.id, 3);

    expect(await ctx.prisma.auditEvent.findMany({ orderBy: { id: 'asc' } })).toEqual(before);
  });
});
