import { randomBytes } from 'node:crypto';
import {
  ACTION_ITEMS_DEFAULT_PAGE_SIZE,
  ACTION_ITEMS_MAX_PAGE_SIZE,
  type ActionItem,
  ActionItemPageSchema,
  type ContractDocument,
  ContractDocumentSchema,
  type DocumentaryInstruction,
  type DocumentaryInstructionContent,
  DocumentaryInstructionSchema,
  NoticeSchema,
  ProblemDetailsSchema,
  ProblemTypes,
  type RequiredDocumentType,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '../src/generated/prisma/client.js';
import { compareActionItems } from '../src/modules/action-center/action-items.js';
import { signIn } from './support/auth.js';
import { holdLock, waitForLockWaiters } from './support/concurrency.js';
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
const REASON = 'The consignee does not match the instructions.';
const reject = (reason = REASON) => ({ decision: 'REJECTED', reason }) as const;

const HOUR = 3_600_000;
const fromNow = (hours: number) => new Date(Date.now() + hours * HOUR);
/** A future instant on a whole second, so that one millisecond either side is exact. */
const wholeSecondFromNow = (hours: number) =>
  new Date(Math.ceil(fromNow(hours).getTime() / 1000) * 1000);

/** Bytes that start like a PDF. */
const pdf = (size = 2048) =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(Math.max(0, size - 9))]).subarray(0, size);

const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');

