import { type Locator, type Page } from '@playwright/test';
import {
  actionCenterTab,
  actionHeadings,
  actionItem,
  commandsSent,
  expectQueuePolled,
  linkedRecordStatus,
  NOTHING_WAITING,
  openActionCenter,
} from '../support/action-center.js';
import {
  billOfLading,
  expectVoyagePage,
  giveInstructions,
  instructionRevision,
  issueNotice,
  noticeItem,
  pdf,
  reviewBillOfLading,
  reviseInstructions,
  signIn,
  uploadBillOfLading,
  voyagePath,
} from '../support/app.js';
import { expect, type Tab, test } from '../support/fixtures.js';
import { runConfig } from '../support/run-config.js';
import {
  addSurveyor,
  addViewer,
  createUnconnectedParties,
  type Party,
  type Scenario,
} from '../support/scenario.js';

/*
 * The Action Center (ADR 0017) between the seller and the buyer of the voyage's only contract,
 * each in a browser profile of their own: every transition is made through the voyage page's
 * own forms, and each queue learns of the counterparty's by its normal 30-second polling (the
 * page's clock moved on, see `expectQueuePolled`), never by its Refresh button. Following an
 * item opens its exact record and sends nothing.
 */

/** Signs `party` in on the voyage page. */
async function voyageTab(tab: Tab, scenario: Scenario, party: Party) {
  await tab.page.goto(voyagePath(scenario));
  await signIn(tab.page, party);
  await expectVoyagePage(tab.page, scenario, party);
}

/** The container of the record the page was opened for: there is at most one. */
const linkedRecord = (page: Page) => page.locator('#linked-record');

/** Focus is on `record`, which is in the viewport and clear of the sticky app bar. */
async function expectFocusedInView(page: Page, record: Locator) {
  await expect(record).toBeFocused();
  await expect(record).toBeInViewport();
  const header = await page.getByRole('banner').boundingBox();
  const box = await record.boundingBox();
  expect(header).not.toBeNull();
  expect(box).not.toBeNull();
  if (header && box) expect(box.y).toBeGreaterThanOrEqual(header.y + header.height);
}

/** The page is no wider than its viewport: nothing scrolls sideways. */
async function expectNoHorizontalOverflow(page: Page) {
  const { scrollWidth, clientWidth } = await page.evaluate(() => ({
    scrollWidth: document.documentElement.scrollWidth,
    clientWidth: document.documentElement.clientWidth,
  }));
  expect(scrollWidth).toBeLessThanOrEqual(clientWidth);
}

const openLink = (item: Locator, label: string, scenario: Scenario) =>
  item.getByRole('link', { name: `${label} on ${scenario.voyage.reference}, contract 1` });

