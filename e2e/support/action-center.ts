import { expect, type Page } from '@playwright/test';
import { signIn } from './app.js';
import type { BrowserNetwork } from './browser-network.js';
import type { Tab } from './fixtures.js';
import type { Party } from './scenario.js';

/*
 * The Action Center (ADR 0017) as a person uses it: the queue, its items and the links to their
 * records, and the record's status on the voyage page. The queue reads its first page again
 * every 30 seconds while the page is visible (`QUEUE_REFRESH_INTERVAL_MS`, unchanged for tests):
 * `expectQueuePolled` moves the page's own clock past that interval, so a change made in another
 * browser arrives by the page's normal polling, never by its Refresh button.
 */

/** The web app's interval between reads of the queue on screen (`QUEUE_REFRESH_INTERVAL_MS`). */
const QUEUE_REFRESH_INTERVAL_MS = 30_000;

export const NOTHING_WAITING = 'Nothing is waiting for your organization';

const isQueueRead = (path: string) =>
  path === '/api/action-items' || path.startsWith('/api/action-items?');

/** Opens the Action Center from the main navigation. */
export async function openActionCenter(page: Page): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Action Center' })
    .click();
  await expect(page.getByRole('heading', { name: 'Action Center' })).toBeVisible();
}

/**
 * Signs `party` in on the Action Center, with the page's own clock installed before it loads
 * (see `expectQueuePolled`), and waits for the first page of the queue to be shown.
 */
export async function actionCenterTab(tab: Tab, party: Party): Promise<void> {
  await tab.page.clock.install();
  await tab.page.goto('/actions');
  await signIn(tab.page, party);
  await expect(tab.page.getByRole('heading', { name: 'Action Center' })).toBeVisible();
  await expect(tab.page.getByText(party.fullName, { exact: true })).toBeVisible();
  await expect(
    tab.page.getByText(/^What your organization has to do next.*Updated /),
  ).toBeVisible();
}

/** The queue's items, as loaded so far. */
export const actionItems = (page: Page) =>
  page.getByRole('list', { name: 'Actions' }).getByRole('listitem');

/** What each action shown asks for (its heading), in the queue's order. */
export const actionHeadings = (page: Page) => actionItems(page).getByRole('heading');

/** The one action asking for `heading` that mentions `text`. */
export const actionItem = (page: Page, heading: string, text: string) =>
  actionItems(page)
    .filter({ has: page.getByRole('heading', { name: heading, exact: true }) })
    .filter({ hasText: text });

/** The voyage page's explanation of the record link it was opened with. */
export const linkedRecordStatus = (page: Page) =>
  page.getByRole('status', { name: 'Linked record' });

/**
 * Moves the page's clock past the queue's refresh interval, then waits until the browser has
 * sent a read of the queue's first page and received all of its answer. Returns that request's
 * position in the log, after which the page shows what it read.
 */
export async function expectQueuePolled(tab: Tab): Promise<number> {
  const before = tab.network.mark();
  await tab.page.clock.runFor(QUEUE_REFRESH_INTERVAL_MS + 1_000);
  return firstPageRead(tab, before, "the queue's first page, read again by the page's interval");
}

/**
 * Opens the Action Center from the main navigation and waits until the browser has read the
 * queue's first page and received all of its answer. The queue keeps nothing once left
 * (`gcTime: 0`), so what it shows afterwards is what it read now, never an earlier answer.
 */
export async function openActionCenterAndRead(tab: Tab): Promise<number> {
  const before = tab.network.mark();
  await openActionCenter(tab.page);
  return firstPageRead(tab, before, "the queue's first page, read on opening it");
}

/**
 * Waits until a read of the queue's first page sent after `after` has been answered in full,
 * and returns that read's position. A read cancelled on the way does not count: a command's
 * invalidation replaces a read already in flight (ADR 0017), and the replacement is awaited.
 */
async function firstPageRead(tab: Tab, after: number, description: string): Promise<number> {
  const isFirstPageRead = (id: string) => {
    const request = tab.network.requestOf(id);
    return (
      request.seq > after &&
      request.method === 'GET' &&
      isQueueRead(request.path) &&
      !request.path.includes('cursor=')
    );
  };
  const answered = await tab.network.waitFor('finished', (entry) => isFirstPageRead(entry.id), {
    after,
    description: `${description}, answered in full`,
  });
  return tab.network.requestOf(answered.id).seq;
}

/**
 * Every request the page sent after `after` that is not a read: what navigating to a record
 * must never send.
 */
export const commandsSent = (network: BrowserNetwork, after: number) =>
  network
    .entries('request', { after })
    .filter((request) => request.method !== 'GET')
    .map((request) => `${request.method} ${request.path}`);
