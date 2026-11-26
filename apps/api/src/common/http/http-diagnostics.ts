import type { IncomingMessage, ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';
import { Inject, Injectable, Module, type OnApplicationShutdown } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { StreamSink } from './diagnostics-sink.js';
import { RequestContext, type RequestFailure, runInRequestContext } from './request-context.js';

/*
 * HTTP diagnostics (see docs/architecture.md, "HTTP diagnostics"): a server-generated request id
 * on every response, and one single-line JSON record per request when it ends. Records are built
 * from an allowlist of fields only: never a URL, query string, header, cookie, body, file name or
 * error message.
 */

export const REQUEST_ID_HEADER = 'X-Request-ID';
/** The route of a request no controller route matched (an unknown path, static docs assets). */
export const UNMATCHED_ROUTE = 'unmatched';

/**
 * How a request ended.
 * - `completed`: the whole response was handed to the connection (any status, 5xx included).
 * - `aborted`: the connection closed before the response was complete, and no server-side
 *   failure was noted: the client left (or the connection broke) first.
 * - `stream_failed`: a streamed response (a download, an event stream) was ended early by a
 *   failure on the server.
 */
export type RequestOutcome = 'completed' | 'aborted' | 'stream_failed';

/** The whole schema of a lifecycle record. Nothing else is ever written. */
export interface HttpRequestRecord {
  /** Wall-clock time the request ended, ISO 8601 UTC. */
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  event: 'http.request';
  requestId: string;
  /** A standard method, or `OTHER`. */
  method: string;
  /** The matched route template (`/api/voyages/:voyageId`), or `unmatched`. */
  route: string;
  /** The status sent; null when the connection ended before any response headers were sent. */
  status: number | null;
  /** Milliseconds from arrival to the end, from a monotonic clock, to 0.1 ms. */
  durationMs: number;
  outcome: RequestOutcome;
  /** Why it failed: on 5xx answers and failed streams only. */
  error?: RequestFailure;
}

/**
 * Where serialized records go: one line each, without its line break. Best effort: it may drop a
 * record, and must neither block on its destination nor let the destination's errors escape.
 * The production sink is a `StreamSink` on standard output (diagnostics-sink.ts).
 */
export interface HttpDiagnosticsSink {
  write(line: string): void;
  /** At application shutdown: stop writing. Must not end or destroy a shared stream. */
  close?(): void;
}

export const HTTP_DIAGNOSTICS_SINK = Symbol('HTTP_DIAGNOSTICS_SINK');

const METHODS = new Set(['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']);
/** Route templates as controllers declare them; anything else is not recorded. */
const ROUTE_TEMPLATE = /^\/[\w\-/:.{}*]{0,255}$/;

@Injectable()
export class HttpDiagnostics implements OnApplicationShutdown {
  private readonly enabled: boolean;

  constructor(
    @Inject(APP_CONFIG) config: AppConfig,
    @Inject(HTTP_DIAGNOSTICS_SINK) private readonly sink: HttpDiagnosticsSink,
  ) {
    this.enabled = config.httpRequestLog;
  }

  /** After the HTTP server has closed, so requests that were draining still get their record. */
  onApplicationShutdown(): void {
    this.sink.close?.();
  }

  /**
   * The first middleware of the pipeline: gives the request its context and id before any
   * guard, pipe, body parser, handler or exception filter runs, and watches for its end. A
   * caller's `X-Request-ID` is never read.
   */
  readonly middleware = (
    request: IncomingMessage,
    response: ServerResponse,
    next: () => void,
  ): void => {
    const context = new RequestContext();
    response.setHeader(REQUEST_ID_HEADER, context.requestId);
    if (this.enabled) this.watch(request, response, context);
    runInRequestContext(context, response, next);
  };

  /**
   * Writes exactly one record when the response ends: on `finish` (all of it was handed to the
   * connection) or on `close` (the connection ended), whichever comes first; Node emits `close`
   * after `finish` too. Both listeners are released on the first. A failing sink is ignored:
   * diagnostics never change a request's outcome. One record is built and handed to the sink;
   * whether it reaches the output is the sink's affair (the production sink may drop it).
   */
  private watch(request: IncomingMessage, response: ServerResponse, context: RequestContext) {
    const settle = (finished: boolean) => {
      response.off('finish', onFinish);
      response.off('close', onClose);
      try {
        this.sink.write(JSON.stringify(lifecycleRecord(request, response, context, finished)));
      } catch {
        // Diagnostics are best effort: a record that cannot be written is lost, nothing else.
      }
    };
    const onFinish = () => {
      settle(true);
    };
    const onClose = () => {
      settle(response.writableFinished);
    };
    response.once('finish', onFinish);
    response.once('close', onClose);
  }
}

function lifecycleRecord(
  request: IncomingMessage,
  response: ServerResponse,
  context: RequestContext,
  finished: boolean,
): HttpRequestRecord {
  const outcome: RequestOutcome = context.streamFailed
    ? 'stream_failed'
    : finished
      ? 'completed'
      : 'aborted';
  const status = response.headersSent ? response.statusCode : null;
  const { failure } = context;
  const level =
    failure || outcome === 'stream_failed' || (status ?? 0) >= 500
      ? 'error'
      : outcome === 'aborted'
        ? 'warn'
        : 'info';
  return {
    timestamp: new Date().toISOString(),
    level,
    event: 'http.request',
    requestId: context.requestId,
    method: METHODS.has(request.method ?? '') ? (request.method ?? '') : 'OTHER',
    route: routeTemplate(request),
    status,
    durationMs: Math.round((performance.now() - context.startedAt) * 10) / 10,
    outcome,
    ...(failure && { error: failure }),
  };
}

/** The template of the controller route Express matched (it keeps it on `request.route`). */
function routeTemplate(request: IncomingMessage): string {
  const path = (request as { route?: { path?: unknown } }).route?.path;
  return typeof path === 'string' && ROUTE_TEMPLATE.test(path) ? path : UNMATCHED_ROUTE;
}

@Module({
  providers: [
    // Standard output, for the container runtime; made when the application starts, not on import.
    { provide: HTTP_DIAGNOSTICS_SINK, useFactory: () => new StreamSink(process.stdout) },
    HttpDiagnostics,
  ],
  exports: [HttpDiagnostics],
})
export class HttpDiagnosticsModule {}
