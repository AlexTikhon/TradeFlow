import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { ServerResponse } from 'node:http';
import { performance } from 'node:perf_hooks';

/**
 * Why a request failed, as explicit bounded fields (see `describeFailure`). Never an error's
 * message, properties or cause: those can carry SQL parameters, file names or provider payloads.
 */
export interface RequestFailure {
  /** Where the failure was observed. */
  source: 'exception' | 'download_stream' | 'event_stream';
  /** The error's class name, or a fixed reason for a failure that is not an error. */
  name: string;
  /** A library's machine-readable code (`ECONNREFUSED`, `P2002`, `23505`), when it has one. */
  code?: string;
  /** Up to a few validated stack frames: code locations, never data. */
  frames?: string[];
}

/**
 * One HTTP request's diagnostic identity: a server-generated id, a monotonic start time and the
 * failure the request ended with, if any. Created first thing for every request; never chosen,
 * extended or read from what the client sent.
 */
export class RequestContext {
  /** Opaque, server-generated; returned as `X-Request-ID` and written in every record. */
  readonly requestId: string = randomUUID();
  /** `performance.now()` when the request arrived: durations ignore wall-clock corrections. */
  readonly startedAt: number = performance.now();
  private recordedFailure: RequestFailure | undefined;
  private streamBroken = false;

  /** The first failure noted for this request; later ones are the same failure's echoes. */
  get failure(): RequestFailure | undefined {
    return this.recordedFailure;
  }

  /** Whether a response that had started streaming was cut off by a server-side failure. */
  get streamFailed(): boolean {
    return this.streamBroken;
  }

  /** Records why the request failed. Only the first failure is kept. */
  noteFailure(failure: RequestFailure): void {
    this.recordedFailure ??= failure;
  }

  /** Records that a streamed response (a download, an event stream) was ended by a failure. */
  noteStreamFailure(failure: RequestFailure): void {
    this.noteFailure(failure);
    this.streamBroken = true;
  }
}

/*
 * Two ways to find a request's context, both safe under concurrency (nothing holds a "current
 * request" in shared mutable state):
 *
 * - AsyncLocalStorage follows the request through promises, timers and callbacks started while
 *   it is handled, for code that has no request object.
 * - The response it belongs to, for callbacks whose async context is not the request's: stream
 *   error handlers, and event-stream work driven by timers or by another request's publication.
 */
const storage = new AsyncLocalStorage<RequestContext>();
const byResponse = new WeakMap<ServerResponse, RequestContext>();

/** Runs `next` (the rest of the request's pipeline) with `context` as the current request. */
export function runInRequestContext(
  context: RequestContext,
  response: ServerResponse,
  next: () => void,
): void {
  byResponse.set(response, context);
  storage.run(context, next);
}

/** The context of the request being handled here, if any. */
export function currentRequestContext(): RequestContext | undefined {
  return storage.getStore();
}

/** The context of the request `response` answers, if it went through the pipeline. */
export function requestContextOf(response: ServerResponse): RequestContext | undefined {
  return byResponse.get(response);
}

/**
 * Runs `fn` outside any request: for long-lived work started while one request is handled but
 * serving others (a shared timer, a subscription), which must not carry that request's context.
 */
export function outsideRequestContext<T>(fn: () => T): T {
  return storage.exit(fn);
}
