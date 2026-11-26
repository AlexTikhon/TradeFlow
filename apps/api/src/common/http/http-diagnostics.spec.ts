import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { AppConfig } from '../../config/app-config.js';
import {
  HttpDiagnostics,
  type HttpDiagnosticsSink,
  type HttpRequestRecord,
  REQUEST_ID_HEADER,
} from './http-diagnostics.js';
import { currentRequestContext, requestContextOf } from './request-context.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** The parts of a Node response the middleware uses, driven by the test. */
class FakeResponse extends EventEmitter {
  readonly headers = new Map<string, unknown>();
  headersSent = false;
  statusCode = 200;
  writableFinished = false;

  setHeader(name: string, value: unknown) {
    this.headers.set(name.toLowerCase(), value);
    return this;
  }

  /** Headers and every byte handed to the connection: `finish`, then `close`. */
  complete(status = 200) {
    this.statusCode = status;
    this.headersSent = true;
    this.writableFinished = true;
    this.emit('finish');
    this.emit('close');
  }
}

function aRequest(fields: Partial<IncomingMessage> & { route?: unknown } = {}) {
  return { method: 'GET', headers: {}, ...fields } as unknown as IncomingMessage;
}

function setUp({ enabled = true, sink }: { enabled?: boolean; sink?: HttpDiagnosticsSink } = {}) {
  const lines: string[] = [];
  const diagnostics = new HttpDiagnostics(
    { httpRequestLog: enabled } as AppConfig,
    sink ?? { write: (line) => lines.push(line) },
  );
  const records = () => lines.map((line) => JSON.parse(line) as HttpRequestRecord);
  const handle = (request = aRequest(), response = new FakeResponse()) => {
    let inside: ReturnType<typeof currentRequestContext>;
    diagnostics.middleware(request, response as unknown as ServerResponse, () => {
      inside = currentRequestContext();
    });
    return { response, context: inside };
  };
  return { lines, records, handle };
}

const listeners = (response: FakeResponse) =>
  response.listenerCount('finish') + response.listenerCount('close');

