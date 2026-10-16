import { randomBytes } from 'node:crypto';
import {
  type ContractDocument,
  ContractDocumentSchema,
  type DocumentaryInstructionContent,
  DocumentaryInstructionSchema,
  DocumentListResponseSchema,
  ProblemDetailsSchema,
  ProblemTypes,
  REJECTION_REASON_MAX_LENGTH,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '../src/generated/prisma/client.js';
import { advanceToNextRevision } from '../src/modules/documentary-instructions/instruction.writes.js';
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

const MISSING_ID = '01990000-0000-7000-8008-999999999999';

/** Revision 1 requires a bill of lading and a phytosanitary certificate. */
const firstContent: DocumentaryInstructionContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 3 },
    { document: 'PHYTOSANITARY_CERTIFICATE', originals: 1, copies: 0 },
  ],
};

/** Revision 2 drops the certificate and asks for a certificate of origin instead. */
const secondContent: DocumentaryInstructionContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 2 },
    { document: 'CERTIFICATE_OF_ORIGIN', originals: 1, copies: 1 },
  ],
};

const APPROVE = { decision: 'APPROVED' } as const;
const reject = (reason: string) => ({ decision: 'REJECTED', reason }) as const;
const REASON = 'The consignee does not match the instructions.';

/** Bytes that start like a PDF. */
const pdf = (size = 4096) =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(Math.max(0, size - 9))]).subarray(0, size);

