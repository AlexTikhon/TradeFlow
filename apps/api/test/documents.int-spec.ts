import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  ContractDocumentSchema,
  type DocumentaryInstructionContent,
  DocumentaryInstructionSchema,
  DocumentListResponseSchema,
  MAX_DOCUMENT_BYTES,
  ProblemDetailsSchema,
  ProblemTypes,
} from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { UserRole } from '../src/generated/prisma/client.js';
import {
  advanceToNextRevision,
  createInstruction,
} from '../src/modules/documentary-instructions/instruction.writes.js';
import { MAX_UPLOAD_REQUEST_BYTES } from '../src/modules/documents/document-rules.js';
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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

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

/** Bytes that start like a PDF, then `size` bytes in all. */
const pdf = (size = 48 * 1024) =>
  Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(Math.max(0, size - 9))]).subarray(0, size);

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest();

/** Collects a response body as bytes, whatever its type. */
const binary = (response: IncomingMessage, done: (error: Error | null, body: Buffer) => void) => {
  const chunks: Buffer[] = [];
  response.on('data', (chunk: Buffer) => chunks.push(chunk));
  response.on('end', () => {
    done(null, Buffer.concat(chunks));
  });
};

/** The same, as a supertest body parser (superagent hands it the Node response). */
const asBytes = binary as unknown as Parameters<request.Test['parse']>[0];