test('instructions and a rejected, replaced and approved bill of lading run from queue to record on both sides', async ({
  newContext,
  newTab,
  scenario,
}) => {
  test.setTimeout(150_000);
  const { voyage, seller, buyer } = scenario;
  const sellerTab = await newTab(await newContext());
  const buyerTab = await newTab(await newContext());
  const { page: sellerPage } = sellerTab;
  const { page: buyerPage } = buyerTab;
  const reason = `The consignee does not match the instructions (${voyage.reference}).`;

  await actionCenterTab(sellerTab, seller);
  await actionCenterTab(buyerTab, buyer);
  await expect(sellerPage.getByText(NOTHING_WAITING)).toBeVisible();
  await expect(buyerPage.getByText(NOTHING_WAITING)).toBeVisible();

  // The buyer gives instructions; the seller's queue, polling, now asks for an acknowledgement.
  await buyerPage.goto(voyagePath(scenario));
  await expectVoyagePage(buyerPage, scenario, buyer);
  await giveInstructions(buyerPage, scenario, `To order of Banco ${voyage.reference}`);
  await openActionCenter(buyerPage);
  await expect(buyerPage.getByText(NOTHING_WAITING)).toBeVisible();

  await expectQueuePolled(sellerTab);
  await expect(actionHeadings(sellerPage)).toHaveText(['Acknowledge instructions']);
  const instructions = actionItem(sellerPage, 'Acknowledge instructions', voyage.reference);
  await expect(instructions).toContainText(`${buyer.organizationName} · Contract 1`);
  await expect(instructions).toContainText('Revision 1');

  // The seller follows it to the exact revision, acknowledges it and uploads version 1.
  let sellerOpened = sellerTab.network.mark();
  await openLink(instructions, 'Open revision 1', scenario).click();
  await expect(linkedRecordStatus(sellerPage)).toContainText(
    'Revision 1 is waiting for your organization to acknowledge receipt',
  );
  await expectFocusedInView(sellerPage, instructionRevision(sellerPage, 1));
  expect(commandsSent(sellerTab.network, sellerOpened)).toEqual([]);

  await sellerPage.getByRole('button', { name: 'Acknowledge receipt of revision 1' }).click();
  await expect(instructionRevision(sellerPage, 1)).toContainText('Acknowledged by the seller');
  await expect(linkedRecordStatus(sellerPage)).toContainText(
    'Revision 1 has already been acknowledged',
  );
  const first = { name: `bill-of-lading-${voyage.reference}.pdf`, buffer: pdf() };
  await uploadBillOfLading(sellerPage, first, 1);
  await openActionCenter(sellerPage);
  await expect(sellerPage.getByText(NOTHING_WAITING)).toBeVisible();

  // The buyer's queue, polling, asks for a decision on version 1; the link opens exactly it.
  await expectQueuePolled(buyerTab);
  await expect(actionHeadings(buyerPage)).toHaveText(['Review document']);
  const review = actionItem(buyerPage, 'Review document', 'version 1');
  await expect(review).toContainText(`${seller.organizationName} · Contract 1`);
  await expect(review).toContainText('Bill of lading, version 1 (instructions revision 1)');

  let buyerOpened = buyerTab.network.mark();
  await openLink(review, 'Open version 1', scenario).click();
  await expect(linkedRecordStatus(buyerPage)).toContainText(
    'Version 1 of the bill of lading is waiting for your organization’s decision',
  );
  await expectFocusedInView(
    buyerPage,
    billOfLading(buyerPage).getByRole('group', { name: 'Version 1 of the bill of lading' }),
  );
  // Opening it chose nothing: the decision is the buyer's to make in the form.
  const firstReview = buyerPage.getByRole('form', {
    name: 'Review version 1 of the bill of lading',
  });
  await expect(firstReview.getByLabel('Approve', { exact: true })).not.toBeChecked();
  await expect(firstReview.getByLabel('Reject', { exact: true })).not.toBeChecked();
  expect(commandsSent(buyerTab.network, buyerOpened)).toEqual([]);

  await reviewBillOfLading(buyerPage, 1, reason);
  await openActionCenter(buyerPage);
  await expect(buyerPage.getByText(NOTHING_WAITING)).toBeVisible();

  // The seller's queue now asks for a replacement, with the buyer's reason.
  await expectQueuePolled(sellerTab);
  await expect(actionHeadings(sellerPage)).toHaveText(['Replace rejected document']);
  const replacement = actionItem(sellerPage, 'Replace rejected document', 'version 1');
  await expect(replacement).toContainText(reason);
  await expect(replacement).toContainText(`${buyer.organizationName} · Contract 1`);

  sellerOpened = sellerTab.network.mark();
  await openLink(replacement, 'Open version 1', scenario).click();
  await expect(linkedRecordStatus(sellerPage)).toContainText(
    'Version 1 of the bill of lading was rejected and is waiting for your organization to replace it',
  );
  await expectFocusedInView(
    sellerPage,
    billOfLading(sellerPage).getByRole('group', { name: 'Version 1 of the bill of lading' }),
  );
  expect(commandsSent(sellerTab.network, sellerOpened)).toEqual([]);
  const second = { name: `bill-of-lading-${voyage.reference}-v2.pdf`, buffer: pdf() };
  await uploadBillOfLading(sellerPage, second, 2);
  await openActionCenter(sellerPage);
  await expect(sellerPage.getByText(NOTHING_WAITING)).toBeVisible();

  // The buyer's queue asks for a decision on version 2, a new action; the buyer approves it.
  await expectQueuePolled(buyerTab);
  await expect(actionHeadings(buyerPage)).toHaveText(['Review document']);
  const secondReview = actionItem(buyerPage, 'Review document', 'version 2');
  await expect(secondReview).toContainText('Bill of lading, version 2 (instructions revision 1)');

  buyerOpened = buyerTab.network.mark();
  await openLink(secondReview, 'Open version 2', scenario).click();
  await expect(linkedRecordStatus(buyerPage)).toContainText(
    'Version 2 of the bill of lading is waiting for your organization’s decision',
  );
  await expectFocusedInView(
    buyerPage,
    billOfLading(buyerPage).getByRole('group', { name: 'Version 2 of the bill of lading' }),
  );
  expect(commandsSent(buyerTab.network, buyerOpened)).toEqual([]);
  await reviewBillOfLading(buyerPage, 2);
  await expect(linkedRecordStatus(buyerPage)).toContainText(
    'Version 2 of the bill of lading has already been approved',
  );

  // An approved latest file is owed by no one.
  await openActionCenter(buyerPage);
  await expect(buyerPage.getByText(NOTHING_WAITING)).toBeVisible();
  await expectQueuePolled(sellerTab);
  await expect(sellerPage.getByText(NOTHING_WAITING)).toBeVisible();
});

