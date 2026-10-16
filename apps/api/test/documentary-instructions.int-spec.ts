import {
  type DocumentaryInstruction,
  type DocumentaryInstructionContent,
  DocumentaryInstructionListResponseSchema,
  DocumentaryInstructionSchema,
  ProblemDetailsSchema,
  ProblemTypes,
  REQUIRED_DOCUMENT_TYPES,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
import { createTestApp, type TestApp } from './support/test-app.js';

const MISSING_ID = '01990000-0000-7000-8008-999999999999';

const firstContent: DocumentaryInstructionContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  notifyParty: 'Trader SA\nRue du Rhône 1, Geneva',
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 3 },
    { document: 'PHYTOSANITARY_CERTIFICATE', originals: 1, copies: 0 },
  ],
};

const secondContent: DocumentaryInstructionContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 2 },
    { document: 'CERTIFICATE_OF_ORIGIN', originals: 1, copies: 1 },
  ],
};

describe('Documentary instructions', () => {
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
   * TF-D: Exporter → Trader → Buyer, with a surveyor and a shipping agent. Under contract 1 the
   * trader buys from the exporter, so the trader gives the instructions and the exporter
   * acknowledges them. TF-OTHER: the exporter sells straight to the buyer. Outsider participates
   * in nothing.
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
      reference: 'TF-D',
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
      /** Exporter → Trader on TF-D. */
      c1: await contractAt(voyage.id, 1),
      /** Trader → Buyer on TF-D. */
      c2: await contractAt(voyage.id, 2),
      /** Exporter → Buyer on TF-OTHER. */
      d1: await contractAt(other.id, 1),
    };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  const listPath = (voyageId: string) => `/api/voyages/${voyageId}/documentary-instructions`;
  const instructionPath = (voyageId: string, contractId: string) =>
    `/api/voyages/${voyageId}/contracts/${contractId}/documentary-instructions`;
  const acknowledgementPath = (voyageId: string, contractId: string, revision: number | string) =>
    `${instructionPath(voyageId, contractId)}/revisions/${revision}/acknowledgement`;

  const put = (
    cookie: string,
    voyageId: string,
    contractId: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) =>
    http()
      .put(instructionPath(voyageId, contractId))
      .set('Cookie', cookie)
      .set(headers)
      .send(body as object);

  const give = (
    cookie: string,
    voyageId: string,
    contractId: string,
    body: unknown = firstContent,
  ) => put(cookie, voyageId, contractId, body, { 'If-None-Match': '*' });

  const revise = (
    cookie: string,
    voyageId: string,
    contractId: string,
    version: number | string,
    body: unknown = secondContent,
  ) =>
    put(cookie, voyageId, contractId, body, {
      'If-Match': typeof version === 'number' ? `"${version}"` : version,
    });

  const acknowledge = (
    cookie: string,
    voyageId: string,
    contractId: string,
    revision: number | string,
    version?: number | string,
  ) => {
    const call = http()
      .post(acknowledgementPath(voyageId, contractId, revision))
      .set('Cookie', cookie);
    return version === undefined
      ? call
      : call.set('If-Match', typeof version === 'number' ? `"${version}"` : version);
  };

  const read = (cookie: string, voyageId: string, contractId: string) =>
    http().get(instructionPath(voyageId, contractId)).set('Cookie', cookie);

  /** Gives the first instructions under `contractId` as `cookie` and returns them. */
  async function given(cookie: string, voyageId: string, contractId: string) {
    const response = await give(cookie, voyageId, contractId).expect(201);
    return DocumentaryInstructionSchema.parse(response.body);
  }

  /** Every row the commands could write. */
  const writes = async () => ({
    instructions: await ctx.prisma.documentaryInstruction.count(),
    revisions: await ctx.prisma.documentaryInstructionRevision.count(),
    acknowledgements: await ctx.prisma.documentaryInstructionAcknowledgement.count(),
    auditEvents: await ctx.prisma.auditEvent.count(),
  });

  const versionOf = async (contractId: string) =>
    (
      await ctx.prisma.documentaryInstruction.findUniqueOrThrow({
        where: { tradeContractId: contractId },
      })
    ).version;

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
  const notFound = (detail: string) => problem(404, 'Not Found', detail);

  const actor = (
    party: Awaited<ReturnType<typeof anOrganization>>,
    role: 'operator' | 'viewer',
  ) => ({
    name: `Test User ${party[role].user.email}`,
    organization: {
      id: party.organization.id,
      name: party.organization.name,
      countryCode: party.organization.countryCode,
    },
  });

  describe('giving the first instructions (PUT with If-None-Match: *)', () => {
    it("lets an operator of the contract's buyer give them, with server-derived author and time", async () => {
      const s = await scenario();
      const before = Date.now();

      const response = await give(s.trader.operator.cookie, s.voyage.id, s.c1).expect(201);

      const after = Date.now();
      expect(response.headers.etag).toBe('"1"');
      expect(response.headers.location).toBe(instructionPath(s.voyage.id, s.c1));
      const instruction = DocumentaryInstructionSchema.parse(response.body);
      expect(instruction).toEqual({
        id: expect.any(String) as string,
        voyageId: s.voyage.id,
        contract: {
          id: s.c1,
          position: 1,
          side: 'BUYER',
          seller: { id: s.exporter.organization.id, name: 'Exporter Co', countryCode: 'BR' },
          buyer: { id: s.trader.organization.id, name: 'Trader SA', countryCode: 'CH' },
        },
        version: 1,
        currentRevision: {
          number: 1,
          ...firstContent,
          createdAt: expect.any(String) as string,
          createdBy: actor(s.trader, 'operator'),
          acknowledgement: null,
        },
        previousRevisions: [],
      });
      const createdAt = Date.parse(instruction.currentRevision.createdAt);
      expect(createdAt).toBeGreaterThanOrEqual(before);
      expect(createdAt).toBeLessThanOrEqual(after);

      const events = await ctx.prisma.auditEvent.findMany();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        action: 'DOCUMENTARY_INSTRUCTION_REVISED',
        voyageId: s.voyage.id,
        actorUserId: s.trader.operator.user.id,
        actorOrganizationId: s.trader.organization.id,
        payload: {
          instructionId: instruction.id,
          contractId: s.c1,
          revisionNumber: 1,
          version: 1,
          ...firstContent,
          createdAt: instruction.currentRevision.createdAt,
        },
      });
    });

    it('stores an absent notify party as null, and accepts every document type', async () => {
      const s = await scenario();
      const requirements = REQUIRED_DOCUMENT_TYPES.map((document, index) => ({
        document,
        originals: index % 3,
        copies: 1,
      }));

      const response = await give(s.trader.operator.cookie, s.voyage.id, s.c1, {
        consignee: 'To order',
        requirements,
      }).expect(201);

      expect(DocumentaryInstructionSchema.parse(response.body).currentRevision).toMatchObject({
        consignee: 'To order',
        notifyParty: null,
        requirements,
      });
    });

    it('takes the author from the session, whatever the request claims', async () => {
      const s = await scenario();

      await http()
        .put(`${instructionPath(s.voyage.id, s.c1)}?userId=${s.exporter.operator.user.id}`)
        .set('Cookie', s.trader.operator.cookie)
        .set('If-None-Match', '*')
        .set('X-Organization-Id', s.exporter.organization.id)
        .set('X-User-Id', s.exporter.operator.user.id)
        .send(firstContent)
        .expect(201);

      expect(await ctx.prisma.documentaryInstructionRevision.findFirstOrThrow()).toMatchObject({
        createdByUserId: s.trader.operator.user.id,
        createdByOrganizationId: s.trader.organization.id,
      });
    });

    it.each<[string, Record<string, unknown>]>([
      ['a revision number', { revisionNumber: 5 }],
      ['a version', { version: 9 }],
      ['an author', { createdByUserId: '01990000-0000-7000-8002-000000000001' }],
      ['a time', { createdAt: '2020-01-01T00:00:00Z' }],
      ['an acknowledgement', { acknowledgement: null }],
    ])('rejects a body that sets %s', async (_case, extra) => {
      const s = await scenario();
      const response = await give(s.trader.operator.cookie, s.voyage.id, s.c1, {
        ...firstContent,
        ...extra,
      }).expect(400);
      expect(ProblemDetailsSchema.parse(response.body).type).toBe(ProblemTypes.ValidationFailed);
      expect(await writes()).toEqual({
        instructions: 0,
        revisions: 0,
        acknowledgements: 0,
        auditEvents: 0,
      });
    });

    it('reports invalid content field by field', async () => {
      const s = await scenario();
      const response = await give(s.trader.operator.cookie, s.voyage.id, s.c1, {
        consignee: '   ',
        requirements: [
          { document: 'BILL_OF_LADING', originals: 0, copies: 0 },
          { document: 'BILL_OF_LADING', originals: 11, copies: 1 },
        ],
      }).expect(400);

      expect(ProblemDetailsSchema.parse(response.body).errors).toEqual(
        expect.arrayContaining([
          { path: 'body.consignee', message: 'Enter the consignee' },
          {
            path: 'body.requirements.0.originals',
            message: 'Ask for at least one original or copy',
          },
          { path: 'body.requirements.1.originals', message: 'At most 10' },
        ]),
      );
    });

    it("refuses an operator of the contract's seller and a viewer of its buyer", async () => {
      const s = await scenario();

      const seller = await give(s.exporter.operator.cookie, s.voyage.id, s.c1).expect(403);
      expect(problemOf(seller.body).detail).toBe(
        'Only the buyer under a contract may give its documentary instructions.',
      );
      const viewer = await give(s.trader.viewer.cookie, s.voyage.id, s.c1).expect(403);
      expect(problemOf(viewer.body).detail).toBe(
        'Your role does not allow you to give documentary instructions.',
      );
      expect((await writes()).instructions).toBe(0);
    });

    it('answers everyone else like a request about a missing contract', async () => {
      const s = await scenario();

      for (const { cookie } of [
        s.exporter.operator, // A participant, but no party to contract 2.
        s.surveyor.operator,
        s.agent.operator,
        s.outsider.operator,
      ]) {
        const hidden = await give(cookie, s.voyage.id, s.c2).expect(404);
        const missing = await give(cookie, s.voyage.id, MISSING_ID).expect(404);
        expect(problemOf(hidden.body)).toEqual(problemOf(missing.body));
        expect(problemOf(hidden.body)).toEqual(notFound('Contract was not found.'));
      }
      // The buyer under TF-OTHER's contract cannot reach it through TF-D's path.
      await give(s.buyer.operator.cookie, s.voyage.id, s.d1).expect(404);
      expect((await writes()).instructions).toBe(0);
    });

    it('creates one instruction per contract: a second creation fails its precondition', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      const again = await give(s.trader.operator.cookie, s.voyage.id, s.c1, secondContent).expect(
        412,
      );

      expect(problemOf(again.body)).toEqual(
        problem(
          412,
          'Precondition Failed',
          'Documentary instructions already exist for this contract. Review them, then revise them with If-Match.',
        ),
      );
      expect(await writes()).toEqual({
        instructions: 1,
        revisions: 1,
        acknowledgements: 0,
        auditEvents: 1,
      });
    });
  });

  describe('preconditions on PUT', () => {
    it('requires one: 428 without If-Match or If-None-Match, and nothing is written', async () => {
      const s = await scenario();

      const response = await put(s.trader.operator.cookie, s.voyage.id, s.c1, firstContent).expect(
        428,
      );

      expect(problemOf(response.body)).toEqual(
        problem(
          428,
          'Precondition Required',
          'Send If-Match with the version your revision is based on, or If-None-Match: * to give the first instructions.',
        ),
      );
      expect((await writes()).instructions).toBe(0);
    });

    it('refuses If-Match: *, which would overwrite whatever is there', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, '*').expect(428);
      expect(await versionOf(s.c1)).toBe(1);
    });

    it.each<[string, Record<string, string>]>([
      ['both headers', { 'If-Match': '"1"', 'If-None-Match': '*' }],
      ['If-None-Match with a tag', { 'If-None-Match': '"1"' }],
      ['an If-Match that is not an entity tag', { 'If-Match': '1' }],
    ])('rejects %s as malformed', async (_case, headers) => {
      const s = await scenario();
      const response = await put(
        s.trader.operator.cookie,
        s.voyage.id,
        s.c1,
        firstContent,
        headers,
      ).expect(400);
      expect(ProblemDetailsSchema.parse(response.body).type).toBe(ProblemTypes.ValidationFailed);
    });

    it('fails If-Match when there are no instructions yet', async () => {
      const s = await scenario();

      const response = await revise(
        s.trader.operator.cookie,
        s.voyage.id,
        s.c1,
        1,
        firstContent,
      ).expect(412);

      expect(problemOf(response.body).detail).toBe(
        'There are no documentary instructions for this contract yet. Create them with If-None-Match: *.',
      );
      expect((await writes()).instructions).toBe(0);
    });

    it('checks the role and the contract before the precondition', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await revise(s.trader.viewer.cookie, s.voyage.id, s.c1, 99).expect(403);
      await revise(s.exporter.operator.cookie, s.voyage.id, s.c1, 99).expect(403);
      await revise(s.surveyor.operator.cookie, s.voyage.id, s.c1, 99).expect(404);
    });
  });

  describe('revising (PUT with If-Match)', () => {
    it('writes the next revision, keeps the previous one unchanged, and advances the version', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      const response = await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).expect(200);

      expect(response.headers.etag).toBe('"2"');
      expect(response.headers.location).toBeUndefined();
      const revised = DocumentaryInstructionSchema.parse(response.body);
      expect(revised).toMatchObject({
        id: first.id,
        version: 2,
        currentRevision: {
          number: 2,
          consignee: secondContent.consignee,
          notifyParty: null,
          requirements: secondContent.requirements,
          acknowledgement: null,
        },
        previousRevisions: [first.currentRevision],
      });
      const events = await ctx.prisma.auditEvent.findMany({ orderBy: { occurredAt: 'asc' } });
      expect(events.map((event) => event.payload)).toEqual([
        expect.objectContaining({ revisionNumber: 1, version: 1 }),
        expect.objectContaining({ revisionNumber: 2, version: 2, notifyParty: null }),
      ]);
    });

    it('fails a stale If-Match, writes nothing, and says what changed', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).expect(200);

      const stale = await revise(
        s.trader.operator.cookie,
        s.voyage.id,
        s.c1,
        1,
        firstContent,
      ).expect(412);

      expect(problemOf(stale.body)).toEqual(
        problem(
          412,
          'Precondition Failed',
          'The documentary instructions have changed since the version you sent; they are now at version 2. Review the latest revision before revising.',
        ),
      );
      expect(await writes()).toEqual({
        instructions: 1,
        revisions: 2,
        acknowledgements: 0,
        auditEvents: 2,
      });
    });

    it('treats weak and foreign entity tags as never matching, and accepts a list', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 'W/"1"').expect(412);
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, '"v1"').expect(412);
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, '"7", "1"').expect(200);
    });

    it('refuses a revision that changes nothing', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      const response = await revise(
        s.trader.operator.cookie,
        s.voyage.id,
        s.c1,
        1,
        firstContent,
      ).expect(400);

      expect(ProblemDetailsSchema.parse(response.body).errors).toEqual([
        { path: 'body', message: 'This revision changes nothing: it is the same as revision 1.' },
      ]);
      expect(await versionOf(s.c1)).toBe(1);
      expect((await writes()).revisions).toBe(1);
    });

    it('starts a new revision unacknowledged and keeps the earlier acknowledgement', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      const acknowledged = DocumentaryInstructionSchema.parse(
        (await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(200)).body,
      );

      const response = await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 2).expect(200);

      const revised = DocumentaryInstructionSchema.parse(response.body);
      expect(revised.version).toBe(3);
      expect(revised.currentRevision).toMatchObject({ number: 2, acknowledgement: null });
      expect(revised.previousRevisions).toEqual([acknowledged.currentRevision]);
      expect(revised.previousRevisions[0]?.acknowledgement).toEqual({
        acknowledgedAt: expect.any(String) as string,
        acknowledgedBy: actor(s.exporter, 'operator'),
      });
    });
  });

  describe('acknowledging a revision (POST .../revisions/:n/acknowledgement)', () => {
    it("lets an operator of the contract's seller acknowledge the current revision, once", async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      const before = Date.now();

      const response = await acknowledge(
        s.exporter.operator.cookie,
        s.voyage.id,
        s.c1,
        1,
        1,
      ).expect(200);

      const after = Date.now();
      expect(response.headers.etag).toBe('"2"');
      const acknowledged = DocumentaryInstructionSchema.parse(response.body);
      expect(acknowledged).toEqual({
        ...first,
        contract: { ...first.contract, side: 'SELLER' },
        version: 2,
        currentRevision: {
          ...first.currentRevision,
          acknowledgement: {
            acknowledgedAt: expect.any(String) as string,
            acknowledgedBy: actor(s.exporter, 'operator'),
          },
        },
      });
      const at = Date.parse(acknowledged.currentRevision.acknowledgement?.acknowledgedAt ?? '');
      expect(at).toBeGreaterThanOrEqual(before);
      expect(at).toBeLessThanOrEqual(after);

      const event = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' },
      });
      expect(event).toMatchObject({
        voyageId: s.voyage.id,
        actorUserId: s.exporter.operator.user.id,
        actorOrganizationId: s.exporter.organization.id,
        payload: {
          instructionId: first.id,
          contractId: s.c1,
          revisionNumber: 1,
          version: 2,
          acknowledgedAt: acknowledged.currentRevision.acknowledgement?.acknowledgedAt,
        },
      });

      const again = await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 2).expect(
        409,
      );
      expect(problemOf(again.body)).toEqual(
        problem(409, 'Conflict', 'Revision 1 has already been acknowledged.'),
      );
      expect(await writes()).toEqual({
        instructions: 1,
        revisions: 1,
        acknowledgements: 1,
        auditEvents: 2,
      });
    });

    it('requires If-Match, and fails a stale one without recording anything', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).expect(200);

      const missing = await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 2).expect(
        428,
      );
      expect(problemOf(missing.body).detail).toBe(
        'Send If-Match with the version you read before acknowledging.',
      );
      await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 2, '*').expect(428);
      // Read at version 1 (revision 1), so revision 2 was never seen.
      const stale = await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 2, 1).expect(
        412,
      );
      expect(problemOf(stale.body).detail).toBe(
        'The documentary instructions have changed since the version you sent; they are now at version 2. Review the current revision before acknowledging it.',
      );
      expect((await writes()).acknowledgements).toBe(0);
      expect(await versionOf(s.c1)).toBe(2);
    });

    it('acknowledges only the current revision, and only revisions that exist', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).expect(200);

      const superseded = await acknowledge(
        s.exporter.operator.cookie,
        s.voyage.id,
        s.c1,
        1,
        2,
      ).expect(409);
      expect(problemOf(superseded.body).detail).toBe(
        'Revision 1 has been superseded by revision 2; only the current revision can be acknowledged.',
      );
      const future = await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 3, 2).expect(
        404,
      );
      expect(problemOf(future.body)).toEqual(notFound('Revision was not found.'));
      expect((await writes()).acknowledgements).toBe(0);

      await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 2, 2).expect(200);
    });

    it('rejects a body that tries to set who acknowledged or when, and a malformed revision', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1)
        .send({ acknowledgedByUserId: s.trader.operator.user.id, acknowledgedAt: '2020-01-01' })
        .expect(400);
      for (const revision of ['0', 'one', '01', '1.5']) {
        await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, revision, 1).expect(400);
      }
      expect((await writes()).acknowledgements).toBe(0);
      // An empty object is accepted, like no body at all.
      await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).send({}).expect(200);
    });

    it('refuses a viewer of the seller and an operator of the buyer', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      const viewer = await acknowledge(s.exporter.viewer.cookie, s.voyage.id, s.c1, 1, 1).expect(
        403,
      );
      expect(problemOf(viewer.body).detail).toBe(
        'Your role does not allow you to acknowledge documentary instructions.',
      );
      const buyer = await acknowledge(s.trader.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(
        403,
      );
      expect(problemOf(buyer.body).detail).toBe(
        'Only the seller under a contract may acknowledge its documentary instructions.',
      );
      expect((await writes()).acknowledgements).toBe(0);
    });

    it('answers everyone else, and a contract without instructions, with the same 404', async () => {
      const s = await scenario();
      await given(s.buyer.operator.cookie, s.voyage.id, s.c2);

      for (const { cookie } of [
        s.exporter.operator,
        s.surveyor.operator,
        s.agent.operator,
        s.outsider.operator,
      ]) {
        const hidden = await acknowledge(cookie, s.voyage.id, s.c2, 1, 1).expect(404);
        const missing = await acknowledge(cookie, s.voyage.id, MISSING_ID, 1, 1).expect(404);
        expect(problemOf(hidden.body)).toEqual(problemOf(missing.body));
        expect(problemOf(hidden.body)).toEqual(
          notFound('Documentary instructions were not found.'),
        );
      }
      // The exporter sells under contract 1, which has no instructions yet.
      const none = await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(
        404,
      );
      expect(problemOf(none.body)).toEqual(notFound('Documentary instructions were not found.'));
      expect((await writes()).acknowledgements).toBe(0);
    });
  });

  describe('reading', () => {
    it('lets both counterparties read, viewers included, each from its own side', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      for (const [reader, side] of [
        [s.trader.viewer, 'BUYER'],
        [s.exporter.viewer, 'SELLER'],
        [s.exporter.operator, 'SELLER'],
      ] as const) {
        const response = await read(reader.cookie, s.voyage.id, s.c1).expect(200);
        expect(response.headers.etag).toBe('"1"');
        expect(DocumentaryInstructionSchema.parse(response.body)).toEqual({
          ...first,
          contract: { ...first.contract, side },
        });
      }
    });

    it('lists the instructions under the reader’s contracts, in contract order', async () => {
      const s = await scenario();
      const underC2 = await given(s.buyer.operator.cookie, s.voyage.id, s.c2);
      const underC1 = await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      const list = async (cookie: string) =>
        DocumentaryInstructionListResponseSchema.parse(
          (await http().get(listPath(s.voyage.id)).set('Cookie', cookie).expect(200)).body,
        ).items.map((instruction) => [instruction.id, instruction.contract.side]);

      // The trader buys under contract 1 and sells under contract 2.
      expect(await list(s.trader.viewer.cookie)).toEqual([
        [underC1.id, 'BUYER'],
        [underC2.id, 'SELLER'],
      ]);
      expect(await list(s.exporter.viewer.cookie)).toEqual([[underC1.id, 'SELLER']]);
      expect(await list(s.buyer.viewer.cookie)).toEqual([[underC2.id, 'BUYER']]);
      expect(await list(s.surveyor.operator.cookie)).toEqual([]);
      expect(await list(s.agent.viewer.cookie)).toEqual([]);
    });

    it('answers everyone else like a request for missing instructions', async () => {
      const s = await scenario();
      await given(s.buyer.operator.cookie, s.voyage.id, s.c2);

      for (const { cookie } of [
        s.exporter.viewer,
        s.surveyor.viewer,
        s.agent.operator,
        s.outsider.viewer,
      ]) {
        const hidden = await read(cookie, s.voyage.id, s.c2).expect(404);
        const missing = await read(cookie, s.voyage.id, MISSING_ID).expect(404);
        expect(problemOf(hidden.body)).toEqual(problemOf(missing.body));
        expect(problemOf(hidden.body)).toEqual(
          notFound('Documentary instructions were not found.'),
        );
        expect(hidden.headers.etag).toBeUndefined();
      }
      // A party to the contract that has no instructions yet gets the same answer.
      await read(s.exporter.viewer.cookie, s.voyage.id, s.c1).expect(404);
      // Through another voyage's path, even for a party to the contract.
      await read(s.buyer.viewer.cookie, s.other.id, s.c2).expect(404);

      const list = await http()
        .get(listPath(s.voyage.id))
        .set('Cookie', s.outsider.viewer.cookie)
        .expect(404);
      expect(problemOf(list.body)).toEqual(notFound('Voyage was not found.'));
    });
  });

  describe('when the identity behind a session changes between reading and writing', () => {
    it('applies a role taken away, at the very next write', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      await ctx.prisma.user.update({
        where: { id: s.trader.operator.user.id },
        data: { role: 'VIEWER' },
      });

      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, first.version).expect(403);
      expect(await versionOf(s.c1)).toBe(1);
    });

    it('applies a move to another organization: the contract is no longer theirs', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      await ctx.prisma.user.update({
        where: { id: s.exporter.operator.user.id },
        data: { organizationId: s.outsider.organization.id },
      });

      const response = await acknowledge(
        s.exporter.operator.cookie,
        s.voyage.id,
        s.c1,
        1,
        1,
      ).expect(404);

      expect(problemOf(response.body)).toEqual(
        notFound('Documentary instructions were not found.'),
      );
      await read(s.exporter.operator.cookie, s.voyage.id, s.c1).expect(404);
      expect((await writes()).acknowledgements).toBe(0);
    });
  });

  describe('races against PostgreSQL', () => {
    /** A second operator of `party`, signed in. */
    async function colleagueOf(party: Awaited<ReturnType<typeof anOrganization>>) {
      const user = await createUser(ctx.prisma, party.organization.id, { role: 'OPERATOR' });
      return { user, cookie: await signIn(ctx.server, user.email) };
    }

    /** Holds the instruction row's lock until both requests are blocked on it, then releases. */
    async function race<T extends { status: number }>(
      lockRow: string,
      contenders: [() => PromiseLike<T>, () => PromiseLike<T>],
      table = 'documentary_instructions',
    ): Promise<[T, T]> {
      const lock = await holdLock(ctx.prisma, (tx) =>
        tx.$queryRawUnsafe(`SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE`, lockRow),
      );
      const responses = Promise.all(contenders.map((send) => Promise.resolve(send())));
      await waitForLockWaiters(ctx.prisma, 2);
      await lock.release();
      const [first, second] = await responses;
      if (!first || !second) throw new Error('Both contenders must answer');
      return [first, second];
    }

    it('creates exactly one instruction when two first instructions race', async () => {
      const s = await scenario();
      const colleague = await colleagueOf(s.trader);

      // Locking the contract row blocks each insert's foreign-key check, after its index entry:
      // the first insert waits there, the second waits on the first's index entry.
      const responses = await race(
        s.c1,
        [
          () => give(s.trader.operator.cookie, s.voyage.id, s.c1, firstContent),
          () => give(colleague.cookie, s.voyage.id, s.c1, secondContent),
        ],
        'trade_contracts',
      );

      expect(responses.map((response) => response.status).sort()).toEqual([201, 412]);
      expect(await writes()).toEqual({
        instructions: 1,
        revisions: 1,
        acknowledgements: 0,
        auditEvents: 1,
      });
      const winner = responses.find((response) => response.status === 201);
      const revision = await ctx.prisma.documentaryInstructionRevision.findFirstOrThrow();
      expect(revision.consignee).toBe(
        DocumentaryInstructionSchema.parse(winner?.body).currentRevision.consignee,
      );
    });

    it('writes one revision when two revisions of the same version race', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      const colleague = await colleagueOf(s.trader);
      const theirs = { ...secondContent, consignee: 'To order of Another Bank' };

      const responses = await race(first.id, [
        () => revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1, secondContent),
        () => revise(colleague.cookie, s.voyage.id, s.c1, 1, theirs),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
      const winner = DocumentaryInstructionSchema.parse(
        responses.find((response) => response.status === 200)?.body,
      );
      expect(winner).toMatchObject({ version: 2, currentRevision: { number: 2 } });
      expect(await writes()).toEqual({
        instructions: 1,
        revisions: 2,
        acknowledgements: 0,
        auditEvents: 2,
      });
      const stored = await read(s.trader.viewer.cookie, s.voyage.id, s.c1).expect(200);
      expect(DocumentaryInstructionSchema.parse(stored.body).currentRevision).toEqual(
        winner.currentRevision,
      );
    });

    it('records one acknowledgement when two acknowledgements race', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      const colleague = await colleagueOf(s.exporter);
      const contenders = [s.exporter.operator, colleague];

      const responses = await race(first.id, [
        () => acknowledge(contenders[0]?.cookie ?? '', s.voyage.id, s.c1, 1, 1),
        () => acknowledge(contenders[1]?.cookie ?? '', s.voyage.id, s.c1, 1, 1),
      ]);

      expect(responses.map((response) => response.status).sort()).toEqual([200, 412]);
      const winner = contenders[responses.findIndex((response) => response.status === 200)];
      const acknowledgements = await ctx.prisma.documentaryInstructionAcknowledgement.findMany();
      expect(acknowledgements).toHaveLength(1);
      expect(acknowledgements[0]).toMatchObject({
        revisionNumber: 1,
        acknowledgedByUserId: winner?.user.id,
      });
      const events = await ctx.prisma.auditEvent.findMany({
        where: { action: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' },
      });
      expect(events.map((event) => event.actorUserId)).toEqual([winner?.user.id]);
      expect(await versionOf(s.c1)).toBe(2);
    });

    it('lets exactly one of a revision and an acknowledgement of the same version win', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      const [revision, acknowledgement] = await race(first.id, [
        () => revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1),
        () => acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1),
      ]);

      expect([revision.status, acknowledgement.status].sort()).toEqual([200, 412]);
      expect(await versionOf(s.c1)).toBe(2);
      const stored = DocumentaryInstructionSchema.parse(
        (await read(s.trader.viewer.cookie, s.voyage.id, s.c1).expect(200)).body,
      );
      const events = await ctx.prisma.auditEvent.findMany({ orderBy: { occurredAt: 'asc' } });
      if (revision.status === 200) {
        // The seller acknowledged nothing: it had not seen revision 2.
        expect(stored.currentRevision).toMatchObject({ number: 2, acknowledgement: null });
        expect(stored.previousRevisions[0]?.acknowledgement).toBeNull();
        expect(await writes()).toMatchObject({ revisions: 2, acknowledgements: 0 });
        expect(events.map((event) => event.action)).toEqual([
          'DOCUMENTARY_INSTRUCTION_REVISED',
          'DOCUMENTARY_INSTRUCTION_REVISED',
        ]);
      } else {
        // The buyer's revision was not written: it had not seen the acknowledgement.
        expect(stored.currentRevision.number).toBe(1);
        expect(stored.currentRevision.acknowledgement).not.toBeNull();
        expect(await writes()).toMatchObject({ revisions: 1, acknowledgements: 1 });
        expect(events.map((event) => event.action)).toEqual([
          'DOCUMENTARY_INSTRUCTION_REVISED',
          'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
        ]);
      }
    });
  });

  describe('when the audit event cannot be written', () => {
    const expectGeneric500 = (body: unknown) => {
      const problemDetails = ProblemDetailsSchema.parse(body);
      expect(problemDetails.detail).toBe('An unexpected error occurred.');
      expect(JSON.stringify(problemDetails)).not.toContain('audit store');
    };

    it('gives no instructions', async () => {
      const s = await scenario();

      await failAuditWrites(ctx.prisma, async () => {
        expectGeneric500(
          (await give(s.trader.operator.cookie, s.voyage.id, s.c1).expect(500)).body,
        );
      });

      expect(await writes()).toEqual({
        instructions: 0,
        revisions: 0,
        acknowledgements: 0,
        auditEvents: 0,
      });
      // Nothing was half-done: the instructions can still be given.
      await give(s.trader.operator.cookie, s.voyage.id, s.c1).expect(201);
    });

    it('writes no revision and leaves the version alone', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await failAuditWrites(ctx.prisma, async () => {
        expectGeneric500(
          (await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).expect(500)).body,
        );
      });

      expect(await versionOf(s.c1)).toBe(1);
      expect(await writes()).toMatchObject({ revisions: 1, auditEvents: 1 });
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).expect(200);
    });

    it('records no acknowledgement and leaves the version alone', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await failAuditWrites(ctx.prisma, async () => {
        expectGeneric500(
          (await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(500)).body,
        );
      });

      expect(await versionOf(s.c1)).toBe(1);
      expect(await writes()).toMatchObject({ acknowledgements: 0, auditEvents: 1 });
      await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(200);
    });
  });

  describe('immutability, for every writer', () => {
    it('offers no way to delete instructions or patch a revision', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      for (const method of ['patch', 'delete'] as const) {
        await http()
          [method](instructionPath(s.voyage.id, s.c1))
          .set('Cookie', s.trader.operator.cookie)
          .set('If-Match', '"1"')
          .send({ consignee: 'edited' })
          .expect(404);
      }
      await http()
        .put(`${instructionPath(s.voyage.id, s.c1)}/revisions/1`)
        .set('Cookie', s.trader.operator.cookie)
        .set('If-Match', '"1"')
        .send(secondContent)
        .expect(404);
      const stored = await read(s.trader.viewer.cookie, s.voyage.id, s.c1).expect(200);
      expect(DocumentaryInstructionSchema.parse(stored.body)).toEqual(first);
    });

    /** Statements as any writer with table access could send them; the database must refuse. */
    const sql = (statement: string, ...values: unknown[]) =>
      ctx.prisma.$executeRawUnsafe(statement, ...values);

    it.each([
      ['the consignee', `consignee = 'edited'`],
      ['the notify party', `notify_party = NULL`],
      [
        'the requirements',
        `requirements = '[{"document":"BILL_OF_LADING","originals":1,"copies":0}]'`,
      ],
      ['the author', `created_at = now()`],
      ['the number', `revision_number = 7`],
    ])('refuses changing %s of a revision', async (_field, assignment) => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await expect(
        sql(`UPDATE documentary_instruction_revisions SET ${assignment}`),
      ).rejects.toThrow(/documentary_instruction_revisions: rows are immutable/);
    });

    it('refuses changing an acknowledgement', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(200);

      await expect(
        sql(
          'UPDATE documentary_instruction_acknowledgements SET acknowledged_by_user_id = $1::uuid',
          s.exporter.viewer.user.id,
        ),
      ).rejects.toThrow(/documentary_instruction_acknowledgements: rows are immutable/);
    });

    it.each([
      [
        'moves it to another contract',
        (s: Scenario) => `trade_contract_id = '${s.c2}', version = version + 1`,
        /cannot change/,
      ],
      [
        'leaves the version alone',
        () => `updated_at = now()`,
        /advances the version by exactly one/,
      ],
      ['skips a version', () => `version = version + 2`, /advances the version by exactly one/],
      ['goes back a version', () => `version = version - 1`, /advances the version by exactly one/],
      [
        'skips a revision number',
        () => `version = version + 1, current_revision_number = current_revision_number + 2`,
        /numbered one after another/,
      ],
    ])('refuses a change to the instruction that %s', async (_case, assignment, error) => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await expect(sql(`UPDATE documentary_instructions SET ${assignment(s)}`)).rejects.toThrow(
        error,
      );
    });

    it('refuses advancing to a revision that is never written, at commit', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      await expect(
        sql(
          `UPDATE documentary_instructions
           SET version = version + 1, current_revision_number = current_revision_number + 1`,
        ),
      ).rejects.toThrow(/the current revision 2 does not exist/);
      await expect(
        ctx.prisma.$executeRaw`
          INSERT INTO documentary_instructions (voyage_id, trade_contract_id)
          VALUES (${s.voyage.id}::uuid, ${s.c2}::uuid)`,
      ).rejects.toThrow(/the current revision 1 does not exist/);
      expect(await versionOf(s.c1)).toBe(1);
    });

    it('refuses writing a revision or an acknowledgement other than the current one', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      await revise(s.trader.operator.cookie, s.voyage.id, s.c1, 1).expect(200);

      await expect(
        ctx.prisma.$executeRaw`
          INSERT INTO documentary_instruction_revisions (instruction_id, revision_number, consignee,
            requirements, created_by_user_id, created_by_organization_id, created_at)
          VALUES (${first.id}::uuid, 3, 'To order',
            '[{"document":"BILL_OF_LADING","originals":1,"copies":0}]'::jsonb,
            ${s.trader.operator.user.id}::uuid, ${s.trader.organization.id}::uuid, now())`,
      ).rejects.toThrow(/only the current revision of an instruction can be written/);
      await expect(
        ctx.prisma.$executeRaw`
          INSERT INTO documentary_instruction_acknowledgements (instruction_id, revision_number,
            acknowledged_by_user_id, acknowledged_by_organization_id, acknowledged_at)
          VALUES (${first.id}::uuid, 1, ${s.exporter.operator.user.id}::uuid,
            ${s.exporter.organization.id}::uuid, now())`,
      ).rejects.toThrow(/only the current revision of an instruction can be written/);
    });

    it('keeps a contract with instructions from being deleted', async () => {
      const s = await scenario();
      await given(s.trader.operator.cookie, s.voyage.id, s.c1);
      await expect(ctx.prisma.tradeContract.delete({ where: { id: s.c1 } })).rejects.toThrow();
    });
  });

  describe('revision content constraints', () => {
    /** Inserts instruction 1 of contract 1 with the given revision content, with plain SQL. */
    async function insertWith(
      s: Scenario,
      consignee: string,
      notifyParty: string | null,
      requirements: unknown,
    ) {
      await ctx.prisma.$transaction(async (tx) => {
        const [instruction] = await tx.$queryRaw<{ id: string }[]>`
          INSERT INTO documentary_instructions (voyage_id, trade_contract_id)
          VALUES (${s.voyage.id}::uuid, ${s.c1}::uuid) RETURNING id`;
        await tx.$executeRaw`
          INSERT INTO documentary_instruction_revisions (instruction_id, revision_number, consignee,
            notify_party, requirements, created_by_user_id, created_by_organization_id, created_at)
          VALUES (${instruction?.id}::uuid, 1, ${consignee}, ${notifyParty},
            ${JSON.stringify(requirements)}::jsonb, ${s.trader.operator.user.id}::uuid,
            ${s.trader.organization.id}::uuid, now())`;
      });
    }

    const bill = { document: 'BILL_OF_LADING', originals: 3, copies: 0 };

    it('accepts well-formed content', async () => {
      const s = await scenario();
      await expect(insertWith(s, 'To order', null, [bill])).resolves.toBeUndefined();
    });

    it.each<[string, string, string | null, unknown, RegExp]>([
      ['a blank consignee', ' \n ', null, [bill], /consignee_length/],
      ['a consignee that is too long', 'x'.repeat(501), null, [bill], /consignee_length/],
      ['a blank notify party', 'To order', '  ', [bill], /notify_party_length/],
      ['no requirements', 'To order', null, [], /requirements_valid/],
      ['requirements that are not a list', 'To order', null, bill, /requirements_valid/],
      ['a document twice', 'To order', null, [bill, bill], /requirements_valid/],
      [
        'an unknown document',
        'To order',
        null,
        [{ ...bill, document: 'PRICE' }],
        /requirements_valid/,
      ],
      [
        'no originals and no copies',
        'To order',
        null,
        [{ ...bill, originals: 0 }],
        /requirements_valid/,
      ],
      ['too many copies', 'To order', null, [{ ...bill, copies: 11 }], /requirements_valid/],
      ['a fractional count', 'To order', null, [{ ...bill, copies: 1.5 }], /requirements_valid/],
      ['a count as text', 'To order', null, [{ ...bill, copies: '1' }], /requirements_valid/],
      ['another field', 'To order', null, [{ ...bill, price: 1 }], /requirements_valid/],
      [
        'a missing field',
        'To order',
        null,
        [{ document: 'BILL_OF_LADING', originals: 1 }],
        /requirements_valid/,
      ],
    ])('rejects %s', async (_case, consignee, notifyParty, requirements, constraint) => {
      const s = await scenario();
      await expect(insertWith(s, consignee, notifyParty, requirements)).rejects.toThrow(constraint);
    });
  });

  describe('audit constraints', () => {
    it('allows one event per version of an instruction', async () => {
      const s = await scenario();
      const first = await given(s.trader.operator.cookie, s.voyage.id, s.c1);

      const event = (
        action: 'DOCUMENTARY_INSTRUCTION_REVISED' | 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
        payload: object,
      ) =>
        ctx.prisma.auditEvent.create({
          data: {
            action,
            actorUserId: s.exporter.operator.user.id,
            actorOrganizationId: s.exporter.organization.id,
            voyageId: s.voyage.id,
            payload,
          },
        });

      await expect(
        event('DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED', {
          instructionId: first.id,
          revisionNumber: 1,
          version: 1,
        }),
      ).rejects.toThrow();
      await expect(
        event('DOCUMENTARY_INSTRUCTION_REVISED', {
          instructionId: first.id,
          revisionNumber: 1,
          version: 7,
        }),
      ).rejects.toThrow();
      await expect(
        event('DOCUMENTARY_INSTRUCTION_REVISED', { instructionId: first.id, version: 2 }),
      ).rejects.toThrow(/audit_events_documentary_instruction_payload/);
    });
  });

  describe('the shared trade string and notices', () => {
    it('are unchanged by instructions', async () => {
      const s = await scenario();
      const tradeString = (cookie: string) =>
        http().get(`/api/voyages/${s.voyage.id}/trade-string`).set('Cookie', cookie).expect(200);
      const before = (await tradeString(s.surveyor.viewer.cookie)).body as unknown;

      const instruction: DocumentaryInstruction = await given(
        s.trader.operator.cookie,
        s.voyage.id,
        s.c1,
      );
      await acknowledge(s.exporter.operator.cookie, s.voyage.id, s.c1, 1, 1).expect(200);

      for (const reader of [s.exporter, s.trader, s.buyer, s.surveyor, s.agent]) {
        const body = (await tradeString(reader.viewer.cookie)).body as unknown;
        expect(body).toEqual(before);
        expect(JSON.stringify(body)).not.toContain(instruction.id);
        expect(JSON.stringify(body)).not.toMatch(/consignee|instruction/i);
      }
      const notices = await http()
        .get(`/api/voyages/${s.voyage.id}/notices`)
        .set('Cookie', s.exporter.viewer.cookie)
        .expect(200);
      expect(notices.body).toEqual({ items: [] });
    });
  });
});
