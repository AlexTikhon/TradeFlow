import type { Page } from '@playwright/test';
import {
  expectVoyagePage,
  issueNotice,
  noticeItem,
  signIn,
  timelineEntry,
  voyagePath,
} from '../support/app.js';
import { expect, type Tab, test } from '../support/fixtures.js';
import {
  expectNotPolling,
  expectRefreshCausedBy,
  liveQueriesSent,
  waitForMessage,
  waitUntilLive,
} from '../support/live-updates.js';
import type { Scenario } from '../support/scenario.js';

/*
 * Every fault in this file is INJECTED by the transport proxy between the web server and the API
 * (support/transport-proxy.ts): a 503 the proxy answers itself, stream requests it holds, and
 * streams it ends. The browser, its EventSource, the session cookie, the API and the data are
 * all real; no stream message is ever written by the test.
 */

async function signedInTab(tab: Tab, scenario: Scenario, as: 'seller' | 'buyer', path: string) {
  await tab.page.goto(path);
  await signIn(tab.page, scenario[as]);
  await expect(tab.page.getByText(scenario[as].fullName, { exact: true })).toBeVisible();
}

interface ProbeEvent {
  type: 'open' | 'message' | 'error';
  readyState: number;
  data?: string;
  at: number;
}

/**
 * Opens the browser's own EventSource on `url` from the page, with the page's cookie, and
 * records what it reports. No application code is involved.
 */
async function openProbe(page: Page, url: string): Promise<void> {
  await page.evaluate((streamUrl) => {
    const events: ProbeEvent[] = [];
    const source = new EventSource(streamUrl);
    const record = (type: ProbeEvent['type'], data?: string) => {
      events.push({
        type,
        readyState: source.readyState,
        at: performance.now(),
        ...(data !== undefined && { data }),
      });
    };
    source.onopen = () => {
      record('open');
    };
    source.onmessage = (event: MessageEvent<string>) => {
      record('message', event.data);
    };
    source.onerror = () => {
      record('error');
    };
    Object.assign(window, { probe: { source, events } });
  }, url);
}

const probeEvents = (page: Page) =>
  page.evaluate(() => (window as unknown as { probe: { events: ProbeEvent[] } }).probe.events);

const closeProbe = (page: Page) =>
  page.evaluate(() => {
    (window as unknown as { probe: { source: EventSource } }).probe.source.close();
  });

test('the browser’s EventSource gives up on a 503 and reconnects by itself after a drop', async ({
  newContext,
  newTab,
  scenario,
  transport,
}) => {
  const tab = await newTab(await newContext());
  // The voyage list: the application opens no stream there, so only the probe streams.
  await signedInTab(tab, scenario, 'buyer', '/voyages');
  const { page } = tab;
  const url = `/api/voyages/${scenario.voyage.id}/events`;

  // INJECTED: the stream request is refused with 503.
  await transport.arm(scenario.voyage.id, { refuse: 1 });
  await openProbe(page, url);
  await expect
    .poll(() => probeEvents(page))
    .toEqual([expect.objectContaining({ type: 'error', readyState: 2 /* CLOSED */ })]);
  // CLOSED, not CONNECTING: the browser has failed the connection and will not reconnect it,
  // which is why the application opens a new one itself after a delay.
  await closeProbe(page);
  expect(await transport.stats(scenario.voyage.id)).toMatchObject({ refused: 1, forwarded: 0 });

  // A real stream, with the cookie the browser attaches to it.
  await openProbe(page, url);
  await expect
    .poll(async () => (await probeEvents(page)).map(({ type, data }) => data ?? type))
    .toEqual(['open', '{"type":"READY"}']);

  // INJECTED: the stream is ended as a closing server or network would end it.
  expect(await transport.drop(scenario.voyage.id)).toBe(1);
  await expect
    .poll(async () => (await probeEvents(page)).map(({ type, data }) => data ?? type), {
      timeout: 20_000,
    })
    .toEqual(['open', '{"type":"READY"}', 'error', 'open', '{"type":"READY"}']);
  const events = await probeEvents(page);
  await closeProbe(page);
  const [, , dropped, reopened] = events;
  // Still CONNECTING when it reports the drop: the browser reconnects by itself, waiting the
  // `retry` the API sent at the start of the stream (5 s), with the cookie again.
  expect(dropped?.readyState).toBe(0);
  expect((reopened?.at ?? 0) - (dropped?.at ?? 0)).toBeGreaterThanOrEqual(4_500);
  expect(await transport.stats(scenario.voyage.id)).toMatchObject({ forwarded: 2, refused: 1 });
});