test('an ETA notice is acknowledged from the buyer’s Action Center', async ({
  newContext,
  newTab,
  scenario,
}) => {
  const { voyage, seller, buyer } = scenario;
  const sellerTab = await newTab(await newContext());
  const buyerTab = await newTab(await newContext());
  const { page: buyerPage } = buyerTab;
  const message = `Arriving early, berth confirmed (${voyage.reference})`;

  await actionCenterTab(buyerTab, buyer);
  await expect(buyerPage.getByText(NOTHING_WAITING)).toBeVisible();
  await voyageTab(sellerTab, scenario, seller);
  await issueNotice(sellerTab.page, scenario, message);

  await expectQueuePolled(buyerTab);
  await expect(actionHeadings(buyerPage)).toHaveText(['Acknowledge ETA notice']);
  const action = actionItem(buyerPage, 'Acknowledge ETA notice', voyage.reference);
  await expect(action).toContainText(`${seller.organizationName} · Contract 1`);
  await expect(action).toContainText('Acknowledge by');

  const opened = buyerTab.network.mark();
  await openLink(action, 'Open ETA notice', scenario).click();
  await expect(linkedRecordStatus(buyerPage)).toContainText(
    'This ETA notice is waiting for your organization to acknowledge receipt',
  );
  const notice = noticeItem(buyerPage, message);
  await expectFocusedInView(buyerPage, notice);
  expect(commandsSent(buyerTab.network, opened)).toEqual([]);

  await notice.getByRole('button', { name: 'Acknowledge receipt' }).click();
  await expect(notice).toContainText('Acknowledged');
  await expect(linkedRecordStatus(buyerPage)).toContainText(
    'This ETA notice has already been acknowledged',
  );
  await openActionCenter(buyerPage);
  await expect(buyerPage.getByText(NOTHING_WAITING)).toBeVisible();
});

