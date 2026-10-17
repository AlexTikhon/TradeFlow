import type { Page } from '@playwright/test';

/*
 * What one page's browser did on the network, as Chromium reports it over the DevTools protocol:
 * every `/api` request, its status, each message the browser's own EventSource received, and
 * whether the request finished or failed (a stream closed by the page fails as cancelled).
 * Observation only: nothing is intercepted, changed or faked, and no headers are recorded, so
 * cookies never reach the log.
 *
 * Entries are numbered in the order the browser reported them. That order is what the tests
 * reason about: "this refetch was sent after that stream message".
 */

interface Base {
  /** Position in the order the browser reported events, from 1. */
  seq: number;
  /** The browser's id of the request. */
  id: string;
}

export interface RequestEntry extends Base {
  kind: 'request';
  method: string;
  /** Path and query, e.g. `/api/voyages/…/timeline`. */
  path: string;
  /** Sent by an EventSource (initial connection or the browser's own reconnection). */
  eventSource: boolean;
}

export interface ResponseEntry extends Base {
  kind: 'response';
  status: number;
}

export interface MessageEntry extends Base {
  kind: 'message';
  data: string;
}

export interface FinishedEntry extends Base {
  kind: 'finished';
}

export interface FailedEntry extends Base {
  kind: 'failed';
  canceled: boolean;
}

export type NetworkEntry =
  RequestEntry | ResponseEntry | MessageEntry | FinishedEntry | FailedEntry;

type Kind = NetworkEntry['kind'];
type EntryOf<K extends Kind> = Extract<NetworkEntry, { kind: K }>;

/** An event stream connection: one EventSource request and what came of it. */
export interface StreamRecord {
  request: RequestEntry;
  status: number | undefined;
  messages: MessageEntry[];
  /** When it ended, finished or failed; undefined while open. */
  ended: FinishedEntry | FailedEntry | undefined;
}

interface WaitOptions {
  /** Only entries after this position count (see `mark`). */
  after?: number;
  timeoutMs?: number;
  /** Says what was awaited when the wait times out. */
  description: string;
}

/** The `type` of a stream message, or undefined if it is not one the API sends. */
export function messageType(entry: MessageEntry): string | undefined {
  try {
    const parsed = JSON.parse(entry.data) as { type?: unknown };
    return typeof parsed.type === 'string' ? parsed.type : undefined;
  } catch {
    return undefined;
  }
}

export class BrowserNetwork {
  private readonly log: NetworkEntry[] = [];
  private readonly requests = new Map<string, RequestEntry>();
  private readonly listeners = new Set<() => void>();

  private constructor() {}

  /** Starts recording `page` before it navigates anywhere. */
  static async record(page: Page): Promise<BrowserNetwork> {
    const network = new BrowserNetwork();
    const session = await page.context().newCDPSession(page);
    session.on('Network.requestWillBeSent', ({ requestId, request, type }) => {
      if (network.requests.has(requestId)) return;
      const url = new URL(request.url);
      if (!url.pathname.startsWith('/api/')) return;
      const entry = network.push({
        kind: 'request',
        id: requestId,
        method: request.method,
        path: url.pathname + url.search,
        eventSource: type === 'EventSource',
      });
      network.requests.set(requestId, entry);
    });
    session.on('Network.responseReceived', ({ requestId, response }) => {
      if (network.requests.has(requestId)) {
        network.push({ kind: 'response', id: requestId, status: response.status });
      }
    });
    session.on('Network.eventSourceMessageReceived', ({ requestId, data }) => {
      if (network.requests.has(requestId)) network.push({ kind: 'message', id: requestId, data });
    });
    session.on('Network.loadingFinished', ({ requestId }) => {
      if (network.requests.has(requestId)) network.push({ kind: 'finished', id: requestId });
    });
    session.on('Network.loadingFailed', ({ requestId, canceled }) => {
      if (network.requests.has(requestId)) {
        network.push({ kind: 'failed', id: requestId, canceled: canceled ?? false });
      }
    });
    await session.send('Network.enable');
    return network;
  }

  private push<K extends Kind>(entry: Omit<EntryOf<K>, 'seq'> & { kind: K }): EntryOf<K> {
    const recorded = { ...entry, seq: this.log.length + 1 } as EntryOf<K>;
    this.log.push(recorded);
    for (const listener of [...this.listeners]) listener();
    return recorded;
  }

  /** The position of the latest entry: pass it as `after` to look only at what follows. */
  mark(): number {
    return this.log.length;
  }

  entries<K extends Kind>(kind: K, { after = 0, before = Infinity } = {}): EntryOf<K>[] {
    return this.log.filter(
      (entry): entry is EntryOf<K> =>
        entry.kind === kind && entry.seq > after && entry.seq < before,
    );
  }

  /** The request an entry belongs to, by the entry's `id`. */
  requestOf(id: string): RequestEntry {
    const request = this.requests.get(id);
    if (!request) throw new Error(`No request ${id} was recorded`);
    return request;
  }

  /** Waits for the first entry of `kind` after `after` that `matches`, as the browser reports it. */
  waitFor<K extends Kind>(
    kind: K,
    matches: (entry: EntryOf<K>) => boolean,
    { after = 0, timeoutMs = 15_000, description }: WaitOptions,
  ): Promise<EntryOf<K>> {
    const find = () => this.entries(kind, { after }).find(matches);
    const found = find();
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const listener = () => {
        const entry = find();
        if (!entry) return;
        clearTimeout(timer);
        this.listeners.delete(listener);
        resolve(entry);
      };
      const timer = setTimeout(() => {
        this.listeners.delete(listener);
        reject(
          new Error(
            `Timed out after ${timeoutMs} ms waiting for ${description}.\n${this.describe()}`,
          ),
        );
      }, timeoutMs);
      this.listeners.add(listener);
    });
  }

  /** Every event stream connection of `voyageId`'s, in the order the browser opened them. */
  streams(voyageId: string): StreamRecord[] {
    const path = `/api/voyages/${voyageId}/events`;
    return this.entries('request')
      .filter((request) => request.eventSource && request.path === path)
      .map((request) => this.stream(request.id));
  }

  stream(id: string): StreamRecord {
    const of = <K extends Kind>(kind: K) => this.entries(kind).filter((entry) => entry.id === id);
    return {
      request: this.requestOf(id),
      status: of('response')[0]?.status,
      messages: of('message'),
      ended: [...of('finished'), ...of('failed')][0],
    };
  }

  /** The log as text, for failure messages: methods, paths, statuses and stream messages. */
  describe(): string {
    return this.log
      .map((entry) => {
        switch (entry.kind) {
          case 'request':
            return `#${entry.seq} ${entry.method} ${entry.path}${entry.eventSource ? ' (EventSource)' : ''} [${entry.id}]`;
          case 'response':
            return `#${entry.seq}   ${entry.status} [${entry.id}]`;
          case 'message':
            return `#${entry.seq}   message ${entry.data} [${entry.id}]`;
          case 'finished':
            return `#${entry.seq}   finished [${entry.id}]`;
          case 'failed':
            return `#${entry.seq}   failed${entry.canceled ? ' (cancelled)' : ''} [${entry.id}]`;
        }
      })
      .join('\n');
  }
}
