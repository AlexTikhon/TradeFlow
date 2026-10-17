import { expect, type Page } from '@playwright/test';
import {
  type BrowserNetwork,
  type MessageEntry,
  messageType,
  type RequestEntry,
} from './browser-network.js';

/*
 * Reading a voyage page's live updates off its browser's network record. The page keeps two
 * queries fresh from the stream, the notices and the timeline: it refetches both on every stream
 * message, and polls them only while no stream is live (every 30 s).
 */

const eventsPath = (voyageId: string) => `/api/voyages/${voyageId}/events`;

/** A GET of one of the queries the stream keeps fresh. */
function liveQuery(voyageId: string, request: RequestEntry): 'notices' | 'timeline' | undefined {
  if (request.method !== 'GET') return undefined;
  const base = `/api/voyages/${voyageId}`;
  if (request.path === `${base}/notices`) return 'notices';
  if (request.path === `${base}/timeline` || request.path.startsWith(`${base}/timeline?`)) {
    return 'timeline';
  }
  return undefined;
}

/** The web app's fallback poll interval while no stream is live (`FALLBACK_POLL_INTERVAL_MS`). */
const FALLBACK_POLL_INTERVAL_MS = 30_000;

/**
 * Asserts that the page is not polling, and returns a position to use as a quiet point.
 *
 * The page's clock (installed with `page.clock.install()` before it loaded; time flows normally
 * otherwise) is moved past the fallback poll interval, which fires every timer due by then: a
 * poll that was still scheduled would send its requests now. A request sent afterwards (a
 * health check) marks how far the browser's log must reach before nothing more can come from
 * those timers: requests are reported in the order the page sends them.
 */
export async function expectNotPolling(
  page: Page,
  network: BrowserNetwork,
  voyageId: string,
): Promise<number> {
  const before = network.mark();
  await page.clock.runFor(FALLBACK_POLL_INTERVAL_MS + 1_000);
  await page.evaluate(async () => {
    await fetch('/api/health');
  });
  const barrier = await network.waitFor('request', (request) => request.path === '/api/health', {
    after: before,
    description: 'the health check sent after the clock moved',
  });
  expect(
    liveQueriesSent(network, voyageId, { after: before, before: barrier.seq }),
    `nothing polled when the page's timers moved past ${FALLBACK_POLL_INTERVAL_MS} ms\n${network.describe()}`,
  ).toEqual([]);
  return network.mark();
}

/** Waits until the browser has received a stream message of `type` on the voyage's stream. */
export function waitForMessage(
  network: BrowserNetwork,
  voyageId: string,
  type: string,
  { after = 0, timeoutMs }: { after?: number; timeoutMs?: number } = {},
): Promise<MessageEntry> {
  return network.waitFor(
    'message',
    (message) =>
      messageType(message) === type && network.requestOf(message.id).path === eventsPath(voyageId),
    {
      after,
      ...(timeoutMs !== undefined && { timeoutMs }),
      description: `a ${type} message on the stream of voyage ${voyageId}`,
    },
  );
}

/** Waits until a refetch of the notices and of the timeline, both sent after `after`, finished. */
export async function waitForRefresh(network: BrowserNetwork, voyageId: string, after: number) {
  await Promise.all(
    (['notices', 'timeline'] as const).map((query) =>
      network.waitFor(
        'finished',
        (finished) => {
          const request = network.requestOf(finished.id);
          return request.seq > after && liveQuery(voyageId, request) === query;
        },
        { after, description: `a refetch of the ${query} sent after #${after}` },
      ),
    ),
  );
}

/**
 * Waits until the page is live: its stream said READY (after `after`) and the refetch READY
 * starts has finished. Returns the READY message.
 */
export async function waitUntilLive(
  network: BrowserNetwork,
  voyageId: string,
  { after = 0, timeoutMs }: { after?: number; timeoutMs?: number } = {},
): Promise<MessageEntry> {
  const ready = await waitForMessage(network, voyageId, 'READY', {
    after,
    ...(timeoutMs !== undefined && { timeoutMs }),
  });
  await waitForRefresh(network, voyageId, ready.seq);
  return ready;
}

/** The live-query refetches the browser sent between two positions, by query. */
export function liveQueriesSent(
  network: BrowserNetwork,
  voyageId: string,
  { after, before = Infinity }: { after: number; before?: number },
): string[] {
  return network
    .entries('request', { after, before })
    .flatMap((request) => liveQuery(voyageId, request) ?? []);
}

/**
 * Asserts that `signal`, a message the browser received, is what refreshed the page after
 * `quiet` (a position taken while the page was live and idle, by `expectNotPolling`):
 *
 * - the stream that carried it was open since before `quiet` and still is, and no other stream
 *   connection was made meanwhile, so the page was live throughout and polling was off;
 * - no refetch of the notices or the timeline was in flight at `quiet`, and none was sent
 *   between `quiet` and the message;
 * - both were refetched after it.
 */
export function expectRefreshCausedBy(
  network: BrowserNetwork,
  voyageId: string,
  { quiet, signal }: { quiet: number; signal: MessageEntry },
): void {
  const log = `\nBrowser network log:\n${network.describe()}`;
  const ended = new Set(
    [...network.entries('finished'), ...network.entries('failed')]
      .filter((entry) => entry.seq <= quiet)
      .map((entry) => entry.id),
  );
  expect(
    network
      .entries('request', { before: quiet + 1 })
      .filter((request) => liveQuery(voyageId, request) && !ended.has(request.id))
      .map((request) => request.path),
    `no refetch in flight at #${quiet}${log}`,
  ).toEqual([]);
  const stream = network.stream(signal.id);
  expect(stream.request.seq, `the signal's stream was open before #${quiet}${log}`).toBeLessThan(
    quiet,
  );
  expect(stream.ended, `the signal's stream is still open${log}`).toBeUndefined();
  expect(
    network.streams(voyageId).filter((other) => other.request.seq > quiet),
    `no other stream connection since #${quiet}${log}`,
  ).toEqual([]);
  expect(
    liveQueriesSent(network, voyageId, { after: quiet, before: signal.seq }),
    `nothing refetched between #${quiet} and the signal #${signal.seq}${log}`,
  ).toEqual([]);
  expect(
    [...new Set(liveQueriesSent(network, voyageId, { after: signal.seq }))].sort(),
    `notices and timeline refetched after the signal #${signal.seq}${log}`,
  ).toEqual(['notices', 'timeline']);
}