describe('HttpDiagnostics middleware', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('gives each request a fresh server-side id, ignoring the caller’s', () => {
    const { handle } = setUp();
    const spoofed = aRequest({ headers: { 'x-request-id': 'chosen-by-the-caller' } });
    const first = handle(spoofed);
    const second = handle(spoofed);
    const firstId = first.response.headers.get(REQUEST_ID_HEADER.toLowerCase());
    expect(firstId).toMatch(UUID);
    expect(firstId).toBe(first.context?.requestId);
    expect(second.response.headers.get(REQUEST_ID_HEADER.toLowerCase())).not.toBe(firstId);
    // The rest of the pipeline runs inside the context, which the response also leads to.
    expect(requestContextOf(first.response as unknown as ServerResponse)).toBe(first.context);
  });

  it('writes one record on finish and releases its listeners, whatever follows', () => {
    const { lines, records, handle } = setUp();
    const { response, context } = handle(aRequest({ route: { path: '/api/voyages/:voyageId' } }));
    expect(listeners(response)).toBe(2);
    response.complete(201);
    expect(listeners(response)).toBe(0);
    response.emit('close');
    expect(lines).toHaveLength(1);
    expect(lines[0]).not.toContain('\n');
    expect(records()[0]).toEqual({
      timestamp: expect.stringMatching(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/) as string,
      level: 'info',
      event: 'http.request',
      requestId: context?.requestId,
      method: 'GET',
      route: '/api/voyages/:voyageId',
      status: 201,
      durationMs: expect.any(Number) as number,
      outcome: 'completed',
    });
  });

  it('records a connection that closes first as aborted, with no status before headers', () => {
    const { records, handle } = setUp();
    const early = handle().response;
    early.emit('close');
    const streaming = handle().response;
    streaming.headersSent = true;
    streaming.emit('close');
    streaming.emit('finish');
    expect(records().map(({ outcome, status, level }) => ({ outcome, status, level }))).toEqual([
      { outcome: 'aborted', status: null, level: 'warn' },
      { outcome: 'aborted', status: 200, level: 'warn' },
    ]);
    expect(listeners(early) + listeners(streaming)).toBe(0);
  });

  it('counts a close that reports the response finished as completed', () => {
    const { records, handle } = setUp();
    const { response } = handle();
    response.headersSent = true;
    response.writableFinished = true;
    response.emit('close');
    response.emit('finish');
    expect(records()).toHaveLength(1);
    expect(records()[0]?.outcome).toBe('completed');
  });

  it('records a noted stream failure as stream_failed, however the response ends', () => {
    const { records, handle } = setUp();
    for (const end of ['finish', 'close'] as const) {
      const { response, context } = handle();
      response.headersSent = true;
      context?.noteStreamFailure({ source: 'download_stream', name: 'Error', code: 'EIO' });
      context?.noteStreamFailure({ source: 'download_stream', name: 'Later' });
      response.emit(end);
    }
    expect(records().map(({ outcome, level, error }) => ({ outcome, level, error }))).toEqual([
      {
        outcome: 'stream_failed',
        level: 'error',
        error: { source: 'download_stream', name: 'Error', code: 'EIO' },
      },
      {
        outcome: 'stream_failed',
        level: 'error',
        error: { source: 'download_stream', name: 'Error', code: 'EIO' },
      },
    ]);
  });

  it('measures duration on the monotonic clock', () => {
    const now = vi.spyOn(performance, 'now').mockReturnValue(1_000);
    const { records, handle } = setUp();
    const { response } = handle();
    now.mockReturnValue(1_234.56);
    response.complete();
    expect(records()[0]?.durationMs).toBe(234.6);
  });

  it('records only route templates and standard methods', () => {
    const { records, handle } = setUp();
    const routes = [
      undefined,
      { path: /^\/api\/.*/ },
      { path: '/api/x\n{"level":"error","event":"forged"}' },
      { path: '/api/voyages?token=secret' },
      { path: ['/api/a', '/api/b'] },
    ];
    for (const route of routes) handle(aRequest({ route })).response.complete();
    handle(aRequest({ method: 'BREW', route: { path: '/api/health' } })).response.complete();
    expect(records().map(({ route, method }) => `${method} ${route}`)).toEqual([
      'GET unmatched',
      'GET unmatched',
      'GET unmatched',
      'GET unmatched',
      'GET unmatched',
      'OTHER /api/health',
    ]);
  });

  it('keeps answering and cleaning up when the sink fails', () => {
    const sink = {
      write: vi.fn(() => {
        throw new Error('disk full');
      }),
    };
    const { handle } = setUp({ sink });
    const { response } = handle();
    expect(() => {
      response.complete(500);
    }).not.toThrow();
    expect(sink.write).toHaveBeenCalledTimes(1);
    expect(listeners(response)).toBe(0);
  });

  it('closes its sink at application shutdown, and copes with a sink that cannot close', () => {
    const sink = { write: vi.fn(), close: vi.fn() };
    new HttpDiagnostics({ httpRequestLog: true } as AppConfig, sink).onApplicationShutdown();
    expect(sink.close).toHaveBeenCalledTimes(1);
    expect(() => {
      new HttpDiagnostics({ httpRequestLog: true } as AppConfig, {
        write: () => undefined,
      }).onApplicationShutdown();
    }).not.toThrow();
  });

  it('still sets the id and context, but writes nothing, when disabled', () => {
    const { lines, handle } = setUp({ enabled: false });
    const { response, context } = handle();
    expect(response.headers.get(REQUEST_ID_HEADER.toLowerCase())).toBe(context?.requestId);
    expect(listeners(response)).toBe(0);
    response.complete();
    expect(lines).toEqual([]);
  });

  it('keeps concurrent requests’ contexts apart across awaits', async () => {
    const { lines } = setUp();
    const diagnostics = new HttpDiagnostics({ httpRequestLog: true } as AppConfig, {
      write: (line) => lines.push(line),
    });
    const seen = await Promise.all(
      Array.from(
        { length: 20 },
        (_, index) =>
          new Promise<[string | undefined, string | undefined]>((resolve) => {
            const response = new FakeResponse();
            diagnostics.middleware(aRequest(), response as unknown as ServerResponse, () => {
              const before = currentRequestContext()?.requestId;
              setTimeout(() => {
                void Promise.resolve().then(() => {
                  resolve([before, currentRequestContext()?.requestId]);
                });
              }, 20 - index);
            });
          }),
      ),
    );
    for (const [before, after] of seen) expect(after).toBe(before);
    expect(new Set(seen.map(([id]) => id)).size).toBe(20);
    expect(currentRequestContext()).toBeUndefined();
  });
});