describe('Action Center (GET /api/action-items)', () => {
  let ctx: TestApp;
  let storage: TestStorage;
  /** The Action Center's clock: the real one unless a test sets it. */
  let clockAt: Date | undefined;
  const api = () => request(ctx.server);

  beforeAll(async () => {
    storage = await TestStorage.create();
    ctx = await createTestApp({ storage, actionCenterClock: () => clockAt ?? new Date() });
  });

  afterAll(async () => {
    await ctx.app.close();
    await storage.dispose();
  });

  beforeEach(async () => {
    clockAt = undefined;
    await resetDatabase(ctx.prisma);
    await storage.clear();
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
   * TF-A: Exporter → Trader → Buyer, with a surveyor and a shipping agent, who are party to
   * nothing. TF-B: the exporter sells straight to the buyer. Outsider participates in nothing.
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
      reference: 'TF-A',
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
      reference: 'TF-B',
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
      /** Exporter → Trader on TF-A. */
      c1: await contractAt(voyage.id, 1),
      /** Trader → Buyer on TF-A. */
      c2: await contractAt(voyage.id, 2),
      /** Exporter → Buyer on TF-B. */
      d1: await contractAt(other.id, 1),
    };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  // --- Reading the queue ---------------------------------------------------------------------

  const actionItems = (cookie: string | undefined, query: Record<string, string> = {}) => {
    const test = api().get('/api/action-items').query(query);
    return cookie === undefined ? test : test.set('Cookie', cookie);
  };

  async function pageOf(cookie: string, query: Record<string, string> = {}) {
    const response = await actionItems(cookie, query).expect(200);
    return ActionItemPageSchema.parse(response.body);
  }

  /** Every page, following cursors, and the pages themselves. */
  async function walk(cookie: string, query: Record<string, string> = {}) {
    const pages: ActionItem[][] = [];
    let cursor: string | null = null;
    do {
      const page = await pageOf(cookie, { ...query, ...(cursor ? { cursor } : {}) });
      pages.push(page.items);
      cursor = page.nextCursor;
      if (pages.length > 50) throw new Error('The cursors do not end');
    } while (cursor);
    return { items: pages.flat(), pages };
  }

  /** The whole queue of `cookie`, in page order. */
  const queue = async (cookie: string, query: Record<string, string> = {}) =>
    (await walk(cookie, { limit: String(ACTION_ITEMS_MAX_PAGE_SIZE), ...query })).items;

  const keysOf = (items: readonly ActionItem[]) => items.map(({ key }) => key);
  const sortedKeys = async (cookie: string) => keysOf(await queue(cookie)).sort();

  // --- The commands, through the API ---------------------------------------------------------

  async function issueNotice(
    seller: Party,
    voyageId: string,
    contractId: string,
    dueAt = fromNow(24),
  ) {
    const response = await api()
      .post(`/api/voyages/${voyageId}/notices`)
      .set('Cookie', seller.operator.cookie)
      .send({
        contractId,
        estimatedArrivalAt: new Date(dueAt.getTime() + 72 * HOUR).toISOString(),
        acknowledgementDueAt: dueAt.toISOString(),
        message: 'Vessel sailed Santos; ETA Rotterdam as stated.',
      })
      .expect(201);
    return NoticeSchema.parse(response.body);
  }

  const acknowledgeNotice = (buyer: Party, voyageId: string, noticeId: string) =>
    api()
      .post(`/api/voyages/${voyageId}/notices/${noticeId}/acknowledgement`)
      .set('Cookie', buyer.operator.cookie)
      .expect(200);

  const instructionPath = (voyageId: string, contractId: string) =>
    `/api/voyages/${voyageId}/contracts/${contractId}/documentary-instructions`;

  async function giveInstructions(
    buyer: Party,
    voyageId: string,
    contractId: string,
    content = firstContent,
  ) {
    const response = await api()
      .put(instructionPath(voyageId, contractId))
      .set('Cookie', buyer.operator.cookie)
      .set('If-None-Match', '*')
      .send(content)
      .expect(201);
    return DocumentaryInstructionSchema.parse(response.body);
  }

  async function reviseInstructions(
    buyer: Party,
    voyageId: string,
    contractId: string,
    basedOn: DocumentaryInstruction,
    content = secondContent,
  ) {
    const response = await api()
      .put(instructionPath(voyageId, contractId))
      .set('Cookie', buyer.operator.cookie)
      .set('If-Match', `"${basedOn.version}"`)
      .send(content)
      .expect(200);
    return DocumentaryInstructionSchema.parse(response.body);
  }

  async function acknowledgeInstructions(
    seller: Party,
    voyageId: string,
    contractId: string,
    instruction: DocumentaryInstruction,
  ) {
    const response = await api()
      .post(
        `${instructionPath(voyageId, contractId)}/revisions/${instruction.currentRevision.number}/acknowledgement`,
      )
      .set('Cookie', seller.operator.cookie)
      .set('If-Match', `"${instruction.version}"`)
      .expect(200);
    return DocumentaryInstructionSchema.parse(response.body);
  }

  /** One document: a type required by one revision of the instructions under a contract. */
  interface DocumentAt {
    voyageId: string;
    contractId: string;
    revision: number;
    type: RequiredDocumentType;
  }

  const documentPath = ({ voyageId, contractId, revision, type }: DocumentAt) =>
    `${instructionPath(voyageId, contractId)}/revisions/${revision}/documents/${type}`;

  /** The first file of a document, or a replacement of the document as `basedOn` left it. */
  async function uploadFile(seller: Party, at: DocumentAt, basedOn?: ContractDocument) {
    const response = await api()
      .post(`${documentPath(at)}/versions`)
      .set('Cookie', seller.operator.cookie)
      .set(basedOn ? { 'If-Match': `"${basedOn.version}"` } : { 'If-None-Match': '*' })
      .attach('file', pdf(), { filename: 'presented.pdf', contentType: 'application/pdf' })
      .expect(201);
    return ContractDocumentSchema.parse(response.body);
  }

  /** The buyer's decision on the document's latest file, as `basedOn` left it. */
  async function reviewFile(
    buyer: Party,
    at: DocumentAt,
    basedOn: ContractDocument,
    body: typeof APPROVE | ReturnType<typeof reject>,
  ) {
    const response = await api()
      .post(`${documentPath(at)}/versions/${basedOn.currentVersion.number}/review`)
      .set('Cookie', buyer.operator.cookie)
      .set('If-Match', `"${basedOn.version}"`)
      .send(body)
      .expect(200);
    return ContractDocumentSchema.parse(response.body);
  }

  /**
   * One action of every type, on both sides of the trader, all through the API:
   *
   * - c1 (Exporter → Trader): a notice, revision 1, a pending bill of lading and a rejected
   *   phytosanitary certificate. The trader owes the acknowledgement and the review; the
   *   exporter owes the acknowledgement of the revision and the replacement.
   * - c2 (Trader → Buyer): a notice, revision 1, a pending bill of lading. The buyer owes the
   *   acknowledgement and the review; the trader the acknowledgement of the revision.
   * - d1 (Exporter → Buyer, TF-B): a notice the buyer owes.
   */
  async function everyAction(s: Scenario) {
    const at = (contractId: string, type: RequiredDocumentType, voyageId = s.voyage.id) => ({
      voyageId,
      contractId,
      revision: 1,
      type,
    });
    const targets = {
      billOfLading1: at(s.c1, 'BILL_OF_LADING'),
      certificate1: at(s.c1, 'PHYTOSANITARY_CERTIFICATE'),
      billOfLading2: at(s.c2, 'BILL_OF_LADING'),
    };

    const n1 = await issueNotice(s.exporter, s.voyage.id, s.c1);
    const i1 = await giveInstructions(s.trader, s.voyage.id, s.c1);
    const billOfLading1 = await uploadFile(s.exporter, targets.billOfLading1);
    const certificate1 = await reviewFile(
      s.trader,
      targets.certificate1,
      await uploadFile(s.exporter, targets.certificate1),
      reject(),
    );

    const n2 = await issueNotice(s.trader, s.voyage.id, s.c2);
    const i2 = await giveInstructions(s.buyer, s.voyage.id, s.c2);
    const billOfLading2 = await uploadFile(s.trader, targets.billOfLading2);

    const n3 = await issueNotice(s.exporter, s.other.id, s.d1);

    const keys = {
      n1: `ACKNOWLEDGE_NOTICE:${n1.id}`,
      i1: `ACKNOWLEDGE_INSTRUCTIONS:${i1.id}:1`,
      billOfLading1: `REVIEW_DOCUMENT:${billOfLading1.id}:1`,
      certificate1: `REPLACE_REJECTED_DOCUMENT:${certificate1.id}:1`,
      n2: `ACKNOWLEDGE_NOTICE:${n2.id}`,
      i2: `ACKNOWLEDGE_INSTRUCTIONS:${i2.id}:1`,
      billOfLading2: `REVIEW_DOCUMENT:${billOfLading2.id}:1`,
      n3: `ACKNOWLEDGE_NOTICE:${n3.id}`,
    };
    return { n1, i1, billOfLading1, certificate1, n2, i2, billOfLading2, n3, targets, keys };
  }
  type Actions = Awaited<ReturnType<typeof everyAction>>;

  const exporterKeys = (a: Actions) => [a.keys.i1, a.keys.certificate1].sort();
  const traderKeys = (a: Actions) => [a.keys.n1, a.keys.billOfLading1, a.keys.i2].sort();
  const buyerKeys = (a: Actions) => [a.keys.n2, a.keys.billOfLading2, a.keys.n3].sort();

  const orgRef = ({ organization }: Party) => ({
    id: organization.id,
    name: organization.name,
    countryCode: organization.countryCode,
  });

  // --- Tests -------------------------------------------------------------------------------

  it('refuses a request without a valid session with 401', async () => {
    const response = await actionItems(undefined).expect(401);
    expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
    await actionItems('tradeflow_session=not-a-session').expect(401);
  });

  describe('who owes what', () => {
    it('gives each action to the side of the contract that owes it, for all four types', async () => {
      const s = await scenario();
      const a = await everyAction(s);

      expect(await sortedKeys(s.exporter.operator.cookie)).toEqual(exporterKeys(a));
      expect(await sortedKeys(s.trader.operator.cookie)).toEqual(traderKeys(a));
      expect(await sortedKeys(s.buyer.operator.cookie)).toEqual(buyerKeys(a));

      const byKey = new Map(
        (
          await Promise.all(
            [s.exporter, s.trader, s.buyer].map((party) => queue(party.operator.cookie)),
          )
        )
          .flat()
          .map((item) => [item.key, item]),
      );
      const side = (key: string) => {
        const item = byKey.get(key);
        return [item?.type, item?.contract.id, item?.counterparty.id];
      };
      // The buyer acknowledges notices and reviews files; the seller acknowledges revisions and
      // replaces rejected files.
      expect(side(a.keys.n1)).toEqual(['ACKNOWLEDGE_NOTICE', s.c1, s.exporter.organization.id]);
      expect(side(a.keys.billOfLading1)).toEqual([
        'REVIEW_DOCUMENT',
        s.c1,
        s.exporter.organization.id,
      ]);
      expect(side(a.keys.i1)).toEqual(['ACKNOWLEDGE_INSTRUCTIONS', s.c1, s.trader.organization.id]);
      expect(side(a.keys.certificate1)).toEqual([
        'REPLACE_REJECTED_DOCUMENT',
        s.c1,
        s.trader.organization.id,
      ]);
      expect(side(a.keys.n3)).toEqual(['ACKNOWLEDGE_NOTICE', s.d1, s.exporter.organization.id]);
    });

    it('gives a trader the buyer’s actions under one contract and the seller’s under the next', async () => {
      const s = await scenario();
      const a = await everyAction(s);

      const items = await queue(s.trader.operator.cookie);
      const asBuyer = items.filter(({ contract }) => contract.id === s.c1);
      const asSeller = items.filter(({ contract }) => contract.id === s.c2);

      expect(asBuyer.map(({ type }) => type).sort()).toEqual([
        'ACKNOWLEDGE_NOTICE',
        'REVIEW_DOCUMENT',
      ]);
      expect(
        asBuyer.every(({ counterparty }) => counterparty.id === s.exporter.organization.id),
      ).toBe(true);
      expect(asBuyer.every(({ contract }) => contract.position === 1)).toBe(true);
      expect(asSeller.map(({ key }) => key)).toEqual([a.keys.i2]);
      expect(asSeller[0]?.counterparty).toEqual(orgRef(s.buyer));
      expect(asSeller[0]?.contract).toEqual({ id: s.c2, position: 2 });
      // Notices come first, then the rest in waiting order.
      expect([...items].sort(compareActionItems)).toEqual(items);
      expect(items[0]?.key).toBe(a.keys.n1);
    });

    it('serves viewers exactly what it serves operators', async () => {
      const s = await scenario();
      await everyAction(s);
      clockAt = new Date();

      for (const party of [s.exporter, s.trader, s.buyer]) {
        const asOperator = await actionItems(party.operator.cookie).expect(200);
        const asViewer = await actionItems(party.viewer.cookie).expect(200);
        expect(ActionItemPageSchema.parse(asOperator.body).items.length).toBeGreaterThan(0);
        expect(asViewer.body).toEqual(asOperator.body);
      }
    });

    it('answers service providers and outsiders with an empty page, not an error', async () => {
      const s = await scenario();
      await everyAction(s);
      clockAt = new Date();

      for (const party of [s.surveyor, s.agent, s.outsider]) {
        for (const cookie of [party.operator.cookie, party.viewer.cookie]) {
          const response = await actionItems(cookie).expect(200);
          expect(response.body).toEqual({
            items: [],
            generatedAt: clockAt.toISOString(),
            nextCursor: null,
          });
        }
      }
    });

    it('hides another contract’s actions on a voyage the organization participates in', async () => {
      const s = await scenario();
      const a = await everyAction(s);

      // The buyer and the exporter both participate in TF-A, but each is party to one contract.
      const buyerItems = await queue(s.buyer.operator.cookie);
      expect(buyerItems.map(({ contract }) => contract.id).sort()).toEqual(
        [s.c2, s.c2, s.d1].sort(),
      );
      expect(JSON.stringify(buyerItems)).not.toContain(s.c1);
      for (const key of [...exporterKeys(a), ...traderKeys(a)]) {
        expect(keysOf(buyerItems)).not.toContain(key);
      }

      const exporterItems = await queue(s.exporter.operator.cookie);
      expect(JSON.stringify(exporterItems)).not.toContain(s.c2);
      expect(keysOf(exporterItems)).not.toContain(a.keys.n1);
    });

    it('takes the organization from the session only: supplied identifiers widen nothing', async () => {
      const s = await scenario();
      await everyAction(s);
      clockAt = new Date();
      const own = (await actionItems(s.buyer.operator.cookie).expect(200)).body as unknown;

      for (const query of [
        { organizationId: s.exporter.organization.id },
        { organization: s.trader.organization.id },
        { orgId: s.trader.organization.id, sellerId: s.exporter.organization.id },
        { buyerId: s.trader.organization.id, contractId: s.c1, voyageId: s.voyage.id },
      ]) {
        const response = await actionItems(s.buyer.operator.cookie, query).expect(200);
        expect(response.body).toEqual(own);
      }
      const withHeader = await actionItems(s.buyer.operator.cookie)
        .set('X-Organization-Id', s.trader.organization.id)
        .expect(200);
      expect(withHeader.body).toEqual(own);
    });

    it('keeps another organization’s cursor within what its bearer may see', async () => {
      const s = await scenario();
      const a = await everyAction(s);

      const traderFirst = await pageOf(s.trader.operator.cookie, { limit: '1' });
      const cursorAfter = traderFirst.items[0];
      expect(cursorAfter?.key).toBe(a.keys.n1);

      const buyerAll = await queue(s.buyer.operator.cookie);
      const replayed = await pageOf(s.buyer.operator.cookie, {
        cursor: traderFirst.nextCursor ?? '',
        limit: String(ACTION_ITEMS_MAX_PAGE_SIZE),
      });
      // A position in the same order, nothing more: the buyer's own actions after it.
      expect(keysOf(replayed.items)).toEqual(
        keysOf(buyerAll.filter((item) => cursorAfter && compareActionItems(item, cursorAfter) > 0)),
      );
      for (const item of replayed.items) {
        expect([s.c2, s.d1]).toContain(item.contract.id);
      }
    });
  });

  describe('what an item carries', () => {
    it('serves exactly the allowlisted fields of each type, and nothing of the records', async () => {
      const s = await scenario();
      const a = await everyAction(s);
      clockAt = new Date();

      const traderBody = (await actionItems(s.trader.operator.cookie).expect(200)).body as {
        items: Record<string, unknown>[];
      };
      const exporterBody = (await actionItems(s.exporter.operator.cookie).expect(200)).body as {
        items: Record<string, unknown>[];
      };
      expect(Object.keys(traderBody).sort()).toEqual(['generatedAt', 'items', 'nextCursor']);
      const item = (body: { items: Record<string, unknown>[] }, key: string) =>
        body.items.find((candidate) => candidate.key === key);
      const voyage = { id: s.voyage.id, reference: 'TF-A' };
      const c1 = { id: s.c1, position: 1 };
      const c1Target = { voyageId: s.voyage.id, contractId: s.c1 };

      expect(item(traderBody, a.keys.n1)).toStrictEqual({
        key: a.keys.n1,
        type: 'ACKNOWLEDGE_NOTICE',
        voyage,
        contract: c1,
        counterparty: orgRef(s.exporter),
        issuedAt: a.n1.issuedAt,
        acknowledgementDueAt: a.n1.acknowledgementDueAt,
        overdue: false,
        target: { kind: 'NOTICE', ...c1Target, noticeId: a.n1.id },
      });
      expect(item(traderBody, a.keys.billOfLading1)).toStrictEqual({
        key: a.keys.billOfLading1,
        type: 'REVIEW_DOCUMENT',
        voyage,
        contract: c1,
        counterparty: orgRef(s.exporter),
        uploadedAt: a.billOfLading1.currentVersion.uploadedAt,
        target: {
          kind: 'DOCUMENT_VERSION',
          ...c1Target,
          revisionNumber: 1,
          documentType: 'BILL_OF_LADING',
          documentId: a.billOfLading1.id,
          versionNumber: 1,
        },
      });
      expect(item(exporterBody, a.keys.i1)).toStrictEqual({
        key: a.keys.i1,
        type: 'ACKNOWLEDGE_INSTRUCTIONS',
        voyage,
        contract: c1,
        counterparty: orgRef(s.trader),
        revisionCreatedAt: a.i1.currentRevision.createdAt,
        target: {
          kind: 'INSTRUCTION_REVISION',
          ...c1Target,
          instructionId: a.i1.id,
          revisionNumber: 1,
        },
      });
      expect(item(exporterBody, a.keys.certificate1)).toStrictEqual({
        key: a.keys.certificate1,
        type: 'REPLACE_REJECTED_DOCUMENT',
        voyage,
        contract: c1,
        counterparty: orgRef(s.trader),
        uploadedAt: a.certificate1.currentVersion.uploadedAt,
        rejectedAt: a.certificate1.currentVersion.review?.reviewedAt,
        rejectionReason: REASON,
        target: {
          kind: 'DOCUMENT_VERSION',
          ...c1Target,
          revisionNumber: 1,
          documentType: 'PHYTOSANITARY_CERTIFICATE',
          documentId: a.certificate1.id,
          versionNumber: 1,
        },
      });

      // Nothing the panels own: no message, consignee, file name, checksum or people.
      const served = JSON.stringify([traderBody, exporterBody]);
      for (const secret of [
        'Vessel sailed Santos',
        firstContent.consignee,
        'presented.pdf',
        'sha256',
        'fileName',
        s.trader.operator.user.email,
        s.exporter.operator.user.email,
      ]) {
        expect(served).not.toContain(secret);
      }
    });

    it('changes nothing it reads', async () => {
      const s = await scenario();
      await everyAction(s);
      const snapshot = async () => ({
        audit: await ctx.prisma.auditEvent.findMany({ orderBy: { id: 'asc' } }),
        notices: await ctx.prisma.notice.findMany({ orderBy: { id: 'asc' } }),
        documents: await ctx.prisma.document.findMany({ orderBy: { id: 'asc' } }),
        instructions: await ctx.prisma.documentaryInstruction.findMany({ orderBy: { id: 'asc' } }),
      });
      const before = await snapshot();

      for (const party of [s.exporter, s.trader, s.buyer]) await queue(party.viewer.cookie);

      expect(await snapshot()).toEqual(before);
    });
  });

  describe('as the records change', () => {
    it('drops exactly the acknowledged notice and revision', async () => {
      const s = await scenario();
      const a = await everyAction(s);

      await acknowledgeNotice(s.trader, s.voyage.id, a.n1.id);
      expect(await sortedKeys(s.trader.operator.cookie)).toEqual(
        [a.keys.billOfLading1, a.keys.i2].sort(),
      );
      // The buyer's notice under the next contract is the buyer's to acknowledge.
      expect(await sortedKeys(s.buyer.operator.cookie)).toEqual(buyerKeys(a));

      await acknowledgeInstructions(s.exporter, s.voyage.id, s.c1, a.i1);
      expect(await sortedKeys(s.exporter.operator.cookie)).toEqual([a.keys.certificate1]);

      await acknowledgeInstructions(s.trader, s.voyage.id, s.c2, a.i2);
      expect(await sortedKeys(s.trader.operator.cookie)).toEqual([a.keys.billOfLading1]);
    });

    it('turns a rejection into the seller’s replacement, with the reason', async () => {
      const s = await scenario();
      const a = await everyAction(s);
      const reason = 'Wrong consignee on page 1.';

      const rejected = await reviewFile(
        s.trader,
        a.targets.billOfLading1,
        a.billOfLading1,
        reject(reason),
      );

      const replaceKey = `REPLACE_REJECTED_DOCUMENT:${a.billOfLading1.id}:1`;
      expect(await sortedKeys(s.trader.operator.cookie)).toEqual([a.keys.n1, a.keys.i2].sort());
      const exporterItems = await queue(s.exporter.operator.cookie);
      expect(keysOf(exporterItems).sort()).toEqual([...exporterKeys(a), replaceKey].sort());
      expect(exporterItems.find(({ key }) => key === replaceKey)).toMatchObject({
        rejectionReason: reason,
        uploadedAt: a.billOfLading1.currentVersion.uploadedAt,
        rejectedAt: rejected.currentVersion.review?.reviewedAt,
      });
    });

    it('turns a replacement into the buyer’s review of the new file', async () => {
      const s = await scenario();
      const a = await everyAction(s);

      const replaced = await uploadFile(s.exporter, a.targets.certificate1, a.certificate1);

      expect(await sortedKeys(s.exporter.operator.cookie)).toEqual([a.keys.i1]);
      const traderItems = await queue(s.trader.operator.cookie);
      const reviewKey = `REVIEW_DOCUMENT:${a.certificate1.id}:2`;
      expect(keysOf(traderItems).sort()).toEqual([...traderKeys(a), reviewKey].sort());
      expect(traderItems.find(({ key }) => key === reviewKey)).toMatchObject({
        uploadedAt: replaced.currentVersion.uploadedAt,
        target: { documentId: a.certificate1.id, versionNumber: 2 },
      });
      // The rejected first file is history, for both sides.
      const everything = JSON.stringify([traderItems, await queue(s.exporter.operator.cookie)]);
      expect(everything).not.toContain(`${a.certificate1.id}:1`);

      // An approval of the new file ends the document's work on both sides.
      await reviewFile(s.trader, a.targets.certificate1, replaced, APPROVE);
      expect(await sortedKeys(s.trader.operator.cookie)).toEqual(traderKeys(a));
      expect(await sortedKeys(s.exporter.operator.cookie)).toEqual([a.keys.i1]);
    });

    it('drops review work once the file is approved', async () => {
      const s = await scenario();
      const a = await everyAction(s);

      await reviewFile(s.buyer, a.targets.billOfLading2, a.billOfLading2, APPROVE);
      await reviewFile(s.trader, a.targets.billOfLading1, a.billOfLading1, APPROVE);

      expect(await sortedKeys(s.buyer.operator.cookie)).toEqual([a.keys.n2, a.keys.n3].sort());
      expect(await sortedKeys(s.trader.operator.cookie)).toEqual([a.keys.n1, a.keys.i2].sort());
      // Nothing for the sellers either: an approved file asks nothing of anyone.
      expect(await sortedKeys(s.exporter.operator.cookie)).toEqual(exporterKeys(a));
    });

    it('drops every action of a superseded revision once the next one is given', async () => {
      const s = await scenario();
      const a = await everyAction(s);
      const acknowledged = await acknowledgeInstructions(s.exporter, s.voyage.id, s.c1, a.i1);
      expect(await sortedKeys(s.exporter.operator.cookie)).toEqual([a.keys.certificate1]);

      const revised = await reviseInstructions(s.trader, s.voyage.id, s.c1, acknowledged);

      // Revision 2 is a new action for the seller; the documents of revision 1, pending or
      // rejected, ask nothing of either side any more.
      const nextKey = `ACKNOWLEDGE_INSTRUCTIONS:${a.i1.id}:2`;
      const exporterItems = await queue(s.exporter.operator.cookie);
      expect(keysOf(exporterItems)).toEqual([nextKey]);
      expect(exporterItems[0]).toMatchObject({
        revisionCreatedAt: revised.currentRevision.createdAt,
        target: { revisionNumber: 2 },
      });
      expect(await sortedKeys(s.trader.operator.cookie)).toEqual([a.keys.n1, a.keys.i2].sort());

      // A file presented against revision 2 is the trader's to review, under revision 2.
      const billOfLading = await uploadFile(s.exporter, {
        ...a.targets.billOfLading1,
        revision: 2,
      });
      const traderItems = await queue(s.trader.operator.cookie);
      expect(traderItems.find(({ type }) => type === 'REVIEW_DOCUMENT')).toMatchObject({
        key: `REVIEW_DOCUMENT:${billOfLading.id}:1`,
        target: { revisionNumber: 2, documentType: 'BILL_OF_LADING' },
      });
    });
  });

  describe('deadlines', () => {
    it('is overdue only strictly after the deadline, as of the one clock reading it serves', async () => {
      const s = await scenario();
      const dueAt = wholeSecondFromNow(48);
      const notice = await issueNotice(s.exporter, s.voyage.id, s.c1, dueAt);
      const key = `ACKNOWLEDGE_NOTICE:${notice.id}`;

      for (const [offset, overdue] of [
        [-1, false],
        [0, false],
        [1, true],
      ] as const) {
        clockAt = new Date(dueAt.getTime() + offset);
        const page = await pageOf(s.trader.viewer.cookie);
        expect(page.generatedAt).toBe(clockAt.toISOString());
        expect(
          page.items.map((item) => [item.key, item.type === 'ACKNOWLEDGE_NOTICE' && item.overdue]),
        ).toEqual([[key, overdue]]);

        const onlyOverdue = await pageOf(s.trader.viewer.cookie, { overdue: 'true' });
        expect(keysOf(onlyOverdue.items)).toEqual(overdue ? [key] : []);
        expect(onlyOverdue.generatedAt).toBe(clockAt.toISOString());
      }
    });

    it('orders by deadline, so an overdue notice keeps its place, and drops it once acknowledged late', async () => {
      const s = await scenario();
      const early = await issueNotice(s.exporter, s.voyage.id, s.c1, wholeSecondFromNow(30));
      const late = await issueNotice(s.exporter, s.voyage.id, s.c1, wholeSecondFromNow(60));
      await giveInstructions(s.trader, s.voyage.id, s.c1);
      const expected = [`ACKNOWLEDGE_NOTICE:${early.id}`, `ACKNOWLEDGE_NOTICE:${late.id}`];

      const before = await queue(s.trader.operator.cookie);
      clockAt = new Date(new Date(early.acknowledgementDueAt).getTime() + 1);
      const after = await queue(s.trader.operator.cookie);

      expect(keysOf(before)).toEqual(expected);
      expect(keysOf(after)).toEqual(expected);
      expect(after.map((item) => item.type === 'ACKNOWLEDGE_NOTICE' && item.overdue)).toEqual([
        true,
        false,
      ]);

      await acknowledgeNotice(s.trader, s.voyage.id, early.id);
      expect(keysOf(await queue(s.trader.operator.cookie))).toEqual([expected[1]]);
    });
  });

  describe('filters and pages', () => {
    it('filters by type and by overdue before the page is cut', async () => {
      const s = await scenario();
      const a = await everyAction(s);
      const trader = s.trader.operator.cookie;

      expect(keysOf(await queue(trader, { type: 'REVIEW_DOCUMENT' }))).toEqual([
        a.keys.billOfLading1,
      ]);
      expect(keysOf(await queue(trader, { type: 'ACKNOWLEDGE_INSTRUCTIONS' }))).toEqual([
        a.keys.i2,
      ]);
      expect(keysOf(await queue(trader, { type: 'REPLACE_REJECTED_DOCUMENT' }))).toEqual([]);
      expect(keysOf(await queue(trader, { overdue: 'true' }))).toEqual([]);

      clockAt = new Date(new Date(a.n1.acknowledgementDueAt).getTime() + 1);
      expect(keysOf(await queue(trader, { overdue: 'true' }))).toEqual([a.keys.n1]);
      expect(keysOf(await queue(trader, { type: 'ACKNOWLEDGE_NOTICE', overdue: 'true' }))).toEqual([
        a.keys.n1,
      ]);
      expect(keysOf(await queue(trader, { type: 'REVIEW_DOCUMENT', overdue: 'true' }))).toEqual([]);

      // A filtered page is cut after filtering: one item, and nothing follows it.
      const page = await pageOf(trader, { type: 'REVIEW_DOCUMENT', limit: '1' });
      expect(keysOf(page.items)).toEqual([a.keys.billOfLading1]);
      expect(page.nextCursor).toBeNull();
    });

    it(`serves ${ACTION_ITEMS_DEFAULT_PAGE_SIZE} by default and at most ${ACTION_ITEMS_MAX_PAGE_SIZE}`, async () => {
      const s = await scenario();
      // Volume, not workflow: notices written directly, as the API would leave them.
      const issuedAt = fromNow(-1);
      await ctx.prisma.notice.createMany({
        data: Array.from({ length: 55 }, (_, index) => ({
          voyageId: s.voyage.id,
          tradeContractId: s.c1,
          type: 'ETA' as const,
          estimatedArrivalAt: fromNow(200),
          acknowledgementDueAt: new Date(issuedAt.getTime() + (index + 2) * HOUR),
          issuedByUserId: s.exporter.operator.user.id,
          issuedByOrganizationId: s.exporter.organization.id,
          issuedAt,
        })),
      });

      const byDefault = await pageOf(s.trader.operator.cookie);
      expect(byDefault.items).toHaveLength(ACTION_ITEMS_DEFAULT_PAGE_SIZE);
      expect(byDefault.nextCursor).not.toBeNull();

      const largest = await walk(s.trader.operator.cookie, {
        limit: String(ACTION_ITEMS_MAX_PAGE_SIZE),
      });
      expect(largest.pages.map((page) => page.length)).toEqual([ACTION_ITEMS_MAX_PAGE_SIZE, 5]);
      expect(new Set(keysOf(largest.items)).size).toBe(55);
      expect([...largest.items].sort(compareActionItems)).toEqual(largest.items);
    });

    it('pages through equal deadlines in key order, each action once', async () => {
      const s = await scenario();
      const dueAt = wholeSecondFromNow(36);
      for (let i = 0; i < 5; i += 1) await issueNotice(s.exporter, s.voyage.id, s.c1, dueAt);

      const { items, pages } = await walk(s.trader.operator.cookie, { limit: '2' });

      expect(pages.map((page) => page.length)).toEqual([2, 2, 1]);
      expect(
        new Set(
          items.map((item) => item.type === 'ACKNOWLEDGE_NOTICE' && item.acknowledgementDueAt),
        ),
      ).toEqual(new Set([dueAt.toISOString()]));
      expect(keysOf(items)).toEqual(keysOf(items).sort());
      expect(new Set(keysOf(items)).size).toBe(5);
      expect(keysOf(items)).toEqual(keysOf(await queue(s.trader.operator.cookie)));
    });

    it('serves each action at most once while the queue changes between pages', async () => {
      const s = await scenario();
      const base = wholeSecondFromNow(24).getTime();
      const due = (hours: number) => new Date(base + hours * HOUR);
      const issue = (hours: number) => issueNotice(s.exporter, s.voyage.id, s.c1, due(hours));
      const [n1, n2, n3, n4, n5] = [
        await issue(1),
        await issue(2),
        await issue(3),
        await issue(4),
        await issue(5),
      ];
      const key = (notice: { id: string }) => `ACKNOWLEDGE_NOTICE:${notice.id}`;
      const trader = s.trader.operator.cookie;

      const first = await pageOf(trader, { limit: '2' });
      expect(keysOf(first.items)).toEqual([key(n1), key(n2)]);

      // Meanwhile: one served action and one not yet served are answered; one new action sorts
      // after the cursor (a later deadline), one before it (an earlier deadline).
      await acknowledgeNotice(s.trader, s.voyage.id, n2.id);
      await acknowledgeNotice(s.trader, s.voyage.id, n4.id);
      const later = await issue(6);
      const earlier = await issue(0.5);

      const rest = await walk(trader, { limit: '2', cursor: first.nextCursor ?? '' });
      expect(rest.pages.map(keysOf)).toEqual([[key(n3), key(n5)], [key(later)]]);

      const served = [...keysOf(first.items), ...keysOf(rest.items)];
      expect(new Set(served).size).toBe(served.length);
      expect(served).not.toContain(key(n4));
      // Missed by this walk, which had passed its place; the first page shows it.
      expect(served).not.toContain(key(earlier));
      expect(keysOf(await queue(trader))).toEqual([
        key(earlier),
        key(n1),
        key(n3),
        key(n5),
        key(later),
      ]);
    });
  });

  describe('invalid requests', () => {
    const position = '2026-12-01T00:00:00.000Z';

    it.each([
      ['limit 0', { limit: '0' }, 'query.limit'],
      [
        `limit ${ACTION_ITEMS_MAX_PAGE_SIZE + 1}`,
        { limit: String(ACTION_ITEMS_MAX_PAGE_SIZE + 1) },
        'query.limit',
      ],
      ['a negative limit', { limit: '-1' }, 'query.limit'],
      ['a fractional limit', { limit: '1.5' }, 'query.limit'],
      ['a limit in words', { limit: 'ten' }, 'query.limit'],
      ['a zero-padded limit', { limit: '020' }, 'query.limit'],
      ['an empty limit', { limit: '' }, 'query.limit'],
      ['an unknown type', { type: 'PAY_INVOICE' }, 'query.type'],
      ['a type in lower case', { type: 'acknowledge_notice' }, 'query.type'],
      ['overdue=false', { overdue: 'false' }, 'query.overdue'],
      ['overdue=1', { overdue: '1' }, 'query.overdue'],
      ['a cursor that is not base64 JSON', { cursor: 'bm90IGpzb24' }, 'query.cursor'],
      ['a cursor outside base64url', { cursor: 'abc+/=' }, 'query.cursor'],
      ['a cursor of the wrong shape', { cursor: encode({ at: position }) }, 'query.cursor'],
      ['a cursor with a bad flag', { cursor: encode([2, position, 'K']) }, 'query.cursor'],
      ['a cursor with no time', { cursor: encode([1, 'yesterday', 'K']) }, 'query.cursor'],
      ['a cursor with an empty key', { cursor: encode([0, position, '']) }, 'query.cursor'],
      ['an over-long cursor', { cursor: 'a'.repeat(301) }, 'query.cursor'],
      ['an empty cursor', { cursor: '' }, 'query.cursor'],
    ])('refuses %s with 400 Problem Details', async (_, query, path) => {
      const s = await scenario();

      const response = await actionItems(s.trader.operator.cookie, query).expect(400);

      expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
      const problem = ProblemDetailsSchema.parse(response.body);
      expect(problem.type).toBe(ProblemTypes.ValidationFailed);
      expect(problem.errors?.map((error) => error.path)).toEqual([path]);
    });

    it('refuses a cursor it did not issue before reading anything', async () => {
      const s = await scenario();
      // Any read of the scope would wait for this lock; the refusal must not.
      const lock = await holdLock(ctx.prisma, (tx) =>
        tx.$executeRawUnsafe('LOCK TABLE trade_contracts IN ACCESS EXCLUSIVE MODE'),
      );
      try {
        const response = await actionItems(s.trader.operator.cookie, {
          cursor: encode([1, 'not a time', 'K']),
        }).expect(400);
        expect(ProblemDetailsSchema.parse(response.body).errors?.map(({ path }) => path)).toEqual([
          'query.cursor',
        ]);
      } finally {
        await lock.release();
      }
    });
  });

  describe('consistency', () => {
    it('builds a page from one snapshot when a change commits between its reads', async () => {
      const s = await scenario();
      const instruction = await giveInstructions(s.trader, s.voyage.id, s.c1);
      const key = `ACKNOWLEDGE_INSTRUCTIONS:${instruction.id}:1`;
      expect(keysOf(await queue(s.exporter.operator.cookie))).toEqual([key]);

      // The page reads the contracts in scope, then notices, then instructions. Holding notices
      // stops it after its first read, with its snapshot taken.
      const lock = await holdLock(ctx.prisma, (tx) =>
        tx.$executeRawUnsafe('LOCK TABLE notices IN ACCESS EXCLUSIVE MODE'),
      );
      let settled = false;
      const pending = pageOf(s.exporter.operator.cookie).finally(() => {
        settled = true;
      });
      try {
        await waitForLockWaiters(ctx.prisma, 1);

        // The seller acknowledges meanwhile; it touches no notice, so it commits right away.
        await acknowledgeInstructions(s.exporter, s.voyage.id, s.c1, instruction);
        expect(settled).toBe(false);
      } finally {
        await lock.release();
      }

      // The instruction read came after that commit, but within the page's snapshot.
      expect(keysOf((await pending).items)).toEqual([key]);
      expect(keysOf(await queue(s.exporter.operator.cookie))).toEqual([]);
    });
  });
});
