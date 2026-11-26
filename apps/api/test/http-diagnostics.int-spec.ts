import { randomBytes } from 'node:crypto';
import { get, type IncomingHttpHeaders, request as httpRequest } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { ProblemDetailsSchema } from '@tradeflow/contracts';
import request from 'supertest';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { HttpRequestRecord } from '../src/common/http/http-diagnostics.js';
import { loadConfig } from '../src/config/app-config.js';
import { SessionPrincipals } from '../src/modules/auth/session-principals.js';
import { VoyageEventStreams } from '../src/modules/voyages/voyage-event-streams.js';
import { signIn } from './support/auth.js';
import {
  createOrganization,
  createReferenceData,
  createTradeString,
  createUser,
  createVoyage,
  resetDatabase,
  TEST_PASSWORD,
} from './support/database.js';
import { DiagnosticsProbeModule, PROBE_FAILURE_CANARY } from './support/diagnostics-probe.js';
import { type EventStream, openEventStream } from './support/event-stream.js';
import { TestStorage } from './support/storage.js';
import { createTestApp, type TestApp } from './support/test-app.js';

/*
 * HTTP diagnostics through the real pipeline: the application module, middleware, guards, pipes,
 * filter, downloads and event streams, over real connections, with the lifecycle records caught
 * by an injected sink. Every record is checked against the schema, and none may contain any of
 * the synthetic secrets sent in headers, query strings, bodies, file names and errors.
 */

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const RECORD_KEYS = [
  'timestamp',
  'level',
  'event',
  'requestId',
  'method',
  'route',
  'status',
  'durationMs',
  'outcome',
  'error',
];
const EVENTS_ROUTE = '/api/voyages/:voyageId/events';
const CONTENT_ROUTE =
  '/api/voyages/:voyageId/contracts/:contractId/documentary-instructions/revisions/' +
  ':revisionNumber/documents/:documentType/versions/:versionNumber/content';

/** Synthetic secrets; each must never appear in any record. */
const CANARY = {
  header: 'canary-header-0c8f',
  bearer: 'canary-bearer-91aa',
  cookie: 'canary-cookie-77d2',
  spoofedId: 'canary-spoofed-request-id-3e19',
  query: 'canary-query-ab52',
  path: 'canary-path-5d0e',
  password: 'canary-password-c4e7',
  body: 'canary-body-28fb',
  fileName: 'canary-file-name-e6a3',
  storage: 'canary-storage-error-1f94',
  stream: 'canary-stream-error-9b07',
  probe: PROBE_FAILURE_CANARY,
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function until(condition: () => boolean, what: string, timeoutMs = 3_000) {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) throw new Error(`${what} within ${timeoutMs} ms`);
    await sleep(10);
  }
}

/** A sink that keeps every line, for the whole suite. */
function captureSink() {
  const lines: string[] = [];
  return {
    lines,
    write: (line: string) => {
      lines.push(line);
    },
  };
}

