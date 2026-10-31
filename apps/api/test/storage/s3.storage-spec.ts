import { execFile } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import http, { type IncomingMessage } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { promisify } from 'node:util';
import {
  CreateBucketCommand,
  GetObjectCommand,
  ListMultipartUploadsCommand,
  PutObjectCommand,
  S3Client,
} from '@aws-sdk/client-s3';
import { DocumentaryInstructionSchema, MAX_DOCUMENT_BYTES } from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it, vi } from 'vitest';
import { loadConfig } from '../../src/config/app-config.js';
import { PrismaService } from '../../src/infrastructure/prisma/prisma.service.js';
import {
  DocumentStorage,
  StoredObjectMissingError,
} from '../../src/infrastructure/storage/document-storage.js';
import { verifyDocumentObjects } from '../../src/infrastructure/storage/document-integrity.js';
import { S3DocumentStorage } from '../../src/infrastructure/storage/s3-document-storage.js';
import { signIn } from '../support/auth.js';
import {
  failAuditWrites,
  failCommitsWriting,
  holdLock,
  waitForLockWaiters,
} from '../support/concurrency.js';
import {
  createOrganization,
  createReferenceData,
  createTradeString,
  createUser,
  createVoyage,
  resetDatabase,
} from '../support/database.js';
import { createTestApp, type TestApp } from '../support/test-app.js';
import './resources.js';

const exec = promisify(execFile);
const resources = inject('storageResources');
const environment = {
  NODE_ENV: 'test',
  DATABASE_URL: resources.databaseUrl,
  DOCUMENT_STORAGE_DRIVER: 's3',
  S3_BUCKET: 'tradeflow-storage-test',
  S3_REGION: 'us-east-1',
  S3_ENDPOINT: resources.endpoint,
  S3_FORCE_PATH_STYLE: 'true',
  S3_PREFIX: 'tests/',
  AWS_ACCESS_KEY_ID: resources.accessKeyId,
  AWS_SECRET_ACCESS_KEY: resources.secretAccessKey,
};
const config = loadConfig(environment);
const pdf = (size = 1024) => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(size - 9)]);
const checksum = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const parseBytes = (
  response: IncomingMessage,
  done: (error: Error | null, body: Buffer) => void,
) => {
  void buffer(response).then(
    (bytes) => {
      done(null, bytes);
    },
    (error: unknown) => {
      done(error instanceof Error ? error : new Error('Download failed'), Buffer.alloc(0));
    },
  );
};
const binary = parseBytes as unknown as Parameters<request.Test['parse']>[0];