test('a page catches up on what changed while its stream was down', async ({
  newContext,
  newTab,
  scenario,
  transport,
}) => {
  const { voyage } = scenario;
  const buyer = await newTab(await newContext());
  const seller = await newTab(await newContext());
  await signedInTab(buyer, scenario, 'buyer', voyagePath(scenario));
  await expectVoyagePage(buyer.page, scenario, scenario.buyer);
  await waitUntilLive(buyer.network, voyage.id);
  const firstStream = buyer.network.streams(voyage.id).at(-1);

  // INJECTED: the buyer's stream ends, and the browser's reconnection is held at the proxy.
  await transport.arm(voyage.id, { hold: 1 });
  const dropped = buyer.network.mark();
  expect(await transport.drop(voyage.id)).toBe(1);
  await buyer.network.waitFor('finished', (entry) => entry.id === firstStream?.request.id, {
    description: 'the end of the dropped stream',
  });
  await expect
    .poll(async () => (await transport.stats(voyage.id)).held, { timeout: 20_000 })
    .toBe(1);

  // Meanwhile the seller issues a notice. Nothing tells the buyer's page.
  const message = `Issued while the buyer was disconnected (${voyage.reference})`;
  await signedInTab(seller, scenario, 'seller', voyagePath(scenario));
  await expectVoyagePage(seller.page, scenario, scenario.seller);
  await issueNotice(seller.page, scenario, message);
  await expect(noticeItem(buyer.page, message)).toHaveCount(0);

  // The reconnection goes through; its READY makes the page read again.
  expect(await transport.release(voyage.id)).toBe(1);
  const ready = await waitUntilLive(buyer.network, voyage.id, { after: dropped });
  await expect(noticeItem(buyer.page, message)).toBeVisible();
  await expect(timelineEntry(buyer.page, 'Issued a notice')).toBeVisible();
  // Caught up by the reconnection, not by polling: nothing was read while it was down.
  expect(liveQueriesSent(buyer.network, voyage.id, { after: dropped, before: ready.seq })).toEqual(
    [],
  );
  // The browser reconnected by itself, on a new request.
  const streams = buyer.network.streams(voyage.id);
  expect(streams).toHaveLength(2);
  expect(streams[1]?.request.id).not.toBe(firstStream?.request.id);
});

test('a page whose first stream is refused with 503 connects again and catches up', async ({
  newContext,
  newTab,
  scenario,
  transport,
}) => {
  const { voyage } = scenario;
  // INJECTED: the first stream request is refused with 503, and the next is held.
  await transport.arm(voyage.id, { refuse: 1, hold: 1 });
  const buyer = await newTab(await newContext());
  const seller = await newTab(await newContext());
  await buyer.page.clock.install();
  await signedInTab(buyer, scenario, 'buyer', voyagePath(scenario));
  await expectVoyagePage(buyer.page, scenario, scenario.buyer);
  await expect(buyer.page.getByText('No notices under your contracts yet.')).toBeVisible();

  const refused = await buyer.network.waitFor(
    'response',
    (response) => response.status === 503 && buyer.network.requestOf(response.id).eventSource,
    { description: 'the refused stream' },
  );
  // The browser gave up on that stream; the page connects again by itself, after a delay.
  await expect
    .poll(async () => (await transport.stats(voyage.id)).held, { timeout: 20_000 })
    .toBe(1);
  const quiet = buyer.network.mark();

  const message = `Issued before the buyer's stream was up (${voyage.reference})`;
  await signedInTab(seller, scenario, 'seller', voyagePath(scenario));
  await expectVoyagePage(seller.page, scenario, scenario.seller);
  await issueNotice(seller.page, scenario, message);
  await expect(noticeItem(buyer.page, message)).toHaveCount(0);

  expect(await transport.release(voyage.id)).toBe(1);
  const ready = await waitUntilLive(buyer.network, voyage.id, { after: refused.seq });
  await expect(noticeItem(buyer.page, message)).toBeVisible();
  await expect(timelineEntry(buyer.page, 'Issued a notice')).toBeVisible();
  expect(liveQueriesSent(buyer.network, voyage.id, { after: quiet, before: ready.seq })).toEqual(
    [],
  );
  // Two stream requests in all: the refused one and the page's new connection.
  const streams = buyer.network.streams(voyage.id);
  expect(streams.map(({ status }) => status)).toEqual([503, 200]);
  // At the proxy: that refusal, then the buyer's stream and the seller's, both open.
  expect(await transport.stats(voyage.id)).toMatchObject({ refused: 1, forwarded: 2, open: 2 });

  // And it is live: the next change arrives as a signal.
  const live = await expectNotPolling(buyer.page, buyer.network, voyage.id);
  const next = `Issued once the buyer's stream was up (${voyage.reference})`;
  await issueNotice(seller.page, scenario, next);
  const signal = await waitForMessage(buyer.network, voyage.id, 'NOTICE_ISSUED', { after: live });
  await expect(noticeItem(buyer.page, next)).toBeVisible();
  expectRefreshCausedBy(buyer.network, voyage.id, { quiet: live, signal });
});