describe('Document reviews', () => {
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

  /** What the request helpers need of a scenario, before and after its first upload. */
  interface Base {
    voyage: { id: string };
    /** The contract the documents are presented under. */
    c1: string;
    /** Its buyer, who gives the instructions. */
    trader: Party;
  }

  /**
   * TF-R: Exporter → Trader → Buyer, with a surveyor and a shipping agent. Under contract 1 the
   * exporter sells to the trader: the trader gives the instructions and reviews the documents the
   * exporter presents. TF-OTHER: the exporter sells straight to the buyer. Outsider participates
   * in nothing. The trader has given revision 1 under contract 1, and the exporter has uploaded
   * version 1 of the bill of lading.
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
      reference: 'TF-R',
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
    const c1 = await contractAt(voyage.id, 1);
    const instruction = DocumentaryInstructionSchema.parse(
      (
        await api()
          .put(`/api/voyages/${voyage.id}/contracts/${c1}/documentary-instructions`)
          .set('Cookie', trader.operator.cookie)
          .set('If-None-Match', '*')
          .send(firstContent)
          .expect(201)
      ).body,
    );
    const s = {
      voyage,
      other,
      exporter,
      trader,
      buyer,
      surveyor,
      agent,
      outsider,
      instruction,
      /** Exporter → Trader on TF-R, with instructions at revision 1. */
      c1,
      /** Trader → Buyer on TF-R, without instructions. */
      c2: await contractAt(voyage.id, 2),
      /** Exporter → Buyer on TF-OTHER. */
      d1: await contractAt(other.id, 1),
    };
    const uploaded = await upload(exporter.operator.cookie, s, { 'If-None-Match': '*' }).expect(
      201,
    );
    return { ...s, document: ContractDocumentSchema.parse(uploaded.body) };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  interface Target {
    voyageId?: string;
    contractId?: string;
    revision?: number | string;
    type?: string;
  }

  const documentPath = (s: Base, target: Target = {}) =>
    `/api/voyages/${target.voyageId ?? s.voyage.id}/contracts/${target.contractId ?? s.c1}` +
    `/documentary-instructions/revisions/${target.revision ?? 1}/documents/${target.type ?? 'BILL_OF_LADING'}`;
  const versionsPath = (s: Base, target?: Target) => `${documentPath(s, target)}/versions`;
  const reviewPath = (s: Base, version: number | string, target?: Target) =>
    `${versionsPath(s, target)}/${version}/review`;
  const listPath = (voyageId: string) => `/api/voyages/${voyageId}/documents`;

  /** A multipart upload with the given precondition headers. */
  const upload = (cookie: string, s: Base, headers: Record<string, string>, bytes = pdf()) =>
    api()
      .post(versionsPath(s))
      .set('Cookie', cookie)
      .set(headers)
      .attach('file', bytes, { filename: 'bill-of-lading.pdf', contentType: 'application/pdf' });

  /** A replacement of the bill of lading, based on the document version `tag`. */
  const replace = (cookie: string, s: Base, tag: string, bytes = pdf()) =>
    upload(cookie, s, { 'If-Match': tag }, bytes);

  /**
   * A review of file version `version`, based on the document version `ifMatch` (no header when
   * null). `body` undefined sends no body at all.
   */
  const review = (
    cookie: string,
    s: Base,
    version: number | string,
    body: object | undefined,
    ifMatch: string | null = '"1"',
    target?: Target,
  ) => {
    const test = api()
      .post(reviewPath(s, version, target))
      .set('Cookie', cookie);
    if (ifMatch !== null) test.set('If-Match', ifMatch);
    return body === undefined ? test : test.send(body);
  };

  /** Gives revision 2 of the instructions under contract 1, as the trader. */
  const revise = (s: Base) =>
    api()
      .put(`/api/voyages/${s.voyage.id}/contracts/${s.c1}/documentary-instructions`)
      .set('Cookie', s.trader.operator.cookie)
      .set('If-Match', '"1"')
      .send(secondContent);

  /** Revision 2, written in the lock holder's transaction as the API writes it. */
  const revisionTwo =
    (s: Base): Change =>
    async (tx) => {
      const at = new Date();
      const instruction = await advanceToNextRevision(tx, {
        contractId: s.c1,
        expectedVersions: [1],
        at,
      });
      if (!instruction) throw new Error('Expected the instructions at version 1');
      await tx.documentaryInstructionRevision.create({
        data: {
          instructionId: instruction.id,
          revisionNumber: 2,
          consignee: secondContent.consignee,
          requirements: secondContent.requirements,
          createdByUserId: s.trader.operator.user.id,
          createdByOrganizationId: s.trader.organization.id,
          createdAt: at,
        },
      });
    };

  /** A second operator of `party`, signed in. */
  async function colleagueOf(party: Party) {
    const user = await createUser(ctx.prisma, party.organization.id, { role: 'OPERATOR' });
    return { user, cookie: await signIn(ctx.server, user.email) };
  }

  /** The bill of lading of revision 1 as stored, and everything a review could write. */
  const state = async () => {
    const document = await ctx.prisma.document.findFirstOrThrow({
      where: { revisionNumber: 1, documentType: 'BILL_OF_LADING' },
      select: { version: true, currentVersionNumber: true },
    });
    return {
      ...document,
      reviews: await ctx.prisma.documentReview.count(),
      reviewEvents: await ctx.prisma.auditEvent.count({
        where: { action: 'DOCUMENT_VERSION_REVIEWED' },
      }),
    };
  };
  /** The scenario's state: one upload, no review. */
  const UNREVIEWED = { version: 1, currentVersionNumber: 1, reviews: 0, reviewEvents: 0 };

  /** The documents on the scenario's voyage, as the user of `cookie` reads them. */
  const listAs = async (s: Base, cookie: string) =>
    DocumentListResponseSchema.parse(
      (await api().get(listPath(s.voyage.id)).set('Cookie', cookie).expect(200)).body,
    ).items;

  /** The bytes of file version `version` of the bill of lading, as the user of `cookie` gets them. */
  const download = async (s: Base, cookie: string, version: number) =>
    (
      await api()
        .get(`${versionsPath(s)}/${version}/content`)
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

  /** A problem without its `instance`, which names the request path. */
  const problemOf = (body: unknown) => {
    const { instance: _instance, ...problem } = ProblemDetailsSchema.parse(body);
    return problem;
  };
  const problem = (status: number, title: string, detail: string) => ({
    type: ProblemTypes.Generic,
    title,
    status,
    detail,
  });
  const changedSince = (version: number) =>
    `The document has changed since the version you sent; it is now at version ${version}. ` +
    'Review its latest file and any decision on it before deciding.';

  const actor = (party: Party, role: 'operator' | 'viewer' = 'operator') => ({
    name: `Test User ${party[role].user.email}`,
    organization: {
      id: party.organization.id,
      name: party.organization.name,
      countryCode: party.organization.countryCode,
    },
  });

  /** `document` as the other side of its contract reads it. */
  const fromSide = (document: ContractDocument, side: 'SELLER' | 'BUYER'): ContractDocument => ({
    ...document,
    contract: { ...document.contract, side },
  });

  describe('deciding (POST .../versions/{versionNumber}/review)', () => {
    it("lets an operator of the contract's buyer approve the latest version, recorded with server-side facts", async () => {
      const s = await scenario();
      const before = Date.now();

      const response = await review(s.trader.operator.cookie, s, 1, APPROVE).expect(200);

      const after = Date.now();
      expect(response.headers.etag).toBe('"2"');
      const document = ContractDocumentSchema.parse(response.body);
      expect(document).toEqual({
        ...fromSide(s.document, 'BUYER'),
        version: 2,
        currentVersion: {
          ...s.document.currentVersion,
          review: {
            decision: 'APPROVED',
            reason: null,
            reviewedAt: expect.any(String) as string,
            reviewedBy: actor(s.trader),
          },
        },
      });
      const reviewedAt = Date.parse(document.currentVersion.review?.reviewedAt ?? '');
      expect(reviewedAt).toBeGreaterThanOrEqual(before);
      expect(reviewedAt).toBeLessThanOrEqual(after);

      expect(await ctx.prisma.documentReview.findMany()).toEqual([
        expect.objectContaining({
          documentId: document.id,
          versionNumber: 1,
          decision: 'APPROVED',
          reason: null,
          reviewedByUserId: s.trader.operator.user.id,
          reviewedByOrganizationId: s.trader.organization.id,
        }),
      ]);
      const [event] = await ctx.prisma.auditEvent.findMany({
        where: { action: 'DOCUMENT_VERSION_REVIEWED' },
      });
      expect(event).toMatchObject({
        actorUserId: s.trader.operator.user.id,
        actorOrganizationId: s.trader.organization.id,
        voyageId: s.voyage.id,
        payload: {
          documentId: document.id,
          contractId: s.c1,
          instructionId: s.instruction.id,
          revisionNumber: 1,
          documentType: 'BILL_OF_LADING',
          versionNumber: 1,
          sha256: s.document.currentVersion.sha256,
          decision: 'APPROVED',
          reason: null,
          reviewedAt: document.currentVersion.review?.reviewedAt,
          version: 2,
        },
      });
    });

    it('rejects with the reason, trimmed, and both sides read it', async () => {
      const s = await scenario();

      const response = await review(s.trader.operator.cookie, s, 1, reject(`  ${REASON}\n`)).expect(
        200,
      );

      const document = ContractDocumentSchema.parse(response.body);
      expect(document.currentVersion.review).toMatchObject({
        decision: 'REJECTED',
        reason: REASON,
      });
      expect(await listAs(s, s.exporter.viewer.cookie)).toEqual([fromSide(document, 'SELLER')]);
      expect(await listAs(s, s.trader.viewer.cookie)).toEqual([document]);
    });

    it('accepts a reason of exactly 1000 characters', async () => {
      const s = await scenario();
      const reason = 'x'.repeat(REJECTION_REASON_MAX_LENGTH);

      const response = await review(s.trader.operator.cookie, s, 1, reject(reason)).expect(200);

      expect(ContractDocumentSchema.parse(response.body).currentVersion.review?.reason).toBe(
        reason,
      );
    });

    it.each<[string, object | undefined, string]>([
      ['a rejection without a reason', { decision: 'REJECTED' }, 'body.reason'],
      ['a blank reason', reject(' \n\t '), 'body.reason'],
      ['a reason over 1000 characters', reject('x'.repeat(1001)), 'body.reason'],
      ['an approval with a reason', { decision: 'APPROVED', reason: 'Fine.' }, 'body'],
      ['another decision', { decision: 'PENDING' }, 'body.decision'],
      ['a reviewer chosen by the client', { decision: 'APPROVED', reviewedBy: 'x' }, 'body'],
      [
        'a time chosen by the client',
        { decision: 'APPROVED', reviewedAt: '2030-01-01T00:00:00Z' },
        'body',
      ],
      ['no decision', {}, 'body.decision'],
      ['no body at all', undefined, 'body'],
    ])('refuses %s, recording nothing', async (_case, body, path) => {
      const s = await scenario();

      const response = await review(s.trader.operator.cookie, s, 1, body).expect(400);

      const refusal = problemOf(response.body);
      expect(refusal.type).toBe(ProblemTypes.ValidationFailed);
      expect(refusal.errors?.map((error) => error.path)).toContain(path);
      expect(await state()).toEqual(UNREVIEWED);
    });
  });

  describe('who may review, and who reads decisions', () => {
    it('refuses viewers of the buyer, and any user of the seller, with 403', async () => {
      const s = await scenario();

      const viewer = await review(s.trader.viewer.cookie, s, 1, APPROVE).expect(403);
      const seller = await review(s.exporter.operator.cookie, s, 1, APPROVE).expect(403);
      const sellerViewer = await review(s.exporter.viewer.cookie, s, 1, APPROVE).expect(403);

      expect(problemOf(viewer.body)).toEqual(
        problem(403, 'Forbidden', 'Your role does not allow you to review documents.'),
      );
      expect(problemOf(seller.body)).toEqual(
        problem(403, 'Forbidden', 'Only the buyer under a contract may review its documents.'),
      );
      expect(problemOf(sellerViewer.body)).toEqual(problemOf(viewer.body));
      expect(await state()).toEqual(UNREVIEWED);
    });

    it('answers everyone else exactly like a contract that does not exist', async () => {
      const s = await scenario();

      for (const { cookie } of [
        s.buyer.operator,
        s.surveyor.operator,
        s.agent.operator,
        s.outsider.operator,
      ]) {
        const hidden = await review(cookie, s, 1, APPROVE).expect(404);
        const missing = await review(cookie, s, 1, APPROVE, '"1"', {
          contractId: MISSING_ID,
        }).expect(404);
        expect(problemOf(hidden.body)).toEqual(problemOf(missing.body));
        expect(problemOf(hidden.body)).toEqual(
          problem(404, 'Not Found', 'Contract was not found.'),
        );
      }
      // A contract of another voyage, through this voyage's path, even for its buyer.
      await review(s.buyer.operator.cookie, s, 1, APPROVE, '"1"', { contractId: s.d1 }).expect(404);
      expect(await state()).toEqual(UNREVIEWED);
    });

    it('refuses a review without a session, or from another site', async () => {
      const s = await scenario();

      await api().post(reviewPath(s, 1)).set('If-Match', '"1"').send(APPROVE).expect(401);
      await review(s.trader.operator.cookie, s, 1, APPROVE)
        .set('Sec-Fetch-Site', 'cross-site')
        .expect(403);

      expect(await state()).toEqual(UNREVIEWED);
    });

    it('shows decisions to both counterparties, viewers included, and to nobody else', async () => {
      const s = await scenario();
      const decided = ContractDocumentSchema.parse(
        (await review(s.trader.operator.cookie, s, 1, reject(REASON)).expect(200)).body,
      );

      expect(await listAs(s, s.exporter.viewer.cookie)).toEqual([fromSide(decided, 'SELLER')]);
      expect(await listAs(s, s.exporter.operator.cookie)).toEqual([fromSide(decided, 'SELLER')]);
      expect(await listAs(s, s.trader.viewer.cookie)).toEqual([decided]);
      for (const { cookie } of [s.buyer.viewer, s.surveyor.operator, s.agent.viewer]) {
        expect(await listAs(s, cookie)).toEqual([]);
      }
      await api().get(listPath(s.voyage.id)).set('Cookie', s.outsider.viewer.cookie).expect(404);
    });
  });

  describe('preconditions', () => {
    it.each<[string, Record<string, string>, number, string]>([
      ['names no version', {}, 428, 'Send If-Match with the version of the document you reviewed.'],
      [
        'names any version',
        { 'If-Match': '*' },
        428,
        'If-Match must name the version your change is based on; "*" is not accepted.',
      ],
      [
        'only asks for no document',
        { 'If-None-Match': '*' },
        428,
        'Send If-Match with the version of the document you reviewed.',
      ],
      ['names a weak tag', { 'If-Match': 'W/"1"' }, 412, changedSince(1)],
      ['names a version that is not current', { 'If-Match': '"7"' }, 412, changedSince(1)],
    ])('refuses a review that %s, recording nothing', async (_case, headers, status, detail) => {
      const s = await scenario();

      const response = await review(s.trader.operator.cookie, s, 1, APPROVE, null)
        .set(headers)
        .expect(status);

      expect(problemOf(response.body).detail).toBe(detail);
      expect(await state()).toEqual(UNREVIEWED);
    });

    it('refuses a malformed If-Match', async () => {
      const s = await scenario();

      await review(s.trader.operator.cookie, s, 1, APPROVE, 'version 1').expect(400);

      expect(await state()).toEqual(UNREVIEWED);
    });
  });

  describe('only the latest version, once, under the current revision', () => {
    it('refuses a version, document, type or revision that does not exist', async () => {
      const s = await scenario();
      const as = (version: number | string, target?: Target) =>
        review(s.trader.operator.cookie, s, version, APPROVE, '"1"', target);

      const noVersion = await as(2).expect(404);
      const notPresented = await as(1, { type: 'PHYTOSANITARY_CERTIFICATE' }).expect(404);
      const notRequired = await as(1, { type: 'CERTIFICATE_OF_ORIGIN' }).expect(404);
      const noRevision = await as(1, { revision: 2 }).expect(404);
      const noInstructions = await review(s.buyer.operator.cookie, s, 1, APPROVE, '"1"', {
        contractId: s.c2,
      }).expect(404);

      expect(problemOf(noVersion.body).detail).toBe('Document version was not found.');
      expect(problemOf(notPresented.body).detail).toBe('Document version was not found.');
      expect(problemOf(notRequired.body).detail).toBe(
        'Revision 1 does not require a document of type CERTIFICATE_OF_ORIGIN.',
      );
      expect(problemOf(noRevision.body).detail).toBe('Revision was not found.');
      expect(problemOf(noInstructions.body).detail).toBe('Revision was not found.');
      await as('0').expect(400);
      await as(1, { type: 'PACKING_LIST' }).expect(400);
      expect(await state()).toEqual(UNREVIEWED);
    });

    it('refuses a version that has been replaced, even at the current document version', async () => {
      const s = await scenario();
      await replace(s.exporter.operator.cookie, s, '"1"').expect(201);

      const response = await review(s.trader.operator.cookie, s, 1, reject(REASON), '"2"').expect(
        409,
      );

      expect(problemOf(response.body)).toEqual(
        problem(
          409,
          'Conflict',
          'Version 1 has been replaced by version 2; only the latest version can be reviewed.',
        ),
      );
      expect(await state()).toEqual({ ...UNREVIEWED, version: 2, currentVersionNumber: 2 });
    });

    it('records one decision per version: never a second, never a change, never a reopening', async () => {
      const s = await scenario();
      await review(s.trader.operator.cookie, s, 1, APPROVE).expect(200);
      const colleague = await colleagueOf(s.trader);

      const changed = await review(colleague.cookie, s, 1, reject(REASON), '"2"').expect(409);
      const again = await review(s.trader.operator.cookie, s, 1, APPROVE, '"2"').expect(409);
      const stale = await review(colleague.cookie, s, 1, reject(REASON), '"1"').expect(412);

      for (const response of [changed, again]) {
        expect(problemOf(response.body)).toEqual(
          problem(409, 'Conflict', 'Version 1 has already been approved; a decision is final.'),
        );
      }
      expect(problemOf(stale.body).detail).toBe(changedSince(2));
      expect(await state()).toEqual({ ...UNREVIEWED, version: 2, reviews: 1, reviewEvents: 1 });
      const [document] = await listAs(s, s.exporter.viewer.cookie);
      expect(document?.currentVersion.review).toMatchObject({
        decision: 'APPROVED',
        reviewedBy: actor(s.trader),
      });
    });

    it('refuses a review under a superseded revision, and keeps what was presented under it', async () => {
      const s = await scenario();
      await revise(s).expect(200);

      const response = await review(s.trader.operator.cookie, s, 1, APPROVE).expect(409);

      expect(problemOf(response.body)).toEqual(
        problem(
          409,
          'Conflict',
          'Revision 1 has been superseded by revision 2; only documents of the current revision are reviewed.',
        ),
      );
      expect(await state()).toEqual(UNREVIEWED);
      expect(await listAs(s, s.trader.viewer.cookie)).toEqual([fromSide(s.document, 'BUYER')]);
    });
  });

  describe('replacements and history', () => {
    it('starts a replacement pending, keeps every decision on its own version, and moves the entity tag with each', async () => {
      const s = await scenario();
      const firstBytes = await download(s, s.trader.viewer.cookie, 1);

      const rejected = await review(s.trader.operator.cookie, s, 1, reject(REASON)).expect(200);
      expect(rejected.headers.etag).toBe('"2"');
      // The file number alone no longer names the document: a decision came after it.
      const stale = await replace(s.exporter.operator.cookie, s, '"1"').expect(412);
      expect(problemOf(stale.body).detail).toBe(
        'The document has changed since the version you sent; it is now at version 2. Review its latest file and any decision on it before replacing it.',
      );
      const replaced = await replace(s.exporter.operator.cookie, s, '"2"').expect(201);
      expect(replaced.headers.etag).toBe('"3"');
      expect(replaced.headers.location).toBe(`${versionsPath(s)}/2/content`);
      const pending = ContractDocumentSchema.parse(replaced.body);
      expect(pending.version).toBe(3);
      expect(pending.currentVersion).toMatchObject({ number: 2, review: null });
      expect(pending.previousVersions).toEqual([
        {
          ...s.document.currentVersion,
          review: {
            decision: 'REJECTED',
            reason: REASON,
            reviewedAt: expect.any(String) as string,
            reviewedBy: actor(s.trader),
          },
        },
      ]);

      const approved = await review(s.trader.operator.cookie, s, 2, APPROVE, '"3"').expect(200);

      expect(approved.headers.etag).toBe('"4"');
      const [document] = await listAs(s, s.exporter.viewer.cookie);
      expect(document?.version).toBe(4);
      expect(
        [document?.currentVersion, ...(document?.previousVersions ?? [])].map((version) => [
          version?.number,
          version?.review?.decision,
          version?.review?.reason,
        ]),
      ).toEqual([
        [2, 'APPROVED', null],
        [1, 'REJECTED', REASON],
      ]);
      // The rejected file is still there, byte for byte.
      expect((await download(s, s.exporter.viewer.cookie, 1)).equals(firstBytes)).toBe(true);
      // Every change is one event, numbered by the version it produced.
      const events = await ctx.prisma.auditEvent.findMany({
        where: { action: { in: ['DOCUMENT_VERSION_UPLOADED', 'DOCUMENT_VERSION_REVIEWED'] } },
        orderBy: { occurredAt: 'asc' },
      });
      expect(
        events.map(({ action, payload }) => [action, (payload as { version: number }).version]),
      ).toEqual([
        ['DOCUMENT_VERSION_UPLOADED', 1],
        ['DOCUMENT_VERSION_REVIEWED', 2],
        ['DOCUMENT_VERSION_UPLOADED', 3],
        ['DOCUMENT_VERSION_REVIEWED', 4],
      ]);
    });

    it.each([
      ['the decision', `decision = 'APPROVED'`],
      ['the reason', `reason = 'Edited.'`],
      ['the reviewer', `reviewed_at = now()`],
      ['the version decided on', `version_number = 2`],
    ])('refuses changing %s of a review, for every writer', async (_field, assignment) => {
      const s = await scenario();
      await review(s.trader.operator.cookie, s, 1, reject(REASON)).expect(200);

      await expect(
        ctx.prisma.$executeRawUnsafe(`UPDATE document_reviews SET ${assignment}`),
      ).rejects.toThrow(/document_reviews: decisions are final/);
    });
  });

  describe('when the audit trail fails', () => {
    it('records no decision, and leaves the document as it was', async () => {
      const s = await scenario();

      await failAuditWrites(ctx.prisma, async () => {
        const response = await review(s.trader.operator.cookie, s, 1, APPROVE).expect(500);
        expect(problemOf(response.body)).toEqual(
          problem(500, 'Internal Server Error', 'An unexpected error occurred.'),
        );
      });

      expect(await state()).toEqual(UNREVIEWED);
      // Nothing was half-done: the same review goes through now, at the same version.
      await review(s.trader.operator.cookie, s, 1, APPROVE).expect(200);
    });
  });

  describe('races against PostgreSQL', () => {
    /**
     * Holds the document's row lock, starts the contenders one after the other (each blocked on
     * the row before the next starts, so PostgreSQL grants the row in that order), then lets
     * them go together.
     */
    async function race(s: Scenario, contenders: (() => request.Test)[]) {
      const lock = await holdLock(
        ctx.prisma,
        (tx) => tx.$queryRaw`SELECT id FROM documents WHERE id = ${s.document.id}::uuid FOR UPDATE`,
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
      return Promise.all(answers);
    }

    it('records exactly one decision when two reviews of the same version race', async () => {
      const s = await scenario();
      const colleague = await colleagueOf(s.trader);

      const [first, second] = await race(s, [
        () => review(s.trader.operator.cookie, s, 1, APPROVE),
        () => review(colleague.cookie, s, 1, reject(REASON)),
      ]);

      expect([first?.status, second?.status]).toEqual([200, 412]);
      expect(problemOf(second?.body).detail).toBe(changedSince(2));
      expect(await state()).toEqual({ ...UNREVIEWED, version: 2, reviews: 1, reviewEvents: 1 });
      expect((await ctx.prisma.documentReview.findFirstOrThrow()).decision).toBe('APPROVED');
    });

    it('refuses a replacement that raced a review and lost, and removes its bytes', async () => {
      const s = await scenario();
      const objectsBefore = await storage.files('objects');

      const [decided, replaced] = await race(s, [
        () => review(s.trader.operator.cookie, s, 1, reject(REASON)),
        () => replace(s.exporter.operator.cookie, s, '"1"'),
      ]);

      expect(decided?.status).toBe(200);
      expect(replaced?.status).toBe(412);
      expect(problemOf(replaced?.body).detail).toBe(
        'The document has changed since the version you sent; it is now at version 2. Review its latest file and any decision on it before replacing it.',
      );
      expect(await state()).toEqual({ ...UNREVIEWED, version: 2, reviews: 1, reviewEvents: 1 });
      expect(await storage.files('objects')).toEqual(objectsBefore);
      expect(await storage.files('staging')).toEqual([]);
    });

    it('refuses a review that raced a replacement and lost: the new file starts pending', async () => {
      const s = await scenario();

      const [replaced, decided] = await race(s, [
        () => replace(s.exporter.operator.cookie, s, '"1"'),
        () => review(s.trader.operator.cookie, s, 1, APPROVE),
      ]);

      expect(replaced?.status).toBe(201);
      expect(decided?.status).toBe(412);
      expect(problemOf(decided?.body).detail).toBe(changedSince(2));
      expect(await state()).toEqual({ ...UNREVIEWED, version: 2, currentVersionNumber: 2 });
      const [document] = await listAs(s, s.trader.viewer.cookie);
      expect(document?.currentVersion).toMatchObject({ number: 2, review: null });
      expect(document?.previousVersions.map(({ review }) => review)).toEqual([null]);
    });

    it('refuses a review when a revision of the instructions commits while it waits', async () => {
      const s = await scenario();
      // The review passes its checks of the contract, then waits for the instruction row.
      const lock = await holdLock(
        ctx.prisma,
        (tx) =>
          tx.$queryRaw`SELECT id FROM documentary_instructions WHERE id = ${s.instruction.id}::uuid FOR UPDATE`,
      );
      const answer = review(s.trader.operator.cookie, s, 1, APPROVE).then((response) => response);
      await waitForLockWaiters(ctx.prisma, 1);

      await lock.release(revisionTwo(s));

      const response = await answer;
      expect(response.status).toBe(409);
      expect(problemOf(response.body).detail).toBe(
        'Revision 1 has been superseded by revision 2; only documents of the current revision are reviewed.',
      );
      expect(await state()).toEqual(UNREVIEWED);
    });

    it('makes a revision given while a review commits wait for it, then supersede it', async () => {
      const s = await scenario();
      // The review takes its share lock on the instruction, then waits to write its decision.
      const lock = await holdLock(ctx.prisma, (tx) =>
        tx.$executeRawUnsafe('LOCK TABLE document_reviews IN ACCESS EXCLUSIVE MODE'),
      );
      const decided = review(s.trader.operator.cookie, s, 1, APPROVE).then((response) => response);
      await waitForLockWaiters(ctx.prisma, 1);
      const revised = revise(s).then((response) => response);
      await waitForLockWaiters(ctx.prisma, 2);

      await lock.release();

      expect((await decided).status).toBe(200);
      expect((await revised).status).toBe(200);
      expect(await state()).toEqual({ ...UNREVIEWED, version: 2, reviews: 1, reviewEvents: 1 });
      // From now on, revision 1 takes neither files nor decisions.
      await replace(s.exporter.operator.cookie, s, '"2"').expect(409);
    });
  });

  describe('invariants, for every writer', () => {
    /** A review written directly, as any writer with table access could. */
    const insertReview = (
      s: Scenario,
      {
        versionNumber = 1,
        decision = 'APPROVED',
        reason = null,
        advance = true,
      }: {
        versionNumber?: number;
        decision?: string;
        reason?: string | null;
        advance?: boolean;
      } = {},
    ) =>
      ctx.prisma.$transaction(async (tx) => {
        if (advance) {
          await tx.$executeRaw`UPDATE documents SET version = version + 1 WHERE id = ${s.document.id}::uuid`;
        }
        await tx.$executeRaw`
          INSERT INTO document_reviews (document_id, version_number, decision, reason,
            reviewed_by_user_id, reviewed_by_organization_id, reviewed_at)
          VALUES (${s.document.id}::uuid, ${versionNumber}, ${decision}::document_review_decision,
            ${reason}, ${s.trader.operator.user.id}::uuid, ${s.trader.organization.id}::uuid, now())`;
      });

    it('accepts a well-formed review written directly', async () => {
      const s = await scenario();

      await insertReview(s, { decision: 'REJECTED', reason: REASON });

      expect(await state()).toMatchObject({ version: 2, reviews: 1 });
    });

    it('keeps the version equal to uploads plus reviews at commit', async () => {
      const s = await scenario();

      await expect(insertReview(s, { advance: false })).rejects.toThrow(
        /version 1 of document .* does not count its 1 uploads and 1 reviews/,
      );
      await expect(
        ctx.prisma.$executeRaw`UPDATE documents SET version = version + 1`,
      ).rejects.toThrow(/version 2 of document .* does not count its 1 uploads and 0 reviews/);
      expect(await state()).toEqual(UNREVIEWED);
    });

    it('accepts a review only of the latest version, once, under the current revision', async () => {
      const s = await scenario();
      await replace(s.exporter.operator.cookie, s, '"1"').expect(201);

      await expect(insertReview(s, { versionNumber: 1 })).rejects.toThrow(
        /only the current version of a document can be reviewed/,
      );
      await insertReview(s, { versionNumber: 2 });
      await expect(
        insertReview(s, { versionNumber: 2, decision: 'REJECTED', reason: REASON }),
      ).rejects.toThrow(/document_reviews_document_id_version_number_key/);
      // A version that does not exist is not the current one either.
      await expect(insertReview(s, { versionNumber: 3 })).rejects.toThrow(
        /only the current version of a document can be reviewed/,
      );
    });

    it('refuses a review of a document whose revision has been superseded', async () => {
      const s = await scenario();
      await revise(s).expect(200);

      await expect(insertReview(s)).rejects.toThrow(
        /only documents of the current revision of an instruction can be reviewed/,
      );
    });

    it.each<[string, string, string | null]>([
      ['an approval with a reason', 'APPROVED', 'Fine.'],
      ['a rejection without a reason', 'REJECTED', null],
      ['a rejection with a blank reason', 'REJECTED', ' \n '],
      ['a rejection with an empty reason', 'REJECTED', ''],
      ['a reason over 1000 characters', 'REJECTED', 'x'.repeat(1001)],
    ])('refuses %s', async (_case, decision, reason) => {
      const s = await scenario();

      await expect(insertReview(s, { decision, reason })).rejects.toThrow(
        /document_reviews_reason/,
      );
    });

    it('allows one review event per file version, and one event per document version', async () => {
      const s = await scenario();
      const document = ContractDocumentSchema.parse(
        (await review(s.trader.operator.cookie, s, 1, APPROVE).expect(200)).body,
      );
      const event = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'DOCUMENT_VERSION_REVIEWED' },
      });
      const record = (
        action: 'DOCUMENT_VERSION_REVIEWED' | 'DOCUMENT_VERSION_UPLOADED',
        payload: object,
      ) =>
        ctx.prisma.auditEvent.create({
          data: {
            action,
            actorUserId: event.actorUserId,
            actorOrganizationId: event.actorOrganizationId,
            voyageId: event.voyageId,
            payload,
          },
        });

      await expect(
        record('DOCUMENT_VERSION_REVIEWED', {
          documentId: document.id,
          versionNumber: 1,
          version: 9,
          decision: 'REJECTED',
        }),
      ).rejects.toThrow(/audit_events_one_document_review/);
      await expect(
        record('DOCUMENT_VERSION_UPLOADED', {
          documentId: document.id,
          versionNumber: 2,
          sha256: 'a'.repeat(64),
          version: 2,
        }),
      ).rejects.toThrow(/audit_events_one_document_change/);
      await expect(
        record('DOCUMENT_VERSION_REVIEWED', {
          documentId: document.id,
          versionNumber: 2,
          version: 3,
        }),
      ).rejects.toThrow(/audit_events_document_review_payload/);
      await expect(
        record('DOCUMENT_VERSION_REVIEWED', {
          documentId: document.id,
          versionNumber: 2,
          version: 3,
          decision: 'MAYBE',
        }),
      ).rejects.toThrow(/audit_events_document_review_payload/);
    });

    it('takes the reviews with their versions when the seed removes a document', async () => {
      const s = await scenario();
      await review(s.trader.operator.cookie, s, 1, reject(REASON)).expect(200);

      await ctx.prisma.document.deleteMany({ where: { voyageId: s.voyage.id } });

      expect(await ctx.prisma.documentVersion.count()).toBe(0);
      expect(await ctx.prisma.documentReview.count()).toBe(0);
      // The audit trail keeps what happened.
      expect(
        await ctx.prisma.auditEvent.count({ where: { action: 'DOCUMENT_VERSION_REVIEWED' } }),
      ).toBe(1);
    });
  });
});
