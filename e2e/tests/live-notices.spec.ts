import {
  expectVoyagePage,
  issueNotice,
  noticeItem,
  signIn,
  timelineEntry,
  voyagePath,
} from '../support/app.js';
import { expect, test } from '../support/fixtures.js';
import {
  expectNotPolling,
  expectRefreshCausedBy,
  waitForMessage,
  waitForRefresh,
  waitUntilLive,
} from '../support/live-updates.js';

test('a notice and its acknowledgement reach the other side over the event stream', async ({
  newContext,
  newTab,
  scenario,
}) => {
  const { voyage, seller, buyer } = scenario;
  // Two people on two machines: separate contexts, separate cookie jars.
  const sellerTab = await newTab(await newContext());
  const buyerTab = await newTab(await newContext());
  for (const [tab, party] of [
    [sellerTab, seller],
    [buyerTab, buyer],
  ] as const) {
    // The page's own clock, so a test can move its timers on (see expectNotPolling).
    await tab.page.clock.install();
    await tab.page.goto(voyagePath(scenario));
    await signIn(tab.page, party);
    await expectVoyagePage(tab.page, scenario, party);
    await waitUntilLive(tab.network, voyage.id);
  }
  await expect(buyerTab.page.getByText('No notices under your contracts yet.')).toBeVisible();

  // The seller issues; the buyer's page shows it without being touched.
  const message = `Arriving early, berth confirmed (${voyage.reference})`;
  const buyerQuiet = await expectNotPolling(buyerTab.page, buyerTab.network, voyage.id);
  const sellerBeforeIssue = sellerTab.network.mark();
  await issueNotice(sellerTab.page, scenario, message);

  const issued = await waitForMessage(buyerTab.network, voyage.id, 'NOTICE_ISSUED', {
    after: buyerQuiet,
  });
  const buyerNotice = noticeItem(buyerTab.page, message);
  await expect(buyerNotice).toBeVisible();
  await expect(buyerNotice).toContainText('Awaiting acknowledgement');
  await expect(buyerNotice).toContainText('Sent to you');
  await expect(timelineEntry(buyerTab.page, 'Issued a notice')).toContainText(seller.fullName);
  expectRefreshCausedBy(buyerTab.network, voyage.id, { quiet: buyerQuiet, signal: issued });

  // The seller's own page is told too; let it settle before the buyer acts.
  const sellerIssued = await waitForMessage(sellerTab.network, voyage.id, 'NOTICE_ISSUED', {
    after: sellerBeforeIssue,
  });
  await waitForRefresh(sellerTab.network, voyage.id, sellerIssued.seq);
  const sellerNotice = noticeItem(sellerTab.page, message);
  await expect(sellerNotice).toContainText('Awaiting acknowledgement');

  // The buyer acknowledges; the seller's page shows who did, without being touched.
  const sellerQuiet = await expectNotPolling(sellerTab.page, sellerTab.network, voyage.id);
  await buyerNotice.getByRole('button', { name: 'Acknowledge receipt' }).click();
  await expect(buyerNotice).toContainText('Acknowledged');

  const acknowledged = await waitForMessage(sellerTab.network, voyage.id, 'NOTICE_ACKNOWLEDGED', {
    after: sellerQuiet,
  });
  await expect(sellerNotice).toContainText(`by ${buyer.fullName} (${buyer.organizationName})`);
  await expect(sellerNotice).not.toContainText('Awaiting acknowledgement');
  await expect(timelineEntry(sellerTab.page, 'Acknowledged receipt of a notice')).toContainText(
    buyer.fullName,
  );
  expectRefreshCausedBy(sellerTab.network, voyage.id, {
    quiet: sellerQuiet,
    signal: acknowledged,
  });
});
