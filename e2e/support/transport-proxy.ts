import http from 'node:http';

/*
 * CONTROLLED TRANSPORT FAULT INJECTION.
 *
 * The run's web server forwards `/api` to this proxy, which forwards it to the API untouched:
 *
 *   browser ──▶ web server (Vite preview, same-origin /api proxy) ──▶ this proxy ──▶ Nest API
 *
 * Everything passes through byte for byte, until a test arms a fault for one voyage's event
 * stream (`GET /api/voyages/:voyageId/events`). The faults act on the transport only:
 *
 * - refuse: answer the next stream requests with 503 itself, as an unavailable server would,
 *   without reaching the API;
 * - hold: keep the next stream requests waiting, unanswered, until the test releases them;
 * - drop: end the voyage's open streams, as a server or network closing them would.
 *
 * The proxy never writes a stream message, never answers a request with data of its own (only
 * the refusal), and never reads or logs cookies or other headers. Tests control it over
 * `/__transport/…`, which the web server does not forward, so the browser cannot reach it.
 */

const EVENT_STREAM = /^\/api\/voyages\/([^/?]+)\/events(?:\?|$)/;
const CONTROL = /^\/__transport\/voyages\/([^/?]+)(?:\/(faults|release|drop))?$/;

/** What happened to one voyage's event stream requests so far. */
export interface StreamStats {
  /** Forwarded to the API (including held requests once released). */
  forwarded: number;
  /** Answered 503 by the proxy. */
  refused: number;
  /** Waiting for the test to release them. */
  held: number;
  /** Forwarded and still open. */
  open: number;
}

interface VoyageStreams {
  refuseNext: number;
  holdNext: number;
  forwarded: number;
  refused: number;
  /** Each held request, by the function that forwards it. */
  held: Set<() => void>;
  /** Each open stream, by the function that ends it. */
  open: Set<() => void>;
}

export class TransportProxy {
  private readonly voyages = new Map<string, VoyageStreams>();
  private readonly server = http.createServer((request, response) => {
    this.handle(request, response);
  });

  private constructor(private readonly target: URL) {}

  /** Listens on a free loopback port and forwards to `target`. */
  static async start(target: URL): Promise<TransportProxy> {
    const proxy = new TransportProxy(target);
    await new Promise<void>((resolve, reject) => {
      proxy.server.once('error', reject);
      proxy.server.listen(0, '127.0.0.1', resolve);
    });
    return proxy;
  }

  /** Where the web server's `/api` proxy should send requests. */
  get url(): string {
    const address = this.server.address();
    if (!address || typeof address !== 'object') throw new Error('The proxy is not listening');
    return `http://127.0.0.1:${address.port}`;
  }

  async close(): Promise<void> {
    for (const streams of this.voyages.values()) {
      streams.held.clear();
      for (const end of [...streams.open]) end();
    }
    this.server.closeAllConnections();
    await new Promise<void>((resolve) => {
      this.server.close(() => {
        resolve();
      });
    });
  }

  private streamsOf(voyageId: string): VoyageStreams {
    let streams = this.voyages.get(voyageId);
    if (!streams) {
      streams = {
        refuseNext: 0,
        holdNext: 0,
        forwarded: 0,
        refused: 0,
        held: new Set(),
        open: new Set(),
      };
      this.voyages.set(voyageId, streams);
    }
    return streams;
  }

  private handle(request: http.IncomingMessage, response: http.ServerResponse): void {
    const path = request.url ?? '/';
    const control = CONTROL.exec(path);
    if (control) {
      void this.control(request, response, decodeURIComponent(control[1] ?? ''), control[2]);
      return;
    }
    const stream = request.method === 'GET' ? EVENT_STREAM.exec(path) : null;
    if (!stream) {
      this.forward(request, response);
      return;
    }

    const streams = this.streamsOf(decodeURIComponent(stream[1] ?? ''));
    if (streams.refuseNext > 0) {
      streams.refuseNext -= 1;
      streams.refused += 1;
      refuse(request, response);
      return;
    }
    const open = () => {
      streams.forwarded += 1;
      const end = this.forward(request, response);
      streams.open.add(end);
      response.once('close', () => streams.open.delete(end));
    };
    if (streams.holdNext > 0) {
      streams.holdNext -= 1;
      const release = () => {
        streams.held.delete(release);
        open();
      };
      streams.held.add(release);
      // The browser or the web server gave up waiting: nothing is left to release.
      response.once('close', () => streams.held.delete(release));
      return;
    }
    open();
  }

  /** Forwards the request to the API as it is. Returns a function that ends it cleanly. */
  private forward(request: http.IncomingMessage, response: http.ServerResponse): () => void {
    let ending = false;
    let incoming: http.IncomingMessage | undefined;
    const upstream = http.request({
      hostname: this.target.hostname,
      port: this.target.port,
      method: request.method,
      path: request.url,
      headers: request.headers,
    });
    upstream.on('response', (answer) => {
      incoming = answer;
      response.writeHead(answer.statusCode ?? 502, answer.headers);
      answer.on('error', () => {
        if (!ending) response.destroy();
      });
      answer.pipe(response);
    });
    upstream.on('error', () => {
      if (ending) return;
      if (response.headersSent) response.destroy();
      else response.writeHead(502).end();
    });
    response.on('close', () => {
      if (!response.writableFinished) upstream.destroy();
    });
    request.pipe(upstream);
    return () => {
      if (ending) return;
      ending = true;
      incoming?.unpipe(response);
      // A clean end of the response: the web server ends the browser's stream in turn.
      response.end();
      upstream.destroy();
    };
  }

  private async control(
    request: http.IncomingMessage,
    response: http.ServerResponse,
    voyageId: string,
    action: string | undefined,
  ): Promise<void> {
    const streams = this.streamsOf(voyageId);
    const body = await readJson(request);
    let answer: unknown;
    if (request.method === 'GET' && action === undefined) {
      answer = stats(streams);
    } else if (request.method === 'POST' && action === 'faults') {
      const { refuse = 0, hold = 0 } = body as { refuse?: number; hold?: number };
      streams.refuseNext += refuse;
      streams.holdNext += hold;
      answer = stats(streams);
    } else if (request.method === 'POST' && action === 'release') {
      const held = [...streams.held];
      for (const release of held) release();
      answer = { released: held.length };
    } else if (request.method === 'POST' && action === 'drop') {
      const open = [...streams.open];
      for (const end of open) end();
      answer = { dropped: open.length };
    } else {
      response.writeHead(404).end();
      return;
    }
    response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(answer));
  }
}

function stats(streams: VoyageStreams): StreamStats {
  return {
    forwarded: streams.forwarded,
    refused: streams.refused,
    held: streams.held.size,
    open: streams.open.size,
  };
}

/** The injected 503, labelled as such in a header and in its Problem Details. */
function refuse(request: http.IncomingMessage, response: http.ServerResponse): void {
  request.resume();
  response
    .writeHead(503, {
      'content-type': 'application/problem+json',
      'cache-control': 'no-store',
      'x-e2e-fault': 'refused',
    })
    .end(
      JSON.stringify({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'Refused by the E2E transport proxy (injected fault).',
      }),
    );
}

async function readJson(request: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as unknown);
}