test('an old file-version link opens that version as history, focused, and decides nothing', async ({
  newContext,
  newTab,
  scenario,
}) => {
  test.setTimeout(120_000);
  const { voyage, seller, buyer } = scenario;
  const sellerTab = await newTab(await newContext());
  const buyerTab = await newTab(await newContext());
  const { page: buyerPage } = buyerTab;
  const { page: sellerPage } = sellerTab;

  await voyageTab(buyerTab, scenario, buyer);
  await giveInstructions(buyerPage, scenario, `To order of Banco ${voyage.reference}`);
  await voyageTab(sellerTab, scenario, seller);
  const first = { name: `bill-of-lading-${voyage.reference}.pdf`, buffer: pdf() };
  await uploadBillOfLading(sellerPage, first, 1);

  // The buyer keeps the link to version 1; the seller replaces it before any decision.
  await openActionCenter(buyerPage);
  const oldLink = await openLink(
    actionItem(buyerPage, 'Review document', 'version 1'),
    'Open version 1',
    scenario,
  ).getAttribute('href');
  expect(oldLink).not.toBeNull();
  const second = { name: `bill-of-lading-${voyage.reference}-v2.pdf`, buffer: pdf() };
  await sellerPage.reload();
  await uploadBillOfLading(sellerPage, second, 2);

  // The old link: version 1, as history, shown and focused; the decision stays on version 2.
  let opened = buyerTab.network.mark();
  await buyerPage.goto(oldLink ?? '');
  const status = linkedRecordStatus(buyerPage);
  await expect(status).toContainText('Version 1 of the bill of lading has been replaced');
  await expect(status).toContainText('A decision or a replacement applies only to version 2.');
  const earlierVersions = buyerPage.getByRole('list', {
    name: 'Earlier versions of the bill of lading',
  });
  const version1 = earlierVersions.getByRole('group', { name: 'Version 1 of the bill of lading' });
  await expect(version1).toContainText(first.name);
  await expectFocusedInView(buyerPage, version1);
  await expect(linkedRecord(buyerPage)).toHaveCount(1);
  await expect(
    buyerPage.getByRole('form', { name: 'Review version 1 of the bill of lading' }),
  ).toHaveCount(0);
  const latestReview = buyerPage.getByRole('form', {
    name: 'Review version 2 of the bill of lading',
  });
  await expect(latestReview.getByLabel('Approve', { exact: true })).not.toBeChecked();
  await expect(latestReview.getByLabel('Reject', { exact: true })).not.toBeChecked();
  await expect(latestReview).not.toContainText(first.name);

  // Folded by the user, it is hidden; "Show it" opens its history again and focuses it.
  const versionsToggle = billOfLading(buyerPage).getByRole('button', {
    name: 'Earlier versions (1)',
  });
  await versionsToggle.click();
  await expect(versionsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(version1).toBeHidden();
  await status.getByRole('button', { name: 'Show it' }).click();
  await expect(versionsToggle).toHaveAttribute('aria-expanded', 'true');
  await expectFocusedInView(buyerPage, version1);
  expect(commandsSent(buyerTab.network, opened)).toEqual([]);

  // A new revision supersedes revision 1: the same link now lies under two folded histories.
  await reviseInstructions(buyerPage, scenario, `To order of Banco Novo ${voyage.reference}`, 2);
  opened = buyerTab.network.mark();
  await buyerPage.goto(oldLink ?? '');
  await expect(status).toContainText('Revision 1 has been superseded');
  const revisionsToggle = buyerPage.getByRole('button', { name: 'Earlier revisions (1)' });
  const nestedToggle = buyerPage.getByRole('button', { name: 'Earlier versions (1)' });
  const historical = buyerPage.getByRole('group', { name: 'Version 1 of the bill of lading' });
  await expect(revisionsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(nestedToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(historical).toContainText(first.name);
  await expectFocusedInView(buyerPage, historical);
  await expect(
    buyerPage.getByRole('form', { name: /^Review version \d+ of the bill of lading$/ }),
  ).toHaveCount(0);

  await nestedToggle.click();
  await revisionsToggle.click();
  await expect(revisionsToggle).toHaveAttribute('aria-expanded', 'false');
  await expect(historical).toBeHidden();
  await status.getByRole('button', { name: 'Show it' }).click();
  await expect(revisionsToggle).toHaveAttribute('aria-expanded', 'true');
  await expect(nestedToggle).toHaveAttribute('aria-expanded', 'true');
  await expectFocusedInView(buyerPage, historical);
  expect(commandsSent(buyerTab.network, opened)).toEqual([]);

  // On a phone-sized screen, the same link lands the same way, with nothing scrolling sideways.
  await buyerPage.setViewportSize({ width: 390, height: 844 });
  opened = buyerTab.network.mark();
  await buyerPage.reload();
  await expect(status).toContainText('Revision 1 has been superseded');
  await expectFocusedInView(buyerPage, historical);
  await expectNoHorizontalOverflow(buyerPage);
  // Version 2 lies under the superseded revision too, so no decision is owed on it any more.
  await openActionCenter(buyerPage);
  await expect(buyerPage.getByText(NOTHING_WAITING)).toBeVisible();
  await expectNoHorizontalOverflow(buyerPage);
  expect(commandsSent(buyerTab.network, opened)).toEqual([]);
});

test('a viewer reads the queue and opens records with no command; other organizations see none of it', async ({
  database,
  newContext,
  newTab,
  scenario,
}) => {
  test.setTimeout(120_000);
  const { voyage, seller, buyer } = scenario;
  const { passwordHash } = runConfig();
  const viewer = await addViewer(database, passwordHash, buyer);
  const surveyor = await addSurveyor(database, passwordHash, scenario);
  const { buyer: outsider } = await createUnconnectedParties(database, passwordHash);
  const message = `Arriving early, berth confirmed (${voyage.reference})`;

  // The buyer's organization comes to owe two actions, through the page's forms.
  const buyerTab = await newTab(await newContext());
  await voyageTab(buyerTab, scenario, buyer);
  await giveInstructions(buyerTab.page, scenario, `To order of Banco ${voyage.reference}`);
  const sellerTab = await newTab(await newContext());
  await voyageTab(sellerTab, scenario, seller);
  await issueNotice(sellerTab.page, scenario, message);
  const file = { name: `bill-of-lading-${voyage.reference}.pdf`, buffer: pdf() };
  await uploadBillOfLading(sellerTab.page, file, 1);

  // The buyer's viewer reads that queue, and is told an operator acts.
  const viewerTab = await newTab(await newContext());
  const { page: viewerPage } = viewerTab;
  await actionCenterTab(viewerTab, viewer);
  await expect(actionHeadings(viewerPage)).toHaveText([
    'Acknowledge ETA notice',
    'Review document',
  ]);
  await expect(viewerPage.getByRole('alert')).toContainText(
    'Acting on them is for an operator in your organization.',
  );
  const reviewLink = openLink(
    actionItem(viewerPage, 'Review document', 'version 1'),
    'Open version 1',
    scenario,
  );
  const fileLink = await reviewLink.getAttribute('href');

  // Following either link shows the record, focused, with no command offered or sent.
  let opened = viewerTab.network.mark();
  await reviewLink.click();
  await expect(linkedRecordStatus(viewerPage)).toContainText(
    'Version 1 of the bill of lading is waiting for your organization’s decision',
  );
  await expectFocusedInView(
    viewerPage,
    billOfLading(viewerPage).getByRole('group', { name: 'Version 1 of the bill of lading' }),
  );
  await expect(viewerPage.getByRole('form', { name: /^Review version/ })).toHaveCount(0);
  await expect(viewerPage.getByRole('radio')).toHaveCount(0);
  await expect(viewerPage.getByRole('button', { name: /^Acknowledge receipt/ })).toHaveCount(0);
  await expect(
    viewerPage.getByRole('button', { name: /^(Revise|Give) .*instructions$/ }),
  ).toHaveCount(0);
  expect(commandsSent(viewerTab.network, opened)).toEqual([]);

  await openActionCenter(viewerPage);
  opened = viewerTab.network.mark();
  await openLink(
    actionItem(viewerPage, 'Acknowledge ETA notice', voyage.reference),
    'Open ETA notice',
    scenario,
  ).click();
  const notice = noticeItem(viewerPage, message);
  await expectFocusedInView(viewerPage, notice);
  await expect(notice).toContainText('An operator in your organization can acknowledge receipt.');
  await expect(viewerPage.getByRole('button', { name: /^Acknowledge receipt/ })).toHaveCount(0);
  expect(commandsSent(viewerTab.network, opened)).toEqual([]);

  // The seller's queue holds only the seller's side of the contract.
  await openActionCenter(sellerTab.page);
  await expect(actionHeadings(sellerTab.page)).toHaveText(['Acknowledge instructions']);

  // A surveyor on the voyage, and an organization not on it, see none of the contract's actions.
  for (const [party, onVoyage] of [
    [surveyor, true],
    [outsider, false],
  ] as const) {
    const tab = await newTab(await newContext());
    await actionCenterTab(tab, party);
    await expect(tab.page.getByText(NOTHING_WAITING)).toBeVisible();
    const queue = await tab.page.request.get('/api/action-items');
    expect(queue.status()).toBe(200);
    expect(((await queue.json()) as { items: unknown[] }).items).toEqual([]);

    opened = tab.network.mark();
    await tab.page.goto(fileLink ?? '');
    if (onVoyage) {
      await expect(tab.page.getByRole('heading', { name: voyage.reference })).toBeVisible();
      await expect(linkedRecordStatus(tab.page)).toContainText('The linked record cannot be found');
    } else {
      await expect(tab.page.getByText('Voyage not found')).toBeVisible();
    }
    await expect(linkedRecord(tab.page)).toHaveCount(0);
    await expect(tab.page.getByText(file.name)).toHaveCount(0);
    await expect(tab.page.getByText(message)).toHaveCount(0);
    expect(commandsSent(tab.network, opened)).toEqual([]);
  }
});