describe('HTTP diagnostics', () => {
  let ctx: TestApp;
  let storage: TestStorage;
  const sink = captureSink();
  /** Real secrets of this run (session tokens), added as they are made. */
  const realSecrets: string[] = [TEST_PASSWORD];
  const streamOptions = { recheckIntervalMs: 60_000, maxPendingContracts: 32 };
  const opened: EventStream[] = [];
  const http = () => request(ctx.server);

  const records = () => sink.lines.map((line) => JSON.parse(line) as HttpRequestRecord);
  const recordsOf = (requestId: string) =>
    records().filter((record) => record.requestId === requestId);

  /**
   * The one record of `requestId`. It can be written just after the client has the response
   * (`finish` follows the last write), so it is waited for; then a later duplicate (a `close`
   * after `finish`, say) is given time to show up.
   */
  async function recordOf(requestId: string | undefined): Promise<HttpRequestRecord> {
    expect(requestId).toMatch(UUID);
    const id = requestId ?? '';
    await until(() => recordsOf(id).length > 0, `No record of ${id}`);
    await sleep(30);
    const found = recordsOf(id);
    expect(found).toHaveLength(1);
    return found[0] as HttpRequestRecord;
  }

  const idOf = (headers: IncomingHttpHeaders) => headers['x-request-id'] as string | undefined;

  beforeAll(async () => {
    storage = await TestStorage.create();
    ctx = await createTestApp({
      storage,
      eventStreams: streamOptions,
      diagnosticsSink: sink,
      imports: [DiagnosticsProbeModule],
      config: { ...loadConfig(process.env), httpRequestLog: true },
    });
    await new Promise<void>((resolve) => ctx.server.listen(0, '127.0.0.1', resolve));
  });

  afterAll(async () => {
    await ctx.app.close();
    await storage.dispose();
  });

  beforeEach(async () => {
    streamOptions.recheckIntervalMs = 60_000;
    await resetDatabase(ctx.prisma);
    await storage.clear();
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    storage.reset();
    for (const stream of opened.splice(0)) stream.close();
    await until(() => ctx.app.get(VoyageEventStreams).size === 0, 'Streams still open');
  });

  /** A port the suite's server listens on, for raw connections. */
  const port = () => (ctx.server.address() as AddressInfo).port;

  /** A signed-in user of a new organization; its session token is a secret of this run. */
  async function aUser(organizationId?: string, role: 'OPERATOR' | 'VIEWER' = 'OPERATOR') {
    const organization = organizationId ?? (await createOrganization(ctx.prisma, 'Org')).id;
    const user = await createUser(ctx.prisma, organization, { role });
    const cookie = await signIn(ctx.server, user.email);
    realSecrets.push(cookie.slice(cookie.indexOf('=') + 1));
    return { organizationId: organization, user, cookie };
  }

  describe('request ids and lifecycle records', () => {
    it('returns a fresh id and writes one completed record, leaving the body as it was', async () => {
      const first = await http().get('/api/health/live').expect(200);
      const second = await http().get('/api/health/live').expect(200);
      expect(first.body).toEqual({ status: 'ok' });
      expect(idOf(first.headers)).not.toBe(idOf(second.headers));
      const record = await recordOf(idOf(first.headers));
      expect(record).toEqual({
        timestamp: expect.stringMatching(/Z$/) as string,
        level: 'info',
        event: 'http.request',
        requestId: idOf(first.headers),
        method: 'GET',
        route: '/api/health/live',
        status: 200,
        durationMs: expect.any(Number) as number,
        outcome: 'completed',
      });
      expect(record.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('ignores a caller-supplied request id', async () => {
      const response = await http()
        .get('/api/health/live')
        .set('X-Request-ID', CANARY.spoofedId)
        .expect(200);
      expect(idOf(response.headers)).toMatch(UUID);
      expect(idOf(response.headers)).not.toBe(CANARY.spoofedId);
      await recordOf(idOf(response.headers));
    });

    it('records a guard rejection with its route template, and none of the credentials', async () => {
      const response = await http()
        .get(`/api/auth/me?token=${CANARY.query}`)
        .set('Authorization', `Bearer ${CANARY.bearer}`)
        .set('Cookie', `tradeflow_session=${CANARY.cookie}`)
        .set('X-Api-Key', CANARY.header)
        .expect(401);
      expect(ProblemDetailsSchema.parse(response.body).instance).toBe(
        `/api/auth/me?token=${CANARY.query}`,
      );
      expect(await recordOf(idOf(response.headers))).toMatchObject({
        level: 'info',
        method: 'GET',
        route: '/api/auth/me',
        status: 401,
        outcome: 'completed',
      });
    });

    it('records validation rejections without the values that were refused', async () => {
      const { cookie } = await aUser();
      const badId = await http()
        .get(`/api/voyages/${CANARY.path}?q=${CANARY.query}`)
        .set('Cookie', cookie)
        .expect(400);
      expect(await recordOf(idOf(badId.headers))).toMatchObject({
        route: '/api/voyages/:voyageId',
        status: 400,
        outcome: 'completed',
      });
      const badBody = await http()
        .post('/api/auth/sign-in')
        .send({ email: CANARY.body, password: CANARY.password })
        .expect(400);
      expect(await recordOf(idOf(badBody.headers))).toMatchObject({
        method: 'POST',
        route: '/api/auth/sign-in',
        status: 400,
      });
      const malformed = await http()
        .post('/api/auth/sign-in')
        .set('Content-Type', 'application/json')
        .send(`{"password":"${CANARY.password}"`);
      expect(malformed.status).toBe(400);
      expect(await recordOf(idOf(malformed.headers))).toMatchObject({ status: 400 });
    });

    it('records unmatched paths as unmatched', async () => {
      for (const path of [
        `/api/no-such-route/${CANARY.path}?secret=${CANARY.query}`,
        `/outside-the-api/${CANARY.path}`,
      ]) {
        const response = await http().get(path).expect(404);
        expect(await recordOf(idOf(response.headers))).toMatchObject({
          route: 'unmatched',
          status: 404,
          outcome: 'completed',
        });
      }
    });

    it('describes a 5xx by bounded fields, keeping the generic answer', async () => {
      const response = await http().get('/api/test-probe/failure').expect(500);
      expect(response.body).toEqual({
        type: 'about:blank',
        title: 'Internal Server Error',
        status: 500,
        detail: 'An unexpected error occurred.',
        instance: '/api/test-probe/failure',
      });
      const record = await recordOf(idOf(response.headers));
      expect(record).toMatchObject({
        level: 'error',
        route: '/api/test-probe/failure',
        status: 500,
        outcome: 'completed',
        error: { source: 'exception', name: 'ProbeFailure', code: 'EPROBE' },
      });
      expect(record.error?.frames?.length).toBeGreaterThan(0);
    });

    it('keeps concurrent requests’ contexts apart, through awaits and body parsing', async () => {
      const responses = await Promise.all(
        Array.from({ length: 40 }, (_, index) =>
          index % 2
            ? http().get(`/api/test-probe/context?delay=${String(40 - index)}`)
            : http()
                .post('/api/test-probe/context')
                .send({ delay: 40 - index, note: CANARY.body }),
        ),
      );
      const ids = responses.map(({ headers }) => idOf(headers));
      expect(new Set(ids).size).toBe(40);
      for (const response of responses) {
        expect(response.status).toBeLessThan(300);
        // The handler saw its own request's context, whatever ran in between.
        expect((response.body as { requestId: string }).requestId).toBe(idOf(response.headers));
        expect(await recordOf(idOf(response.headers))).toMatchObject({
          route: '/api/test-probe/context',
          outcome: 'completed',
        });
      }
    });

    it('records a client that leaves before the answer as aborted, once', async () => {
      const id = await new Promise<string | undefined>((resolve, reject) => {
        const call = httpRequest({
          host: '127.0.0.1',
          port: port(),
          path: '/api/test-probe/slow?delay=300',
        });
        call.on('error', () => undefined);
        call.end();
        // No response headers yet, so the id is not known to the client: find the record.
        setTimeout(() => {
          call.destroy();
          resolve(undefined);
        }, 50);
        call.on('response', () => {
          reject(new Error('Answered too early'));
        });
      });
      expect(id).toBeUndefined();
      await until(
        () => records().some((record) => record.route === '/api/test-probe/slow'),
        'No record of the aborted request',
      );
      await sleep(400);
      const aborted = records().filter((record) => record.route === '/api/test-probe/slow');
      expect(aborted).toEqual([
        expect.objectContaining({ level: 'warn', status: null, outcome: 'aborted' }),
      ]);
    });
  });

  describe('downloads', () => {
    /** Seller and buyer under one contract, the buyer's instructions given, one PDF uploaded. */
    async function aDocument() {
      const refs = await createReferenceData(ctx.prisma);
      const seller = await aUser();
      const buyer = await aUser();
      const voyage = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-DIAG',
        participants: [
          { organizationId: seller.organizationId, role: 'EXPORTER' },
          { organizationId: buyer.organizationId, role: 'FINAL_BUYER' },
        ],
      });
      await createTradeString(ctx.prisma, voyage.id, [seller.organizationId, buyer.organizationId]);
      const contract = await ctx.prisma.tradeContract.findFirstOrThrow({
        where: { voyageId: voyage.id },
      });
      const base = `/api/voyages/${voyage.id}/contracts/${contract.id}/documentary-instructions`;
      await http()
        .put(base)
        .set('Cookie', buyer.cookie)
        .set('If-None-Match', '*')
        .send({
          consignee: 'To order',
          requirements: [{ document: 'BILL_OF_LADING', originals: 3, copies: 1 }],
        })
        .expect(201);
      const bytes = Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(256 * 1024)]);
      const versions = `${base}/revisions/1/documents/BILL_OF_LADING/versions`;
      const upload = await http()
        .post(versions)
        .set('Cookie', seller.cookie)
        .set('If-None-Match', '*')
        .attach('file', bytes, {
          filename: `${CANARY.fileName}.pdf`,
          contentType: 'application/pdf',
        })
        .expect(201);
      expect(await recordOf(idOf(upload.headers))).toMatchObject({ method: 'POST', status: 201 });
      return { buyer, bytes, content: `${versions}/1/content` };
    }

    /** A raw download: the status, headers and every byte received before the connection ended. */
    const rawDownload = (path: string, cookie: string) =>
      new Promise<{ status: number; headers: IncomingHttpHeaders; bytes: Buffer }>((resolve) => {
        get({ host: '127.0.0.1', port: port(), path, headers: { Cookie: cookie } }, (answer) => {
          const chunks: Buffer[] = [];
          const done = () => {
            resolve({
              status: answer.statusCode ?? 0,
              headers: answer.headers,
              bytes: Buffer.concat(chunks),
            });
          };
          answer.on('data', (chunk: Buffer) => chunks.push(chunk));
          answer.on('error', () => undefined);
          answer.on('close', done);
        }).on('error', () => {
          // The connection ended before any response headers arrived.
          resolve({ status: 0, headers: {}, bytes: Buffer.alloc(0) });
        });
      });

    it('streams a download and records it under its route template', async () => {
      const { buyer, bytes, content } = await aDocument();
      const answer = await rawDownload(content, buyer.cookie);
      expect(answer.status).toBe(200);
      expect(answer.bytes.equals(bytes)).toBe(true);
      expect(answer.headers['content-disposition']).toContain(CANARY.fileName);
      expect(await recordOf(idOf(answer.headers))).toMatchObject({
        route: CONTENT_ROUTE,
        status: 200,
        outcome: 'completed',
      });
    });

    it('records unreadable bytes as a 500 before the first byte, and a cut-off stream after it', async () => {
      const { buyer, content } = await aDocument();
      const failure = () => Object.assign(new Error(CANARY.stream), { code: 'EIO' });
      /** Fails at once, or once its first bytes have had time to reach the client. */
      const failing = (afterFirstChunk: boolean) => {
        let sent = false;
        return new Readable({
          read() {
            if (!afterFirstChunk) {
              this.destroy(failure());
            } else if (!sent) {
              sent = true;
              this.push(Buffer.from('%PDF-1.7\n'));
              setTimeout(() => this.destroy(failure()), 100);
            }
          },
        });
      };
      // A download reads the object twice: once to verify its checksum, then the bytes it serves.
      const realRead = storage.read.bind(storage);
      const read = vi.spyOn(storage, 'read');
      const serving = (stream: Readable) =>
        read.mockImplementationOnce(realRead).mockResolvedValueOnce(stream);

      serving(failing(false));
      const early = await rawDownload(content, buyer.cookie);
      expect(early.status).toBe(500);
      expect(ProblemDetailsSchema.parse(JSON.parse(early.bytes.toString())).detail).toBe(
        'An unexpected error occurred.',
      );
      expect(await recordOf(idOf(early.headers))).toMatchObject({
        level: 'error',
        status: 500,
        outcome: 'completed',
        error: { source: 'download_stream', name: 'Error', code: 'EIO' },
      });

      serving(failing(true));
      const late = await rawDownload(content, buyer.cookie);
      expect(late.status).toBe(200);
      expect(late.bytes.length).toBeLessThan(Number(late.headers['content-length']));
      expect(await recordOf(idOf(late.headers))).toMatchObject({
        level: 'error',
        status: 200,
        outcome: 'stream_failed',
        error: { source: 'download_stream', name: 'Error', code: 'EIO' },
      });

      storage.failNext('read');
      const unreadable = await http().get(content).set('Cookie', buyer.cookie).expect(500);
      expect(await recordOf(idOf(unreadable.headers))).toMatchObject({
        status: 500,
        error: { source: 'exception', name: 'Error' },
      });
    });

    it('records a client that leaves mid-download as aborted', async () => {
      const { buyer, content } = await aDocument();
      const id = await new Promise<string | undefined>((resolve) => {
        const call = get(
          { host: '127.0.0.1', port: port(), path: content, headers: { Cookie: buyer.cookie } },
          (answer) => {
            answer.once('data', () => {
              call.destroy();
              resolve(idOf(answer.headers));
            });
            answer.on('error', () => undefined);
          },
        );
        call.on('error', () => undefined);
      });
      expect(await recordOf(id)).toMatchObject({
        level: 'warn',
        status: 200,
        outcome: 'aborted',
      });
      expect((await recordOf(id)).error).toBeUndefined();
    });
  });

  describe('event streams', () => {
    async function aVoyage() {
      const refs = await createReferenceData(ctx.prisma);
      const first = await aUser(undefined, 'VIEWER');
      const second = await aUser(undefined, 'VIEWER');
      const voyage = await createVoyage(ctx.prisma, refs, {
        reference: 'TF-SSE',
        participants: [
          { organizationId: first.organizationId, role: 'EXPORTER' },
          { organizationId: second.organizationId, role: 'FINAL_BUYER' },
        ],
      });
      return { voyage, first, second };
    }

    async function listen(cookie: string, voyageId: string) {
      const stream = await openEventStream(ctx.server, `/api/voyages/${voyageId}/events`, cookie);
      opened.push(stream);
      expect(stream.status).toBe(200);
      expect(await stream.next()).toEqual({ type: 'READY' });
      return stream;
    }

    it('writes nothing while a stream is open, and one record when the client leaves', async () => {
      const { voyage, first } = await aVoyage();
      const stream = await listen(first.cookie, voyage.id);
      const id = idOf(stream.headers);
      await sleep(50);
      expect(recordsOf(id ?? '')).toEqual([]);
      stream.close();
      expect(await recordOf(id)).toMatchObject({
        route: EVENTS_ROUTE,
        status: 200,
        level: 'warn',
        outcome: 'aborted',
      });
    });

    it('records a stream the server ends normally as completed', async () => {
      streamOptions.recheckIntervalMs = 50;
      const { voyage, first } = await aVoyage();
      const stream = await listen(first.cookie, voyage.id);
      await http().post('/api/auth/sign-out').set('Cookie', first.cookie).expect(204);
      await stream.ended;
      expect(await recordOf(idOf(stream.headers))).toMatchObject({
        status: 200,
        level: 'info',
        outcome: 'completed',
      });
    });

    it('attributes a failed check to the stream it ended, not to the request that started rechecks', async () => {
      streamOptions.recheckIntervalMs = 50;
      const { voyage, first, second } = await aVoyage();
      // The first stream starts the shared recheck timer, inside its own request.
      const starter = await listen(first.cookie, voyage.id);
      const failing = await listen(second.cookie, voyage.id);
      const sessions = ctx.app.get(SessionPrincipals);
      const refresh = sessions.refresh.bind(sessions);
      const failingToken = second.cookie.slice(second.cookie.indexOf('=') + 1);
      vi.spyOn(sessions, 'refresh').mockImplementation(async (principal) => {
        if (principal.userId === second.user.id) {
          throw Object.assign(new Error(`${CANARY.storage} ${failingToken}`), {
            code: 'ECONNRESET',
          });
        }
        return refresh(principal);
      });

      await failing.ended;
      expect(await recordOf(idOf(failing.headers))).toMatchObject({
        route: EVENTS_ROUTE,
        status: 200,
        level: 'error',
        outcome: 'stream_failed',
        error: { source: 'event_stream', name: 'Error', code: 'ECONNRESET' },
      });
      expect(starter.isEnded()).toBe(false);
      expect(recordsOf(idOf(starter.headers) ?? '')).toEqual([]);
      starter.close();
      expect(await recordOf(idOf(starter.headers))).toMatchObject({ outcome: 'aborted' });
    });
  });

  describe('when the sink fails or logging is off', () => {
    it('answers exactly as usual when every write to the sink throws', async () => {
      const sink = {
        write: vi.fn(() => {
          throw new Error('sink unavailable');
        }),
      };
      const app = await createTestApp({
        diagnosticsSink: sink,
        imports: [DiagnosticsProbeModule],
        config: { ...loadConfig(process.env), httpRequestLog: true },
      });
      try {
        const ok = await request(app.server).get('/api/health/live').expect(200);
        expect(ok.body).toEqual({ status: 'ok' });
        expect(idOf(ok.headers)).toMatch(UUID);
        await request(app.server).get('/api/auth/me').expect(401);
        const failed = await request(app.server).get('/api/test-probe/failure').expect(500);
        expect(failed.body).toMatchObject({ detail: 'An unexpected error occurred.' });
        await until(() => sink.write.mock.calls.length >= 3, 'Sink not called');
        // Still serving afterwards.
        await request(app.server).get('/api/health/live').expect(200);
      } finally {
        await app.app.close();
      }
    });

    it('still returns request ids, and writes nothing, with HTTP_REQUEST_LOG=disabled', async () => {
      const quiet = captureSink();
      const app = await createTestApp({
        diagnosticsSink: quiet,
        config: { ...loadConfig(process.env), httpRequestLog: false },
      });
      try {
        const response = await request(app.server).get('/api/health/live').expect(200);
        expect(idOf(response.headers)).toMatch(UUID);
        await request(app.server).get('/api/no-such-route').expect(404);
        await sleep(50);
        expect(quiet.lines).toEqual([]);
      } finally {
        await app.app.close();
      }
    });
  });

  describe('every record of the suite', () => {
    it('is one line of JSON with only the documented fields, and no secret', () => {
      expect(sink.lines.length).toBeGreaterThan(50);
      for (const line of sink.lines) {
        expect(line).not.toMatch(/[\r\n]/);
        const record = JSON.parse(line) as Record<string, unknown>;
        for (const key of Object.keys(record)) expect(RECORD_KEYS).toContain(key);
        expect(record.event).toBe('http.request');
        expect(record.requestId).toMatch(UUID);
        expect(['completed', 'aborted', 'stream_failed']).toContain(record.outcome);
        expect(String(record.route)).not.toMatch(/[?=]|[0-9a-f]{8}-[0-9a-f]{4}-/);
      }
      const everything = sink.lines.join('\n');
      for (const secret of [...Object.values(CANARY), ...realSecrets]) {
        expect(everything).not.toContain(secret);
      }
    });
  });
});
