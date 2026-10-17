import {
  type ClientRequest,
  get,
  type IncomingHttpHeaders,
  type IncomingMessage,
  type Server,
} from 'node:http';
import type { AddressInfo } from 'node:net';

/*
 * A server-sent-events client over a real HTTP connection, for integration tests. It sends the
 * session cookie as a header, as a browser would for a same-origin EventSource, but it is not a
 * browser: what a real EventSource does with the cookie jar, reconnection and `retry` is not
 * exercised here.
 */

export interface EventStream {
  status: number;
  headers: IncomingHttpHeaders;
  /** The body of a refused stream (Problem Details), parsed; undefined for an open stream. */
  problem: unknown;
  /** Every `data` field received so far, as raw text, in order. */
  readonly data: string[];
  /** Comment lines received so far (heartbeats). */
  readonly comments: string[];
  /** Resolves with the next `data` not yet taken, parsed as JSON. Rejects after `timeoutMs`. */
  next(timeoutMs?: number): Promise<unknown>;
  /** Resolves once at least `count` comments have arrived in total. */
  comment(count: number, timeoutMs?: number): Promise<void>;
  /** Resolves when the server ends the stream (or the connection goes). */
  readonly ended: Promise<void>;
  isEnded(): boolean;
  /** Disconnects, as a client leaving the page would. */
  close(): void;
}

/** Makes `server` listen on an ephemeral port, once; supertest then reuses that port. */
async function listening(server: Server): Promise<AddressInfo> {
  if (!server.listening) {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  }
  return server.address() as AddressInfo;
}

/** Opens `path` as an event stream with `cookie`, and resolves once the headers arrived. */
export async function openEventStream(
  server: Server,
  path: string,
  cookie?: string,
): Promise<EventStream> {
  const { port } = await listening(server);
  const data: string[] = [];
  const comments: string[] = [];
  let taken = 0;
  let ended = false;
  let notify: () => void = () => undefined;
  let changed = new Promise<void>((resolve) => (notify = resolve));
  const signal = () => {
    const resolve = notify;
    changed = new Promise<void>((next) => (notify = next));
    resolve();
  };
  let markEnded: () => void = () => undefined;
  const endedPromise = new Promise<void>((resolve) => (markEnded = resolve));
  const end = () => {
    if (ended) return;
    ended = true;
    markEnded();
    signal();
  };

  let request: ClientRequest | undefined;
  const response = await new Promise<IncomingMessage>((resolve, reject) => {
    request = get(
      {
        host: '127.0.0.1',
        port,
        path,
        headers: { Accept: 'text/event-stream', ...(cookie && { Cookie: cookie }) },
      },
      resolve,
    );
    request.on('error', (error) => {
      if (!ended) reject(error);
    });
  });

  const stream: EventStream = {
    status: response.statusCode ?? 0,
    headers: response.headers,
    problem: undefined,
    data,
    comments,
    ended: endedPromise,
    isEnded: () => ended,
    async next(timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (taken >= data.length) {
        if (ended) throw new Error(`The stream ended; received ${JSON.stringify(data)}`);
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`No event within ${timeoutMs} ms`);
        await Promise.race([changed, sleep(left)]);
      }
      return JSON.parse(data[taken++] ?? '') as unknown;
    },
    async comment(count, timeoutMs = 3_000) {
      const deadline = Date.now() + timeoutMs;
      while (comments.length < count) {
        if (ended) throw new Error('The stream ended');
        const left = deadline - Date.now();
        if (left <= 0) throw new Error(`Fewer than ${count} comments within ${timeoutMs} ms`);
        await Promise.race([changed, sleep(left)]);
      }
    },
    close() {
      request?.destroy();
    },
  };

  response.setEncoding('utf8');
  if (stream.status !== 200) {
    let body = '';
    for await (const chunk of response) body += chunk as string;
    stream.problem = body ? JSON.parse(body) : undefined;
    end();
    return stream;
  }

  let buffer = '';
  response.on('data', (chunk: string) => {
    buffer += chunk;
    let boundary: number;
    while ((boundary = buffer.indexOf('\n\n')) >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) data.push(line.slice('data: '.length));
        else if (line.startsWith(':')) comments.push(line);
      }
    }
    signal();
  });
  response.on('end', end);
  response.on('close', end);
  request?.on('close', end);
  return stream;
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
