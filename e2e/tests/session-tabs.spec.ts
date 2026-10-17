import type { StreamRecord } from '../support/browser-network.js';
import { expectSignedOut, expectVoyagePage, signIn, signOut, voyagePath } from '../support/app.js';
import { expect, type Tab, test } from '../support/fixtures.js';
import { waitUntilLive } from '../support/live-updates.js';

/** The tab's stream that has said READY most recently. */
function liveStream(tab: Tab, voyageId: string): StreamRecord {
  const ready = tab.network.streams(voyageId).filter((stream) => stream.messages.length > 0);
  const latest = ready.at(-1);
  if (!latest) throw new Error(`No live stream:\n${tab.network.describe()}`);
  return latest;
}

/** Waits until the browser reports that `stream` ended: the page closed it. */
async function expectClosed(tab: Tab, stream: StreamRecord) {
  const ended = await tab.network.waitFor('failed', (entry) => entry.id === stream.request.id, {
    description: `the end of stream ${stream.request.id}`,
  });
  // Cancelled by the page (EventSource.close()), not dropped by the network or the server.
  expect(ended.canceled).toBe(true);
}

test('two tabs of one browser sign out and back in together, and replace their streams', async ({
  newContext,
  newTab,
  scenario,
  transport,
}) => {
  const { voyage, seller, buyer } = scenario;
  // One browser profile, two tabs: one cookie jar, so one session for both.
  const context = await newContext();
  const first = await newTab(context);
  const second = await newTab(context);
  const openStreams = async () => (await transport.stats(voyage.id)).open;

  await first.page.goto(voyagePath(scenario));
  await signIn(first.page, seller);
  await expectVoyagePage(first.page, scenario, seller);
  await second.page.goto(voyagePath(scenario));
  await expectVoyagePage(second.page, scenario, seller);
  for (const tab of [first, second]) await waitUntilLive(tab.network, voyage.id);
  const sellerStreams = [liveStream(first, voyage.id), liveStream(second, voyage.id)] as const;
  await expect.poll(openStreams).toBe(2);

  // 1. Sign out in the first tab: both tabs leave, and both streams close.
  await signOut(first.page);
  await expectSignedOut(first.page, scenario);
  await expectSignedOut(second.page, scenario);
  await expectClosed(first, sellerStreams[0]);
  await expectClosed(second, sellerStreams[1]);
  // The API's side of both streams is gone too.
  await expect.poll(openStreams).toBe(0);

  // 2. The same user signs back in from the first tab. The second tab follows on its own, back
  // to the voyage it was showing, with a new stream for the new session.
  const beforeSameUser = [first.network.mark(), second.network.mark()] as const;
  await signIn(first.page, seller);
  await expect(first.page).toHaveURL(/\/voyages$/);
  await expectVoyagePage(second.page, scenario, seller);
  await first.page.getByRole('link', { name: voyage.reference }).click();
  await expectVoyagePage(first.page, scenario, seller);
  await waitUntilLive(first.network, voyage.id, { after: beforeSameUser[0] });
  await waitUntilLive(second.network, voyage.id, { after: beforeSameUser[1] });
  const sameUserStreams = [liveStream(first, voyage.id), liveStream(second, voyage.id)] as const;
  sameUserStreams.forEach((stream, index) => {
    expect(stream.request.id).not.toBe(sellerStreams[index]?.request.id);
    expect(stream.ended).toBeUndefined();
  });
  await expect.poll(openStreams).toBe(2);

  // 3. The second tab signs out and someone else signs in there. The first tab follows to the
  // other identity: the seller's name and the seller's actions are gone from it.
  await signOut(second.page);
  await expectSignedOut(first.page, scenario);
  await expectSignedOut(second.page, scenario);
  await expectClosed(first, sameUserStreams[0]);
  await expectClosed(second, sameUserStreams[1]);
  await expect.poll(openStreams).toBe(0);

  const beforeBuyer = first.network.mark();
  await signIn(second.page, buyer);
  await expect(second.page).toHaveURL(/\/voyages$/);
  await expectVoyagePage(first.page, scenario, buyer);
  await expect(first.page.getByText(seller.fullName, { exact: true })).toHaveCount(0);
  await expect(first.page.getByRole('button', { name: 'Issue ETA notice' })).toHaveCount(0);
  await waitUntilLive(first.network, voyage.id, { after: beforeBuyer });
  expect(liveStream(first, voyage.id).request.id).not.toBe(sameUserStreams[0].request.id);
  // Only the first tab shows the voyage now; the second is on the voyage list.
  await expect.poll(openStreams).toBe(1);
});