const until = async (condition: () => Promise<boolean>, what: string) => {
  const deadline = Date.now() + 5_000;
  while (!(await condition())) {
    if (Date.now() > deadline) throw new Error(`Timed out waiting until ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
};

describe('Documents', () => {
  let ctx: TestApp;
  let storage: TestStorage;
  /**
   * The same application on a port of its own, for the requests some tests send by hand, byte by
   * byte. Supertest keeps using the app's own server, which it listens on per request, as in every
   * other file (a server left listening would let pooled keep-alive sockets race its idle timeout).
   */
  let byHand: http.Server;
  const api = () => request(ctx.server);

  beforeAll(async () => {
    storage = await TestStorage.create();
    ctx = await createTestApp({ storage });
    byHand = http.createServer(ctx.app.getHttpAdapter().getInstance() as http.RequestListener);
    await new Promise<void>((resolve) => byHand.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    byHand.closeAllConnections();
    await new Promise<void>((resolve) => {
      byHand.close(() => {
        resolve();
      });
    });
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
   * TF-D: Exporter → Trader → Buyer, with a surveyor and a shipping agent. Under contract 1 the
   * exporter sells to the trader: the trader gives the instructions and the exporter presents
   * the documents. TF-OTHER: the exporter sells straight to the buyer. Outsider participates in
   * nothing. The trader has given revision 1 of the instructions under contract 1.
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
    return {
      voyage,
      other,
      exporter,
      trader,
      buyer,
      surveyor,
      agent,
      outsider,
      instruction,
      /** Exporter → Trader on TF-D, with instructions at revision 1. */
      c1,
      /** Trader → Buyer on TF-D, without instructions. */
      c2: await contractAt(voyage.id, 2),
      /** Exporter → Buyer on TF-OTHER. */
      d1: await contractAt(other.id, 1),
    };
  }
  type Scenario = Awaited<ReturnType<typeof scenario>>;

  interface Target {
    voyageId?: string;
    contractId?: string;
    revision?: number | string;
    type?: string;
  }

  const documentPath = (s: Scenario, target: Target = {}) =>
    `/api/voyages/${target.voyageId ?? s.voyage.id}/contracts/${target.contractId ?? s.c1}` +
    `/documentary-instructions/revisions/${target.revision ?? 1}/documents/${target.type ?? 'BILL_OF_LADING'}`;
  const versionsPath = (s: Scenario, target?: Target) => `${documentPath(s, target)}/versions`;
  const contentPath = (s: Scenario, version: number | string, target?: Target) =>
    `${versionsPath(s, target)}/${version}/content`;
  const listPath = (voyageId: string) => `/api/voyages/${voyageId}/documents`;

  interface Upload extends Target {
    bytes?: Buffer;
    fileName?: string;
    contentType?: string;
    headers?: Record<string, string>;
  }

  /** A real multipart upload, as a browser's FormData would send it. */
  const upload = (cookie: string, s: Scenario, upload: Upload = {}) =>
    api()
      .post(versionsPath(s, upload))
      .set('Cookie', cookie)
      .set(upload.headers ?? { 'If-None-Match': '*' })
      .attach('file', upload.bytes ?? pdf(), {
        filename: upload.fileName ?? 'bill-of-lading.pdf',
        contentType: upload.contentType ?? 'application/pdf',
      });

  /** Uploads `bytes` as the first version, as the exporter's operator, and returns the document. */
  async function uploaded(s: Scenario, bytes = pdf(), target: Target = {}) {
    const response = await upload(s.exporter.operator.cookie, s, { ...target, bytes }).expect(201);
    return ContractDocumentSchema.parse(response.body);
  }

  const replace = (cookie: string, s: Scenario, version: number, upload: Upload = {}) =>
    api()
      .post(versionsPath(s, upload))
      .set('Cookie', cookie)
      .set('If-Match', `"${version}"`)
      .attach('file', upload.bytes ?? pdf(), {
        filename: upload.fileName ?? 'bill-of-lading-v2.pdf',
        contentType: 'application/pdf',
      });

  const download = (cookie: string, s: Scenario, version: number | string, target?: Target) =>
    api()
      .get(contentPath(s, version, target))
      .set('Cookie', cookie)
      .buffer(true)
      .parse(asBytes);

  /** Every row an upload could write. */
  const writes = async () => ({
    documents: await ctx.prisma.document.count(),
    versions: await ctx.prisma.documentVersion.count(),
    uploadEvents: await ctx.prisma.auditEvent.count({
      where: { action: 'DOCUMENT_VERSION_UPLOADED' },
    }),
  });
  const NOTHING_WRITTEN = { documents: 0, versions: 0, uploadEvents: 0 };

  /** What storage holds: staged bytes, and kept objects. */
  const stored = async () => ({
    staging: await storage.files('staging'),
    objects: await storage.files('objects'),
  });
  const NOTHING_STORED = { staging: [], objects: [] };

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
  const validation = (path: string, message: string) => ({
    type: ProblemTypes.ValidationFailed,
    title: 'Request validation failed',
    status: 400,
    detail: 'The request is invalid.',
    errors: [{ path, message }],
  });
  const expectGeneric500 = (body: unknown) => {
    expect(problemOf(body)).toEqual(
      problem(500, 'Internal Server Error', 'An unexpected error occurred.'),
    );
    expect(JSON.stringify(body)).not.toMatch(/storage|audit|checksum|objects|staging/i);
  };

  const actor = (party: Party, role: 'operator' | 'viewer' = 'operator') => ({
    name: `Test User ${party[role].user.email}`,
    organization: {
      id: party.organization.id,
      name: party.organization.name,
      countryCode: party.organization.countryCode,
    },
  });

  /** Gives revision 2 of the instructions under contract 1, as the trader. */
  const revise = (s: Scenario) =>
    api()
      .put(`/api/voyages/${s.voyage.id}/contracts/${s.c1}/documentary-instructions`)
      .set('Cookie', s.trader.operator.cookie)
      .set('If-Match', '"1"')
      .send(secondContent);

  /** A second operator of `party`, signed in. */
  async function colleagueOf(party: Party) {
    const user = await createUser(ctx.prisma, party.organization.id, { role: 'OPERATOR' });
    return { user, cookie: await signIn(ctx.server, user.email) };
  }

  /**
   * An upload sent by hand: the head of the body at once, the rest only when the test says.
   * Lets a test act while the server is part-way through receiving the file.
   */
  function uploadByHand(cookie: string, path: string, bytes: Buffer, fileName = 'bl.pdf') {
    const boundary = '----tradeflow-test-boundary';
    const head = Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${fileName}"\r\n` +
        'Content-Type: application/pdf\r\n\r\n',
    );
    const tail = Buffer.from(`\r\n--${boundary}--\r\n`);
    const { port } = byHand.address() as AddressInfo;
    const sent = http.request({
      host: '127.0.0.1',
      port,
      method: 'POST',
      path,
      headers: {
        Cookie: cookie,
        'If-None-Match': '*',
        'Content-Type': `multipart/form-data; boundary=${boundary}`,
        'Content-Length': head.length + bytes.length + tail.length,
      },
    });
    const answer = new Promise<{ status: number; body: unknown }>((resolve, reject) => {
      sent.on('response', (response) => {
        binary(response, (_error, body) => {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(body.toString()) });
        });
      });
      sent.on('error', reject);
    });
    // Reported by whoever awaits it; an aborted upload has no answer.
    answer.catch(() => undefined);
    const half = Math.floor(bytes.length / 2);
    sent.write(Buffer.concat([head, bytes.subarray(0, half)]));
    return {
      answer,
      /** Sends the rest of the body. */
      finish: () => {
        sent.end(Buffer.concat([bytes.subarray(half), tail]));
        return answer;
      },
      /** Drops the connection, like a closed tab or a lost network. */
      abort: () => {
        sent.destroy();
      },
    };
  }

  /** Resolves once the server is receiving an upload into staging. */
  const receiving = () =>
    until(async () => (await storage.files('staging')).length > 0, 'an upload is being received');

  describe('uploading the first version (POST .../versions with If-None-Match: *)', () => {
    it("lets an operator of the contract's seller upload a PDF, recorded with server-side facts", async () => {
      const s = await scenario();
      const bytes = pdf(200 * 1024);
      const before = Date.now();

      const response = await upload(s.exporter.operator.cookie, s, { bytes }).expect(201);

      const after = Date.now();
      expect(response.headers.etag).toBe('"1"');
      expect(response.headers.location).toBe(contentPath(s, 1));
      const document = ContractDocumentSchema.parse(response.body);
      expect(document).toEqual({
        id: expect.any(String) as string,
        voyageId: s.voyage.id,
        contract: {
          id: s.c1,
          position: 1,
          side: 'SELLER',
          seller: actor(s.exporter).organization,
          buyer: actor(s.trader).organization,
        },
        revisionNumber: 1,
        documentType: 'BILL_OF_LADING',
        version: 1,
        currentVersion: {
          number: 1,
          fileName: 'bill-of-lading.pdf',
          mediaType: 'application/pdf',
          sizeBytes: bytes.length,
          sha256: sha256(bytes).toString('hex'),
          uploadedAt: expect.any(String) as string,
          uploadedBy: actor(s.exporter),
          review: null,
        },
        previousVersions: [],
      });
      const uploadedAt = Date.parse(document.currentVersion.uploadedAt);
      expect(uploadedAt).toBeGreaterThanOrEqual(before);
      expect(uploadedAt).toBeLessThanOrEqual(after);

      // The bytes are kept under a key the server made up, and nowhere else.
      const version = await ctx.prisma.documentVersion.findFirstOrThrow();
      expect(version.storageKey).toMatch(UUID);
      expect(await stored()).toEqual({ staging: [], objects: [version.storageKey] });
      const [event] = await ctx.prisma.auditEvent.findMany({
        where: { action: 'DOCUMENT_VERSION_UPLOADED' },
      });
      expect(event).toMatchObject({
        actorUserId: s.exporter.operator.user.id,
        actorOrganizationId: s.exporter.organization.id,
        voyageId: s.voyage.id,
        payload: {
          documentId: document.id,
          contractId: s.c1,
          instructionId: s.instruction.id,
          revisionNumber: 1,
          documentType: 'BILL_OF_LADING',
          versionNumber: 1,
          fileName: 'bill-of-lading.pdf',
          mediaType: 'application/pdf',
          sizeBytes: bytes.length,
          sha256: sha256(bytes).toString('hex'),
          uploadedAt: document.currentVersion.uploadedAt,
          version: 1,
        },
      });
    });

    it('serves exactly the bytes uploaded, as an attachment that is never run or sniffed', async () => {
      const s = await scenario();
      const bytes = pdf(1024 * 1024 + 7);
      await uploaded(s, bytes);

      const response = await download(s.trader.viewer.cookie, s, 1).expect(200);

      expect(Buffer.isBuffer(response.body)).toBe(true);
      expect((response.body as Buffer).equals(bytes)).toBe(true);
      expect(response.headers).toMatchObject({
        'content-type': 'application/pdf',
        'content-length': String(bytes.length),
        'content-disposition': `attachment; filename="bill-of-lading.pdf"; filename*=UTF-8''bill-of-lading.pdf`,
        'x-content-type-options': 'nosniff',
        'content-security-policy': "default-src 'none'; sandbox",
        'cache-control': 'no-store',
        'repr-digest': `sha-256=:${sha256(bytes).toString('base64')}:`,
      });
      expect(response.headers.etag).toBeUndefined();
    });

    it('accepts a file of exactly 10 MiB', async () => {
      const s = await scenario();
      const bytes = pdf(MAX_DOCUMENT_BYTES);

      const document = await uploaded(s, bytes);

      expect(document.currentVersion.sizeBytes).toBe(MAX_DOCUMENT_BYTES);
      const response = await download(s.exporter.viewer.cookie, s, 1).expect(200);
      expect((response.body as Buffer).equals(bytes)).toBe(true);
    });

    it('uploads each required document of the revision on its own', async () => {
      const s = await scenario();

      await uploaded(s, pdf(), { type: 'BILL_OF_LADING' });
      await uploaded(s, pdf(), { type: 'PHYTOSANITARY_CERTIFICATE' });

      expect(await writes()).toEqual({ documents: 2, versions: 2, uploadEvents: 2 });
    });
  });

  describe('replacing a document (POST .../versions with If-Match)', () => {
    it('adds a version and keeps every earlier one exactly as it was', async () => {
      const s = await scenario();
      const firstBytes = pdf(30_000);
      const first = await uploaded(s, firstBytes);
      const colleague = await colleagueOf(s.exporter);
      const secondBytes = pdf(40_000);

      const response = await replace(colleague.cookie, s, 1, { bytes: secondBytes }).expect(201);

      expect(response.headers.etag).toBe('"2"');
      expect(response.headers.location).toBe(contentPath(s, 2));
      const second = ContractDocumentSchema.parse(response.body);
      expect(second.id).toBe(first.id);
      expect(second.currentVersion).toMatchObject({
        number: 2,
        fileName: 'bill-of-lading-v2.pdf',
        sizeBytes: secondBytes.length,
        sha256: sha256(secondBytes).toString('hex'),
        uploadedBy: { name: `Test User ${colleague.user.email}` },
      });
      expect(second.previousVersions).toEqual([first.currentVersion]);

      const versionOne = await download(s.trader.viewer.cookie, s, 1).expect(200);
      const versionTwo = await download(s.trader.viewer.cookie, s, 2).expect(200);
      expect((versionOne.body as Buffer).equals(firstBytes)).toBe(true);
      expect((versionTwo.body as Buffer).equals(secondBytes)).toBe(true);
      expect((await stored()).objects).toHaveLength(2);
      expect(await writes()).toEqual({ documents: 1, versions: 2, uploadEvents: 2 });
    });

    it.each<[string, (s: Scenario) => request.Test, number, string]>([
      [
        'names no version',
        (s) => upload(s.exporter.operator.cookie, s, { headers: {} }),
        428,
        'Send If-None-Match: * to upload the first version of this document, or If-Match with the version you are replacing.',
      ],
      [
        'asks to create a document that has a version',
        (s) => upload(s.exporter.operator.cookie, s),
        412,
        'This document already has version 1. Review it, then upload a replacement with If-Match: "1".',
      ],
      [
        'replaces a version that is no longer current',
        (s) => replace(s.exporter.operator.cookie, s, 7),
        412,
        'The document has changed since the version you sent; it is now at version 1. Review its latest file and any decision on it before replacing it.',
      ],
      [
        'replaces a document that has no version yet',
        (s) => replace(s.exporter.operator.cookie, s, 1, { type: 'PHYTOSANITARY_CERTIFICATE' }),
        412,
        'This document has no version yet. Upload the first one with If-None-Match: *.',
      ],
    ])('refuses an upload that %s, storing nothing', async (_case, send, status, detail) => {
      const s = await scenario();
      await uploaded(s);
      const before = await stored();

      const response = await send(s).expect(status);

      expect(problemOf(response.body).detail).toBe(detail);
      expect(await writes()).toEqual({ documents: 1, versions: 1, uploadEvents: 1 });
      expect(await stored()).toEqual(before);
    });

    it('refuses If-Match with If-None-Match, and a weak or wildcard tag', async () => {
      const s = await scenario();
      await uploaded(s);

      await upload(s.exporter.operator.cookie, s, {
        headers: { 'If-Match': '"1"', 'If-None-Match': '*' },
      }).expect(400);
      await upload(s.exporter.operator.cookie, s, { headers: { 'If-Match': 'W/"1"' } }).expect(412);
      await upload(s.exporter.operator.cookie, s, { headers: { 'If-Match': '*' } }).expect(428);
      expect(await writes()).toEqual({ documents: 1, versions: 1, uploadEvents: 1 });
    });
  });

  describe('a refusal that comes before the file is read', () => {
    // Node resets the connection under a client still sending a large body, unless the server
    // reads it first: the client would see a network error instead of the answer.
    const large = () => pdf(3 * 1024 * 1024);

    it.each<[string, (s: Scenario) => request.Test, number]>([
      [
        'a guard (no session)',
        (s) =>
          api()
            .post(versionsPath(s))
            .set('If-None-Match', '*')
            .attach('file', large(), { filename: 'bl.pdf', contentType: 'application/pdf' }),
        401,
      ],
      [
        'the precondition headers',
        (s) => upload(s.exporter.operator.cookie, s, { bytes: large(), headers: {} }),
        428,
      ],
      [
        'the side of the contract',
        (s) => upload(s.trader.operator.cookie, s, { bytes: large() }),
        403,
      ],
      ['visibility', (s) => upload(s.outsider.operator.cookie, s, { bytes: large() }), 404],
      [
        'a superseded revision',
        (s) => upload(s.exporter.operator.cookie, s, { bytes: large(), revision: 1 }),
        409,
      ],
      [
        'the precondition',
        (s) => replace(s.exporter.operator.cookie, s, 1, { bytes: large() }),
        412,
      ],
      [
        'the declared type of the file',
        (s) => upload(s.exporter.operator.cookie, s, { bytes: large(), contentType: 'image/png' }),
        415,
      ],
    ])('still reaches the client when it is %s', async (_case, send, status) => {
      const s = await scenario();
      if (status === 409) await revise(s).expect(200);

      const response = await send(s);

      expect(response.status).toBe(status);
      expect(ProblemDetailsSchema.parse(response.body).status).toBe(status);
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });
  });

  describe('who may upload', () => {
    it('refuses a viewer of the seller, and any user of the buyer, with 403', async () => {
      const s = await scenario();

      const viewer = await upload(s.exporter.viewer.cookie, s).expect(403);
      const buyer = await upload(s.trader.operator.cookie, s).expect(403);

      expect(problemOf(viewer.body)).toEqual(
        problem(403, 'Forbidden', 'Your role does not allow you to upload documents.'),
      );
      expect(problemOf(buyer.body)).toEqual(
        problem(403, 'Forbidden', 'Only the seller under a contract may upload its documents.'),
      );
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });

    it('answers everyone else exactly like a contract that does not exist', async () => {
      const s = await scenario();

      for (const { cookie } of [
        s.buyer.operator,
        s.surveyor.operator,
        s.agent.operator,
        s.outsider.operator,
      ]) {
        const hidden = await upload(cookie, s).expect(404);
        const missing = await upload(cookie, s, { contractId: MISSING_ID }).expect(404);
        expect(problemOf(hidden.body)).toEqual(problemOf(missing.body));
        expect(problemOf(hidden.body)).toEqual(
          problem(404, 'Not Found', 'Contract was not found.'),
        );
      }
      // A contract of another voyage, through this voyage's path, even for its seller.
      await upload(s.exporter.operator.cookie, s, { contractId: s.d1 }).expect(404);
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });

    it('refuses an upload without a session, or from another site, before reading it', async () => {
      const s = await scenario();

      await api()
        .post(versionsPath(s))
        .set('If-None-Match', '*')
        .attach('file', pdf(), 'bl.pdf')
        .expect(401);
      await upload(s.exporter.operator.cookie, s).set('Sec-Fetch-Site', 'cross-site').expect(403);

      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });
  });

  describe('reading', () => {
    it('lists the documents to both counterparties, viewers included, each from its side', async () => {
      const s = await scenario();
      const document = await uploaded(s);

      for (const [reader, side] of [
        [s.exporter.viewer, 'SELLER'],
        [s.trader.viewer, 'BUYER'],
        [s.trader.operator, 'BUYER'],
      ] as const) {
        const response = await api().get(listPath(s.voyage.id)).set('Cookie', reader.cookie);
        expect(DocumentListResponseSchema.parse(response.body)).toEqual({
          items: [{ ...document, contract: { ...document.contract, side } }],
        });
      }
    });

    it('lists nothing to other participants, and answers outsiders 404', async () => {
      const s = await scenario();
      await uploaded(s);

      for (const { cookie } of [s.buyer.viewer, s.surveyor.operator, s.agent.viewer]) {
        const response = await api().get(listPath(s.voyage.id)).set('Cookie', cookie).expect(200);
        expect(response.body).toEqual({ items: [] });
      }
      const outsider = await api()
        .get(listPath(s.voyage.id))
        .set('Cookie', s.outsider.viewer.cookie)
        .expect(404);
      expect(problemOf(outsider.body)).toEqual(problem(404, 'Not Found', 'Voyage was not found.'));
    });

    it('lets both counterparties download, and everyone else gets a missing document', async () => {
      const s = await scenario();
      await uploaded(s);

      await download(s.exporter.viewer.cookie, s, 1).expect(200);
      await download(s.trader.viewer.cookie, s, 1).expect(200);
      for (const { cookie } of [
        s.buyer.operator,
        s.surveyor.viewer,
        s.agent.operator,
        s.outsider.viewer,
      ]) {
        const hidden = await download(cookie, s, 1).expect(404);
        const missing = await download(s.trader.viewer.cookie, s, 1, {
          contractId: MISSING_ID,
        }).expect(404);
        expect(hidden.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(hidden.headers['content-disposition']).toBeUndefined();
        expect(problemOf(JSON.parse(hidden.text || (hidden.body as Buffer).toString()))).toEqual(
          problemOf(JSON.parse(missing.text || (missing.body as Buffer).toString())),
        );
      }
      // Missing versions, documents, revisions and types look the same to a counterparty.
      for (const [version, target] of [
        [2, {}],
        [1, { type: 'PHYTOSANITARY_CERTIFICATE' }],
        [1, { revision: 2 }],
        [1, { voyageId: s.other.id }],
      ] as const) {
        const response = await download(s.trader.viewer.cookie, s, version, target).expect(404);
        expect(problemOf(JSON.parse((response.body as Buffer).toString()))).toEqual(
          problem(404, 'Not Found', 'Document was not found.'),
        );
      }
      await download(s.trader.viewer.cookie, s, 1, { type: 'PACKING_LIST' }).expect(400);
      await download(s.trader.viewer.cookie, s, '01').expect(400);
    });

    it('stops serving a user who moved to another organization, at the next request', async () => {
      const s = await scenario();
      await uploaded(s);
      await ctx.prisma.user.update({
        where: { id: s.trader.viewer.user.id },
        data: { organizationId: s.outsider.organization.id },
      });

      await download(s.trader.viewer.cookie, s, 1).expect(404);
      await api().get(listPath(s.voyage.id)).set('Cookie', s.trader.viewer.cookie).expect(404);
    });
  });

  describe('what is accepted', () => {
    const refused = async () => {
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    };

    it('refuses a file that only claims to be a PDF', async () => {
      const s = await scenario();
      const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), randomBytes(1000)]);

      const response = await upload(s.exporter.operator.cookie, s, { bytes: png }).expect(415);

      expect(problemOf(response.body)).toEqual(
        problem(
          415,
          'Unsupported Media Type',
          'The file is not a PDF: a PDF file starts with "%PDF-".',
        ),
      );
      await refused();
    });

    it('refuses a PDF sent as another type, before reading it', async () => {
      const s = await scenario();

      const response = await upload(s.exporter.operator.cookie, s, {
        contentType: 'image/png',
      }).expect(415);

      expect(problemOf(response.body).detail).toBe('Only PDF files are accepted.');
      await refused();
    });

    it('refuses an empty file', async () => {
      const s = await scenario();

      const response = await upload(s.exporter.operator.cookie, s, {
        bytes: Buffer.alloc(0),
      }).expect(400);

      expect(problemOf(response.body)).toEqual(validation('body.file', 'The file is empty.'));
      await refused();
    });

    it('refuses a file one byte over 10 MiB, while receiving it', async () => {
      const s = await scenario();

      const response = await upload(s.exporter.operator.cookie, s, {
        bytes: pdf(MAX_DOCUMENT_BYTES + 1),
      }).expect(413);

      expect(problemOf(response.body)).toEqual(
        problem(413, 'Payload Too Large', 'The file is larger than 10 MiB.'),
      );
      await refused();
    });

    it('refuses a body that says it is too large without reading it', async () => {
      const s = await scenario();
      const { port } = byHand.address() as AddressInfo;

      const answer = await new Promise<{ status: number; connection: string | undefined }>(
        (resolve, reject) => {
          const sent = http.request({
            host: '127.0.0.1',
            port,
            method: 'POST',
            path: versionsPath(s),
            headers: {
              Cookie: s.exporter.operator.cookie,
              'If-None-Match': '*',
              'Content-Type': 'multipart/form-data; boundary=x',
              'Content-Length': MAX_UPLOAD_REQUEST_BYTES + 1,
            },
          });
          sent.on('response', (response) => {
            resolve({ status: response.statusCode ?? 0, connection: response.headers.connection });
            response.resume();
            sent.destroy();
          });
          sent.on('error', reject);
          sent.flushHeaders();
        },
      );

      expect(answer).toEqual({ status: 413, connection: 'close' });
      await refused();
    });

    it.each<[string, (test: request.Test) => request.Test, object]>([
      [
        'no file',
        (test) => test.field('note', 'see attached'),
        validation('body.note', 'Unexpected field: send only the file, as "file".'),
      ],
      [
        'a file under another name',
        (test) => test.attach('document', pdf(), 'bl.pdf'),
        validation('body.document', 'Unexpected file field: send the file as "file".'),
      ],
      [
        'a second file',
        (test) =>
          test
            .attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' })
            .attach('file', pdf(), { filename: 'b.pdf', contentType: 'application/pdf' }),
        validation('body', 'Send exactly one part: the file, as "file".'),
      ],
      [
        'a field next to the file',
        (test) =>
          test
            .attach('file', pdf(), { filename: 'a.pdf', contentType: 'application/pdf' })
            .field('uploadedBy', 'someone else'),
        validation('body.uploadedBy', 'Unexpected field: send only the file, as "file".'),
      ],
    ])('refuses a form with %s', async (_case, build, expected) => {
      const s = await scenario();
      const test = api()
        .post(versionsPath(s))
        .set('Cookie', s.exporter.operator.cookie)
        .set('If-None-Match', '*');

      const response = await build(test).expect(400);

      expect(problemOf(response.body)).toEqual(expected);
      await refused();
    });

    it('refuses an empty form, a body that is not multipart, and a malformed one', async () => {
      const s = await scenario();
      const send = () =>
        api()
          .post(versionsPath(s))
          .set('Cookie', s.exporter.operator.cookie)
          .set('If-None-Match', '*');

      const empty = await send()
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send('--x--\r\n')
        .expect(400);
      const json = await send()
        .send({ file: pdf().toString('base64') })
        .expect(415);
      const truncated = await send()
        .set('Content-Type', 'multipart/form-data; boundary=x')
        .send(
          '--x\r\nContent-Disposition: form-data; name="file"; filename="a.pdf"\r\n' +
            'Content-Type: application/pdf\r\n\r\n%PDF-1.7 and then nothing',
        )
        .expect(400);
      const unbounded = await send()
        .set('Content-Type', 'multipart/form-data')
        .send('%PDF-1.7')
        .expect(400);

      expect(problemOf(empty.body)).toEqual(validation('body.file', 'Attach the file as "file".'));
      expect(problemOf(json.body).detail).toBe(
        'Send the file as multipart/form-data, in a field named "file".',
      );
      expect(problemOf(truncated.body)).toEqual(
        validation('body', 'The multipart body is malformed or incomplete.'),
      );
      expect(problemOf(unbounded.body)).toEqual(
        validation('header.content-type', 'The multipart boundary is missing or malformed.'),
      );
      await refused();
    });

    it('keeps the client’s file name for display only, never as a path', async () => {
      const s = await scenario();

      const document = await uploaded(s, pdf(), {});
      const traversal = await replace(s.exporter.operator.cookie, s, 1, {
        fileName: '../../objects/../staging/evil.pdf',
      }).expect(201);
      const accented = await replace(s.exporter.operator.cookie, s, 2, {
        fileName: 'Conhecimento nº 7 – Grãos.pdf',
      }).expect(201);

      expect(document.currentVersion.fileName).toBe('bill-of-lading.pdf');
      expect(ContractDocumentSchema.parse(traversal.body).currentVersion.fileName).toBe('evil.pdf');
      expect(ContractDocumentSchema.parse(accented.body).currentVersion.fileName).toBe(
        'Conhecimento nº 7 – Grãos.pdf',
      );
      const keys = (await ctx.prisma.documentVersion.findMany()).map(
        ({ storageKey }) => storageKey,
      );
      expect(await stored()).toEqual({ staging: [], objects: [...keys].sort() });
      for (const key of keys) expect(key).toMatch(UUID);

      const response = await download(s.trader.viewer.cookie, s, 3).expect(200);
      expect(response.headers['content-disposition']).toBe(
        `attachment; filename="Conhecimento no 7  Graos.pdf"; ` +
          `filename*=UTF-8''Conhecimento%20n%C2%BA%207%20%E2%80%93%20Gr%C3%A3os.pdf`,
      );
    });
  });

  describe('against the instruction revisions', () => {
    it('refuses a document the revision does not require, and a revision that does not exist', async () => {
      const s = await scenario();

      const notRequired = await upload(s.exporter.operator.cookie, s, {
        type: 'CERTIFICATE_OF_ORIGIN',
      }).expect(404);
      const noRevision = await upload(s.exporter.operator.cookie, s, { revision: 2 }).expect(404);
      const noInstructions = await upload(s.trader.operator.cookie, s, {
        contractId: s.c2,
      }).expect(404);

      expect(problemOf(notRequired.body).detail).toBe(
        'Revision 1 does not require a document of type CERTIFICATE_OF_ORIGIN.',
      );
      expect(problemOf(noRevision.body).detail).toBe('Revision was not found.');
      expect(problemOf(noInstructions.body).detail).toBe('Revision was not found.');
      await upload(s.exporter.operator.cookie, s, { type: 'PACKING_LIST' }).expect(400);
      await upload(s.exporter.operator.cookie, s, { revision: '0' }).expect(400);
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });

    it('refuses documents for a superseded revision, and keeps those already presented', async () => {
      const s = await scenario();
      const presented = await uploaded(s);
      await revise(s).expect(200);

      const first = await upload(s.exporter.operator.cookie, s, {
        type: 'PHYTOSANITARY_CERTIFICATE',
      }).expect(409);
      const replacement = await replace(s.exporter.operator.cookie, s, 1).expect(409);

      for (const response of [first, replacement]) {
        expect(problemOf(response.body)).toEqual(
          problem(
            409,
            'Conflict',
            'Revision 1 has been superseded by revision 2; documents are presented against the current revision.',
          ),
        );
      }
      expect(await writes()).toEqual({ documents: 1, versions: 1, uploadEvents: 1 });
      // What was presented against revision 1 stays readable.
      const list = await api().get(listPath(s.voyage.id)).set('Cookie', s.trader.viewer.cookie);
      expect(DocumentListResponseSchema.parse(list.body).items).toEqual([
        { ...presented, contract: { ...presented.contract, side: 'BUYER' } },
      ]);
      await download(s.trader.viewer.cookie, s, 1).expect(200);
      // The current revision takes documents, including the type revision 1 also required.
      await upload(s.exporter.operator.cookie, s, { revision: 2 }).expect(201);
      await upload(s.exporter.operator.cookie, s, {
        revision: 2,
        type: 'CERTIFICATE_OF_ORIGIN',
      }).expect(201);
      const items = DocumentListResponseSchema.parse(
        (await api().get(listPath(s.voyage.id)).set('Cookie', s.trader.viewer.cookie)).body,
      ).items.map(({ revisionNumber, documentType }) => [revisionNumber, documentType]);
      expect(items).toEqual([
        [2, 'BILL_OF_LADING'],
        [2, 'CERTIFICATE_OF_ORIGIN'],
        [1, 'BILL_OF_LADING'],
      ]);
    });

    /** Revision 2, written in the lock holder's transaction as the API writes it. */
    const revisionTwo =
      (s: Scenario): Change =>
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

    it('refuses the upload when the revision is superseded after its bytes arrived', async () => {
      const s = await scenario();
      // Every check before the bytes passes; the commit then waits on the instruction row.
      const lock = await holdLock(
        ctx.prisma,
        (tx) =>
          tx.$queryRaw`SELECT id FROM documentary_instructions WHERE id = ${s.instruction.id}::uuid FOR UPDATE`,
      );
      const response = upload(s.exporter.operator.cookie, s).then((answer) => answer);
      await waitForLockWaiters(ctx.prisma, 1);
      expect((await stored()).objects).toHaveLength(1);

      await lock.release(revisionTwo(s));

      const answer = await response;
      expect(answer.status).toBe(409);
      expect(problemOf(answer.body).detail).toBe(
        'Revision 1 has been superseded by revision 2; documents are presented against the current revision.',
      );
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      // The bytes it had already kept are gone again.
      expect(await stored()).toEqual(NOTHING_STORED);
    });

    it('makes a revision given while an upload commits wait for it, then supersede it', async () => {
      const s = await scenario();
      const sending = uploadByHand(s.exporter.operator.cookie, versionsPath(s), pdf(100_000));
      await receiving();
      // The commit runs up to its version insert and waits there, holding its share lock.
      const lock = await holdLock(ctx.prisma, (tx) =>
        tx.$executeRawUnsafe('LOCK TABLE document_versions IN ACCESS EXCLUSIVE MODE'),
      );
      const uploadAnswer = sending.finish();
      await waitForLockWaiters(ctx.prisma, 1);
      const revision = revise(s).then((answer) => answer);
      await waitForLockWaiters(ctx.prisma, 2);

      await lock.release();

      expect((await uploadAnswer).status).toBe(201);
      expect((await revision).status).toBe(200);
      const document = await ctx.prisma.document.findFirstOrThrow();
      expect(document.revisionNumber).toBe(1);
      // From now on, revision 1 takes no more.
      await replace(s.exporter.operator.cookie, s, 1).expect(409);
    });
  });

  describe('races against PostgreSQL', () => {
    /** Holds a row's lock until both uploads are blocked on it, then lets them go. */
    async function race(
      table: 'documentary_instructions' | 'documents',
      id: string,
      contenders: [() => request.Test, () => request.Test],
    ) {
      const objectsBefore = (await stored()).objects.length;
      const lock = await holdLock(ctx.prisma, (tx) =>
        tx.$queryRawUnsafe(`SELECT id FROM ${table} WHERE id = $1::uuid FOR UPDATE`, id),
      );
      const answers = Promise.all(contenders.map((send) => send().then((answer) => answer)));
      try {
        await waitForLockWaiters(ctx.prisma, 2);
        // Both have their bytes kept and are waiting to commit.
        expect((await stored()).objects).toHaveLength(objectsBefore + 2);
      } finally {
        await lock.release();
      }
      return answers;
    }

    it('stores exactly one first version when two race, and removes the loser’s bytes', async () => {
      const s = await scenario();
      const colleague = await colleagueOf(s.exporter);
      const ours = pdf(10_000);
      const theirs = pdf(20_000);

      const answers = await race('documentary_instructions', s.instruction.id, [
        () => upload(s.exporter.operator.cookie, s, { bytes: ours }),
        () => upload(colleague.cookie, s, { bytes: theirs }),
      ]);

      expect(answers.map(({ status }) => status).sort()).toEqual([201, 412]);
      const winner = ContractDocumentSchema.parse(
        answers.find(({ status }) => status === 201)?.body,
      );
      const loser = answers.find(({ status }) => status === 412);
      expect(problemOf(loser?.body).detail).toBe(
        'This document already has version 1. Review it, then upload a replacement with If-Match: "1".',
      );
      expect(await writes()).toEqual({ documents: 1, versions: 1, uploadEvents: 1 });
      const version = await ctx.prisma.documentVersion.findFirstOrThrow();
      expect(await stored()).toEqual({ staging: [], objects: [version.storageKey] });
      const kept = await download(s.trader.viewer.cookie, s, 1).expect(200);
      expect(sha256(kept.body as Buffer).toString('hex')).toBe(winner.currentVersion.sha256);
    });

    it('stores exactly one replacement when two replacements of the same version race', async () => {
      const s = await scenario();
      const first = await uploaded(s);
      const colleague = await colleagueOf(s.exporter);

      const answers = await race('documents', first.id, [
        () => replace(s.exporter.operator.cookie, s, 1),
        () => replace(colleague.cookie, s, 1),
      ]);

      expect(answers.map(({ status }) => status).sort()).toEqual([201, 412]);
      expect(await writes()).toEqual({ documents: 1, versions: 2, uploadEvents: 2 });
      const versions = await ctx.prisma.documentVersion.findMany();
      expect(await stored()).toEqual({
        staging: [],
        objects: versions.map(({ storageKey }) => storageKey).sort(),
      });
      const winner = ContractDocumentSchema.parse(
        answers.find(({ status }) => status === 201)?.body,
      );
      expect(winner.currentVersion.number).toBe(2);
    });
  });

  describe('aborted uploads', () => {
    it('keeps nothing of an upload the client abandons part-way', async () => {
      const s = await scenario();
      const sending = uploadByHand(s.exporter.operator.cookie, versionsPath(s), pdf(2_000_000));
      await receiving();

      sending.abort();

      await until(
        async () => (await storage.files('staging')).length === 0,
        'the partial upload is removed',
      );
      expect(await stored()).toEqual(NOTHING_STORED);
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      // The server is fine: the next upload goes through.
      await uploaded(s);
    });
  });

  describe('when the session changes while the file is arriving', () => {
    it('stores nothing for a session that ended meanwhile', async () => {
      const s = await scenario();
      const sending = uploadByHand(s.exporter.operator.cookie, versionsPath(s), pdf(100_000));
      await receiving();
      await ctx.prisma.session.updateMany({
        where: { userId: s.exporter.operator.user.id },
        data: { revokedAt: new Date() },
      });

      const answer = await sending.finish();

      expect(answer.status).toBe(401);
      expect(problemOf(answer.body).detail).toBe(
        'Your session ended before the upload completed. Sign in and upload the file again.',
      );
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });

    it('applies a role taken away meanwhile', async () => {
      const s = await scenario();
      const sending = uploadByHand(s.exporter.operator.cookie, versionsPath(s), pdf(100_000));
      await receiving();
      await ctx.prisma.user.update({
        where: { id: s.exporter.operator.user.id },
        data: { role: 'VIEWER' },
      });

      expect((await sending.finish()).status).toBe(403);
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });

    it('applies a move to another organization meanwhile', async () => {
      const s = await scenario();
      const sending = uploadByHand(s.exporter.operator.cookie, versionsPath(s), pdf(100_000));
      await receiving();
      await ctx.prisma.user.update({
        where: { id: s.exporter.operator.user.id },
        data: { organizationId: s.outsider.organization.id },
      });

      const answer = await sending.finish();

      expect(answer.status).toBe(404);
      expect(problemOf(answer.body).detail).toBe('Contract was not found.');
      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });
  });

  describe('when storage or the audit trail fails', () => {
    it('stores nothing when the bytes cannot be staged', async () => {
      const s = await scenario();
      storage.failNext('stage');

      expectGeneric500((await upload(s.exporter.operator.cookie, s).expect(500)).body);

      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });

    it('discards the staged bytes when they cannot be kept', async () => {
      const s = await scenario();
      storage.failNext('promote');

      expectGeneric500((await upload(s.exporter.operator.cookie, s).expect(500)).body);

      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
    });

    it('removes the kept bytes when the audit event cannot be written', async () => {
      const s = await scenario();

      await failAuditWrites(ctx.prisma, async () => {
        expectGeneric500((await upload(s.exporter.operator.cookie, s).expect(500)).body);
      });

      expect(await writes()).toEqual(NOTHING_WRITTEN);
      expect(await stored()).toEqual(NOTHING_STORED);
      // Nothing was half-done: the same upload goes through now.
      await uploaded(s);
    });

    it('leaves an orphan, and no row, when even the compensation fails', async () => {
      const s = await scenario();
      storage.failNext('remove');

      await failAuditWrites(ctx.prisma, async () => {
        expectGeneric500((await upload(s.exporter.operator.cookie, s).expect(500)).body);
      });

      expect(await writes()).toEqual(NOTHING_WRITTEN);
      // The orphan named by no version: what reconciliation removes (docs/architecture.md).
      const { objects } = await stored();
      expect(objects).toHaveLength(1);
      expect(
        await ctx.prisma.documentVersion.count({ where: { storageKey: objects[0] ?? '' } }),
      ).toBe(0);
    });

    it('never serves bytes that are missing, unreadable, or not the bytes uploaded', async () => {
      const s = await scenario();
      await uploaded(s, pdf(5000));
      const { storageKey } = await ctx.prisma.documentVersion.findFirstOrThrow();

      storage.failNext('read');
      const unreadable = await download(s.trader.viewer.cookie, s, 1).expect(500);
      // Same size, different bytes: only the checksum tells.
      await writeFile(storage.pathOf(storageKey), pdf(5000));
      const tampered = await download(s.trader.viewer.cookie, s, 1).expect(500);
      await storage.remove(storageKey);
      const missing = await download(s.trader.viewer.cookie, s, 1).expect(500);

      for (const response of [unreadable, tampered, missing]) {
        expect(response.headers['content-type']).toMatch(/^application\/problem\+json/);
        expect(response.headers['content-disposition']).toBeUndefined();
        expectGeneric500(JSON.parse((response.body as Buffer).toString()));
      }
    });
  });

  describe('immutability and invariants, for every writer', () => {
    /** Statements as any writer with table access could send them; the database must refuse. */
    const sql = (statement: string, ...values: unknown[]) =>
      ctx.prisma.$executeRawUnsafe(statement, ...values);

    /** A document and its first version, inserted directly in one transaction. */
    const insertDirectly = (
      s: Scenario,
      {
        revision = 1,
        type = 'BILL_OF_LADING',
        instructionId = s.instruction.id,
        contractId = s.c1,
        withVersion = true,
        storageKey = randomUUID(),
        fileName = 'bl.pdf',
        mediaType = 'application/pdf',
        size = 10,
        digest = sha256(Buffer.from('x')),
      }: {
        revision?: number;
        type?: string;
        instructionId?: string;
        contractId?: string;
        withVersion?: boolean;
        storageKey?: string;
        fileName?: string;
        mediaType?: string;
        size?: number;
        digest?: Buffer;
      } = {},
    ) =>
      ctx.prisma.$transaction(async (tx) => {
        const [document] = await tx.$queryRawUnsafe<{ id: string }[]>(
          `INSERT INTO documents (voyage_id, trade_contract_id, instruction_id, revision_number, document_type)
           VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5::document_type) RETURNING id`,
          s.voyage.id,
          contractId,
          instructionId,
          revision,
          type,
        );
        if (!withVersion) {
          // Checked now rather than at commit, so the trigger's own message is what fails.
          await tx.$executeRawUnsafe('SET CONSTRAINTS "documents_require_version" IMMEDIATE');
        } else {
          await tx.$executeRawUnsafe(
            `INSERT INTO document_versions (document_id, version_number, storage_key, file_name,
               media_type, size_bytes, sha256, uploaded_by_user_id, uploaded_by_organization_id,
               uploaded_at)
             VALUES ($1::uuid, 1, $2, $3, $4, $5, $6, $7::uuid, $8::uuid, now())`,
            document?.id,
            storageKey,
            fileName,
            mediaType,
            size,
            digest,
            s.exporter.operator.user.id,
            s.exporter.organization.id,
          );
        }
      });

    it('accepts a well-formed document written directly', async () => {
      const s = await scenario();

      await insertDirectly(s);

      expect(await writes()).toMatchObject({ documents: 1, versions: 1 });
    });

    it.each([
      ['the file name', `file_name = 'edited.pdf'`],
      ['the storage key', `storage_key = '${randomUUID()}'`],
      ['the checksum', `sha256 = sha256('edited')`],
      ['the uploader', `uploaded_at = now()`],
      ['the number', `version_number = 7`],
    ])('refuses changing %s of a version', async (_field, assignment) => {
      const s = await scenario();
      await uploaded(s);

      await expect(sql(`UPDATE document_versions SET ${assignment}`)).rejects.toThrow(
        /document_versions: rows are immutable/,
      );
    });

    it('lets a document change only by advancing its version by one, with that version', async () => {
      const s = await scenario();
      await uploaded(s);

      await expect(
        sql(`UPDATE documents SET document_type = 'PHYTOSANITARY_CERTIFICATE'`),
      ).rejects.toThrow(/what a document belongs to cannot change/);
      await expect(
        sql(
          'UPDATE documents SET version = version + 1, current_version_number = current_version_number + 2',
        ),
      ).rejects.toThrow(/versions are numbered one after another/);
      await expect(
        sql('UPDATE documents SET current_version_number = current_version_number + 1'),
      ).rejects.toThrow(/every change advances the version by exactly one/);
      await expect(
        sql(
          'UPDATE documents SET version = version + 2, current_version_number = current_version_number + 1',
        ),
      ).rejects.toThrow(/every change advances the version by exactly one/);
      await expect(
        sql(
          'UPDATE documents SET version = version + 1, current_version_number = current_version_number + 1',
        ),
      ).rejects.toThrow(/the current version 2 does not exist/);
      await expect(
        insertDirectly(s, { type: 'PHYTOSANITARY_CERTIFICATE', withVersion: false }),
      ).rejects.toThrow(/the current version 1 does not exist/);
      await expect(
        ctx.prisma.$executeRaw`
          INSERT INTO document_versions (document_id, version_number, storage_key, file_name,
            media_type, size_bytes, sha256, uploaded_by_user_id, uploaded_by_organization_id,
            uploaded_at)
          SELECT id, 2, ${randomUUID()}, 'bl.pdf', 'application/pdf', 1, sha256('x'),
            ${s.exporter.operator.user.id}::uuid, ${s.exporter.organization.id}::uuid, now()
          FROM documents`,
      ).rejects.toThrow(/only the current version of a document can be written/);
    });

    it('accepts documents only for the current revision, and only of a type it requires', async () => {
      const s = await scenario();
      await uploaded(s);

      await expect(insertDirectly(s, { type: 'CERTIFICATE_OF_ORIGIN' })).rejects.toThrow(
        /revision 1 does not require CERTIFICATE_OF_ORIGIN/,
      );
      await revise(s).expect(200);
      await expect(insertDirectly(s, { type: 'PHYTOSANITARY_CERTIFICATE' })).rejects.toThrow(
        /only the current revision of an instruction accepts documents/,
      );
      // Nor a new version of a document of the superseded revision.
      await expect(
        ctx.prisma.$transaction(async (tx) => {
          await tx.$executeRaw`UPDATE documents SET version = 2, current_version_number = 2`;
          await tx.$executeRaw`
            INSERT INTO document_versions (document_id, version_number, storage_key, file_name,
              media_type, size_bytes, sha256, uploaded_by_user_id, uploaded_by_organization_id,
              uploaded_at)
            SELECT id, 2, ${randomUUID()}, 'bl.pdf', 'application/pdf', 1, sha256('x'),
              ${s.exporter.operator.user.id}::uuid, ${s.exporter.organization.id}::uuid, now()
            FROM documents`;
        }),
      ).rejects.toThrow(/only the current revision of an instruction accepts documents/);
    });

    it('keeps a document inside its contract, instruction and voyage', async () => {
      const s = await scenario();
      const other = await ctx.prisma.$transaction((tx) =>
        createInstruction(tx, { voyageId: s.voyage.id, contractId: s.c2, at: new Date() }).then(
          async (instruction) => {
            await tx.documentaryInstructionRevision.create({
              data: {
                instructionId: instruction?.id ?? '',
                revisionNumber: 1,
                consignee: 'To order',
                requirements: firstContent.requirements,
                createdByUserId: s.buyer.operator.user.id,
                createdByOrganizationId: s.buyer.organization.id,
                createdAt: new Date(),
              },
            });
            return instruction;
          },
        ),
      );

      // Contract 1's document, pointing at contract 2's instruction.
      await expect(insertDirectly(s, { instructionId: other?.id ?? '' })).rejects.toThrow(
        /documents_instruction_id_trade_contract_id_fkey/,
      );
      // Another voyage's contract.
      await expect(insertDirectly(s, { contractId: s.d1 })).rejects.toThrow(
        /documents_voyage_id_trade_contract_id_fkey/,
      );
    });

    it.each<[string, Parameters<typeof insertDirectly>[1], RegExp]>([
      ['a storage key that is a path', { storageKey: '../staging/x' }, /storage_key_format/],
      ['a file name with a separator', { fileName: 'scans/bl.pdf' }, /document_versions_file_name/],
      [
        'a file name with a backslash',
        { fileName: 'scans\\bl.pdf' },
        /document_versions_file_name/,
      ],
      [
        'a file name with a control character',
        { fileName: `bl${String.fromCodePoint(10)}.pdf` },
        /document_versions_file_name/,
      ],
      ['a blank file name', { fileName: ' ' }, /document_versions_file_name/],
      ['a file name over 255 characters', { fileName: 'a'.repeat(256) }, /file_name/],
      ['another media type', { mediaType: 'text/html' }, /document_versions_media_type/],
      ['an empty file', { size: 0 }, /document_versions_size/],
      ['a file over 10 MiB', { size: MAX_DOCUMENT_BYTES + 1 }, /document_versions_size/],
      ['a short checksum', { digest: Buffer.alloc(31) }, /document_versions_sha256_length/],
    ])('refuses a version with %s', async (_case, values, constraint) => {
      const s = await scenario();

      await expect(insertDirectly(s, values)).rejects.toThrow(constraint);
    });

    it('refuses deleting a revision, instruction or contract that documents were presented against', async () => {
      const s = await scenario();
      await uploaded(s);

      await expect(sql('DELETE FROM documentary_instruction_revisions')).rejects.toThrow(
        /documents_instruction_id_revision_number_fkey/,
      );
      await expect(sql('DELETE FROM documentary_instructions')).rejects.toThrow();
      await expect(ctx.prisma.tradeContract.delete({ where: { id: s.c1 } })).rejects.toThrow();
    });

    it('allows one upload event per document version, naming its checksum', async () => {
      const s = await scenario();
      const document = await uploaded(s);
      const event = await ctx.prisma.auditEvent.findFirstOrThrow({
        where: { action: 'DOCUMENT_VERSION_UPLOADED' },
      });
      const record = (payload: object) =>
        ctx.prisma.auditEvent.create({
          data: {
            action: 'DOCUMENT_VERSION_UPLOADED',
            actorUserId: event.actorUserId,
            actorOrganizationId: event.actorOrganizationId,
            voyageId: event.voyageId,
            payload,
          },
        });

      await expect(
        record({ documentId: document.id, versionNumber: 1, sha256: 'a'.repeat(64) }),
      ).rejects.toThrow();
      await expect(record({ documentId: document.id, versionNumber: 2 })).rejects.toThrow(
        /audit_events_document_payload/,
      );
    });
  });
});