describe('S3 documents against isolated PostgreSQL and authenticated SeaweedFS', () => {
  let ctx: TestApp;
  let storage: S3DocumentStorage;
  beforeAll(async () => {
    // These workers run only this suite. Never consult the developer's AWS profile or session.
    process.env.AWS_ACCESS_KEY_ID = resources.accessKeyId;
    process.env.AWS_SECRET_ACCESS_KEY = resources.secretAccessKey;
    delete process.env.AWS_SESSION_TOKEN;
    ctx = await createTestApp({ config });
    const adapter = ctx.app.get(DocumentStorage);
    if (!(adapter instanceof S3DocumentStorage))
      throw new Error('The configured adapter is not S3');
    storage = adapter;
  });
  afterAll(async () => {
    await ctx.app.close();
  });
  const keys = async () => {
    const found: string[] = [];
    for await (const key of storage.keys()) found.push(key);
    return found.sort();
  };
  beforeEach(async () => {
    await resetDatabase(ctx.prisma);
    for (const key of await keys()) await storage.remove(key);
  });
  const versions = () =>
    ctx.prisma.documentVersion.findMany({
      select: { id: true, storageKey: true, sizeBytes: true, sha256: true },
    });
  const verify = async () => verifyDocumentObjects(await versions(), storage, storage.keys());

  async function scenario() {
    const seller = await createOrganization(ctx.prisma, 'Seller');
    const buyer = await createOrganization(ctx.prisma, 'Buyer');
    const outsider = await createOrganization(ctx.prisma, 'Outsider');
    const sellerUser = await createUser(ctx.prisma, seller.id, { role: 'OPERATOR' });
    const buyerUser = await createUser(ctx.prisma, buyer.id, { role: 'OPERATOR' });
    const outsiderUser = await createUser(ctx.prisma, outsider.id, { role: 'OPERATOR' });
    const voyage = await createVoyage(ctx.prisma, await createReferenceData(ctx.prisma), {
      reference: 'TF-S3',
      participants: [
        { organizationId: seller.id, role: 'EXPORTER' },
        { organizationId: buyer.id, role: 'FINAL_BUYER' },
      ],
    });
    await createTradeString(ctx.prisma, voyage.id, [seller.id, buyer.id]);
    const contract = await ctx.prisma.tradeContract.findFirstOrThrow();
    const sellerCookie = await signIn(ctx.server, sellerUser.email);
    const buyerCookie = await signIn(ctx.server, buyerUser.email);
    const outsiderCookie = await signIn(ctx.server, outsiderUser.email);
    const base = `/api/voyages/${voyage.id}/contracts/${contract.id}/documentary-instructions`;
    const instruction = DocumentaryInstructionSchema.parse(
      (
        await request(ctx.server)
          .put(base)
          .set('Cookie', buyerCookie)
          .set('If-None-Match', '*')
          .send({
            consignee: 'Test consignee',
            requirements: [{ document: 'BILL_OF_LADING', originals: 3, copies: 1 }],
          })
          .expect(201)
      ).body,
    );
    const path = `${base}/revisions/1/documents/BILL_OF_LADING/versions`;
    const upload = (bytes = pdf(), version?: number) => {
      const send = request(ctx.server).post(path).set('Cookie', sellerCookie);
      if (version === undefined) send.set('If-None-Match', '*');
      else send.set('If-Match', `"${version}"`);
      return send.attach('file', bytes, { filename: 'bill.pdf', contentType: 'application/pdf' });
    };
    const download = (version: number, cookie = buyerCookie) =>
      request(ctx.server)
        .get(`${path}/${version}/content`)
        .set('Cookie', cookie)
        .buffer(true)
        .parse(binary);
    return { upload, download, instruction, path, sellerCookie, buyerCookie, outsiderCookie };
  }

  it('completes a multipart upload through the real SDK and reads identical bytes', async () => {
    const bytes = pdf(6 * 1024 * 1024);
    const staged = await storage.stage(Readable.from([bytes]));
    const key = await storage.promote(staged);
    expect(await buffer(await storage.read(key))).toEqual(bytes);
  });

  it('round-trips a multipart-sized PDF and historical versions through the real HTTP API', async () => {
    const s = await scenario();
    const first = pdf(6 * 1024 * 1024);
    const second = pdf(2000);
    await s.upload(first).expect(201);
    await s.upload(second, 1).expect(201);
    expect((await s.download(1).expect(200)).body).toEqual(first);
    expect((await s.download(2).expect(200)).body).toEqual(second);
    expect(await verify()).toEqual({ versions: 2, problems: [], orphans: [] });
    await s.download(1, s.outsiderCookie).expect(404);
    const [key] = await keys();
    expect(key).toBeDefined();
    expect(
      (await fetch(`${resources.endpoint}/tradeflow-storage-test/${storage.objectKey(key ?? '')}`))
        .status,
    ).toBe(403);
    const wrongCredentials = new S3Client({
      region: 'us-east-1',
      endpoint: resources.endpoint,
      forcePathStyle: true,
      credentials: { accessKeyId: 'unknown', secretAccessKey: 'unknown' },
      maxAttempts: 1,
    });
    try {
      await expect(
        wrongCredentials.send(
          new GetObjectCommand({
            Bucket: 'tradeflow-storage-test',
            Key: storage.objectKey(key ?? ''),
          }),
        ),
      ).rejects.toThrow();
    } finally {
      wrongCredentials.destroy();
    }
  });

  it('aborts an in-flight multipart source and removes its parts and any completed object', async () => {
    const source = new PassThrough();
    const result = storage.stage(source).then(
      () => null,
      (error: unknown) => error,
    );
    source.write(randomBytes(6 * 1024 * 1024));
    await expect
      .poll(
        async () =>
          (
            await storage.client.send(
              new ListMultipartUploadsCommand({ Bucket: storage.config.bucket }),
            )
          ).Uploads?.length ?? 0,
      )
      .toBe(1);
    source.destroy(new Error('client abandoned upload'));
    expect(await result).toBeInstanceOf(Error);
    expect(await keys()).toEqual([]);
    expect(
      (
        await storage.client.send(
          new ListMultipartUploadsCommand({ Bucket: storage.config.bucket }),
        )
      ).Uploads ?? [],
    ).toEqual([]);
  });

  it('cleans bytes when PDF validation or the streaming size limit refuses an upload', async () => {
    const s = await scenario();
    await s.upload(Buffer.alloc(1024)).expect(415);
    await s.upload(pdf(MAX_DOCUMENT_BYTES + 1)).expect(413);
    // No Content-Length: this must fail while receiving, after multipart storage has begun.
    const server = http.createServer(
      ctx.app.getHttpAdapter().getInstance() as http.RequestListener,
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    try {
      const status = await new Promise<number>((resolve, reject) => {
        const send = http.request(
          {
            hostname: '127.0.0.1',
            port: (server.address() as AddressInfo).port,
            path: s.path,
            method: 'POST',
            headers: {
              Cookie: s.sellerCookie,
              'If-None-Match': '*',
              'Content-Type': 'multipart/form-data; boundary=storage-test',
            },
          },
          (answer) => {
            answer.resume();
            answer.on('end', () => {
              resolve(answer.statusCode ?? 0);
            });
            answer.on('error', reject);
          },
        );
        send.on('error', reject);
        send.write(
          '--storage-test\r\nContent-Disposition: form-data; name="file"; filename="large.pdf"\r\nContent-Type: application/pdf\r\n\r\n',
        );
        send.write(pdf(MAX_DOCUMENT_BYTES + 1));
        send.end('\r\n--storage-test--\r\n');
      });
      expect(status).toBe(413);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => {
        server.close(() => {
          resolve();
        });
      });
    }
    expect(await ctx.prisma.documentVersion.count()).toBe(0);
    expect(await keys()).toEqual([]);
    expect(
      (
        await storage.client.send(
          new ListMultipartUploadsCommand({ Bucket: storage.config.bucket }),
        )
      ).Uploads ?? [],
    ).toEqual([]);
  });

  it.each([
    ['PutObjectCommand', 1024],
    ['CompleteMultipartUploadCommand', 6 * 1024 * 1024],
  ] as const)('compensates a real object after an unknown %s result', async (operation, size) => {
    let accepted = false;
    storage.client.middlewareStack.add(
      (next, context) => async (args) => {
        const result = await next(args);
        if (context.commandName === operation) {
          accepted = true;
          throw new Error('injected lost response after stored object');
        }
        return result;
      },
      { name: 'losePutResult', step: 'deserialize' },
    );
    try {
      await expect(storage.stage(Readable.from([pdf(size)]))).rejects.toThrow('lost response');
    } finally {
      storage.client.middlewareStack.remove('losePutResult');
    }
    expect(accepted).toBe(true);
    expect(await keys()).toEqual([]);
  });

  it('removes the losing concurrent upload after the conditional PostgreSQL write', async () => {
    const s = await scenario();
    const lock = await holdLock(
      ctx.prisma,
      (tx) =>
        tx.$queryRaw`SELECT id FROM documentary_instructions WHERE id = ${s.instruction.id}::uuid FOR UPDATE`,
    );
    const results = Promise.all([
      s.upload().then((r) => r.status),
      s.upload().then((r) => r.status),
    ]);
    try {
      await waitForLockWaiters(ctx.prisma, 2);
      expect(await keys()).toHaveLength(2);
    } finally {
      await lock.release();
    }
    expect((await results).sort()).toEqual([201, 412]);
    expect(await verify()).toEqual({ versions: 1, problems: [], orphans: [] });
  });

  it('removes bytes on a certain database rollback, and keeps them on an unknown COMMIT outcome', async () => {
    const s = await scenario();
    await failAuditWrites(ctx.prisma, async () => {
      await s.upload().expect(500);
    });
    expect(await keys()).toEqual([]);
    await failCommitsWriting(ctx.prisma, 'document_versions', async () => {
      await s.upload().expect(500);
    });
    expect(await ctx.prisma.documentVersion.count()).toBe(0);
    const kept = await keys();
    expect(kept).toHaveLength(1);
    expect(await verify()).toEqual({ versions: 0, problems: [], orphans: kept });
    expect(await keys()).toEqual(kept); // reconciliation reports; it never deletes
  });

  it('retains a referenced object when SQL committed but its acknowledgement is lost', async () => {
    const s = await scenario();
    const transaction = ctx.prisma.$transaction.bind(ctx.prisma);
    const fault = vi
      .spyOn(ctx.prisma, '$transaction')
      .mockImplementationOnce(async (fn, options) => {
        await transaction(fn, options);
        throw new Error('injected lost COMMIT acknowledgement after successful commit');
      });
    try {
      await s.upload().expect(500);
    } finally {
      fault.mockRestore();
    }
    expect(await verify()).toEqual({ versions: 1, problems: [], orphans: [] });
    await s.download(1).expect(200);
  });

  it('reports retained bytes when the provider also refuses upload compensation', async () => {
    storage.client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'DeleteObjectCommand')
          throw new Error('injected provider unavailable during compensation');
        const result = await next(args);
        if (context.commandName === 'PutObjectCommand')
          throw new Error('injected lost PUT acknowledgement');
        return result;
      },
      { name: 'failCompensation', step: 'deserialize' },
    );
    try {
      await expect(storage.stage(Readable.from([pdf()]))).rejects.toThrow('lost PUT');
    } finally {
      storage.client.middlewareStack.remove('failCompensation');
    }
    const kept = await keys();
    expect(kept).toHaveLength(1);
    expect(await verify()).toEqual({ versions: 0, problems: [], orphans: kept });
  });

  it('fails closed with a generic HTTP error when the provider refuses a write', async () => {
    const s = await scenario();
    storage.client.middlewareStack.add(
      (next, context) => async (args) => {
        if (context.commandName === 'PutObjectCommand')
          throw new Error('injected provider unavailable');
        return next(args);
      },
      { name: 'refusePut', step: 'deserialize' },
    );
    try {
      const answer = await s.upload().expect(500);
      expect(JSON.stringify(answer.body)).not.toMatch(/injected|provider|bucket|secret|storageKey/);
    } finally {
      storage.client.middlewareStack.remove('refusePut');
    }
    expect(await ctx.prisma.documentVersion.count()).toBe(0);
    expect(await keys()).toEqual([]);
  });

  it('reports corruption and missing bytes, refusing a complete-looking HTTP download', async () => {
    const s = await scenario();
    await s.upload().expect(201);
    const version = await ctx.prisma.documentVersion.findFirstOrThrow();
    await storage.client.send(
      new PutObjectCommand({
        Bucket: storage.config.bucket,
        Key: storage.objectKey(version.storageKey),
        Body: pdf(),
      }),
    );
    await s.download(1).expect(500);
    expect((await verify()).problems).toEqual([
      { versionId: version.id, key: version.storageKey, kind: 'checksum' },
    ]);
    await storage.remove(version.storageKey);
    await expect(storage.read(version.storageKey)).rejects.toBeInstanceOf(StoredObjectMissingError);
    expect((await verify()).problems[0]?.kind).toBe('missing');
    await storage.remove(version.storageKey);
  });

  it('refuses invalid keys before making a storage request', async () => {
    for (const key of ['../private', 'a/b', '', 'not-a-key']) {
      await expect(storage.read(key)).rejects.toThrow('Not a storage id');
      await expect(storage.remove(key)).rejects.toThrow('Not a storage id');
    }
  });

  it('backs up and restores the database and every object into an empty database and bucket', async () => {
    const s = await scenario();
    const bytes = [pdf(4096), pdf(6 * 1024 * 1024)];
    await s.upload(bytes[0]).expect(201);
    await s.upload(bytes[1], 1).expect(201);
    const root = await mkdtemp(join(tmpdir(), 'tradeflow-recovery-'));
    const targetName = `tradeflow_restore_${randomUUID().replaceAll('-', '')}_test`;
    const bucket = `restore-${randomUUID()}`;
    const targetUrl = new URL(resources.databaseUrl);
    targetUrl.pathname = `/${targetName}`;
    let restoredApp: TestApp | undefined;
    let targetDb: PrismaService | undefined;
    const tool = async (args: string[], env = environment) =>
      exec(process.execPath, ['--import', 'tsx', 'scripts/document-objects.ts', ...args], {
        windowsHide: true,
        env: { ...process.env, ...env },
        maxBuffer: 1024 * 1024,
        timeout: 30_000,
      });
    try {
      // No writers are running during this paired snapshot.
      const dump = await exec(
        'docker',
        [
          'exec',
          resources.postgresContainer,
          'pg_dump',
          '-U',
          'tradeflow',
          '-d',
          'tradeflow_storage_test',
          '--format=custom',
          '--no-owner',
          '--no-acl',
        ],
        { encoding: 'buffer', windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
      );
      await writeFile(join(root, 'database.dump'), dump.stdout, { mode: 0o600 });
      await tool(['export', join(root, 'objects')]);
      await expect(tool(['export', join(root, 'objects')])).rejects.toThrow(); // no overwrite
      await ctx.prisma.$executeRawUnsafe(`CREATE DATABASE "${targetName}"`);
      await storage.client.send(new CreateBucketCommand({ Bucket: bucket }));
      await exec(
        'docker',
        ['cp', join(root, 'database.dump'), `${resources.postgresContainer}:/tmp/restore.dump`],
        { windowsHide: true },
      );
      await exec(
        'docker',
        [
          'exec',
          resources.postgresContainer,
          'pg_restore',
          '-U',
          'tradeflow',
          '-d',
          targetName,
          '--exit-on-error',
          '--no-owner',
          '--no-acl',
          '/tmp/restore.dump',
        ],
        { windowsHide: true },
      );
      const restoredEnv = { ...environment, DATABASE_URL: targetUrl.toString(), S3_BUCKET: bucket };
      const imported = await tool(['import', join(root, 'objects')], restoredEnv);
      expect(JSON.parse(imported.stdout)).toEqual({ versions: 2, problems: [], orphans: [] });
      await expect(tool(['import', join(root, 'objects')], restoredEnv)).rejects.toThrow(); // no overwrite
      const restoredConfig = loadConfig(restoredEnv);
      targetDb = new PrismaService(restoredConfig);
      restoredApp = await createTestApp({ config: restoredConfig });
      for (let i = 0; i < bytes.length; i++) {
        const answer = await request(restoredApp.server)
          .get(`${s.path}/${i + 1}/content`)
          .set('Cookie', s.buyerCookie)
          .buffer(true)
          .parse(binary)
          .expect(200);
        expect(checksum(answer.body as Buffer)).toBe(checksum(bytes[i] ?? Buffer.alloc(0)));
      }
      expect(await targetDb.auditEvent.count()).toBe(await ctx.prisma.auditEvent.count());
      // Tampered backup is refused in another empty prefix before its first write.
      const manifest = JSON.parse(
        await readFile(join(root, 'objects', 'manifest.json'), 'utf8'),
      ) as { storageKey: string }[];
      await writeFile(join(root, 'objects', manifest[0]?.storageKey ?? ''), 'tampered');
      await expect(
        tool(['import', join(root, 'objects')], { ...restoredEnv, S3_PREFIX: 'tampered/' }),
      ).rejects.toThrow();
    } finally {
      await restoredApp?.app.close();
      await targetDb?.$disconnect();
      // This database's random name is generated above, on this run's owned PostgreSQL only.
      await ctx.prisma.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${targetName}" WITH (FORCE)`);
      await rm(root, { recursive: true, force: true });
    }
  });
});
