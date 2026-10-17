import { createHash, randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import {
  billOfLading,
  giveInstructions,
  reviewBillOfLading,
  timelineEntry,
  uploadBillOfLading,
} from '../support/app.js';
import type { BrowserNetwork } from '../support/browser-network.js';
import { expect, test } from '../support/fixtures.js';
import {
  expectNotPolling,
  expectRefreshCausedBy,
  liveTab,
  settle,
  waitForMessage,
} from '../support/live-updates.js';

/*
 * Documents between the seller and the buyer of the voyage's only contract, each in a browser
 * profile of their own: real PDF uploads through the page's form, real downloads through the
 * browser, real decisions. Every stream message is sent by the real API after a real command
 * committed; the test only waits for what the browser reports.
 */

const REVISED = 'DOCUMENTARY_INSTRUCTION_REVISED';
const UPLOADED = 'DOCUMENT_VERSION_UPLOADED';
const REVIEWED = 'DOCUMENT_VERSION_REVIEWED';

/** Bytes that start like a PDF, different every time. */
const pdf = () => Buffer.concat([Buffer.from('%PDF-1.7\n'), randomBytes(24 * 1024)]);
const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

/**
 * What the page sent after `after` other than reads: writes, and downloads. A stream message
 * must cause neither.
 */
const writesAndDownloads = (network: BrowserNetwork, after: number) =>
  network
    .entries('request', { after })
    .filter((request) => request.method !== 'GET' || request.path.endsWith('/content'))
    .map((request) => `${request.method} ${request.path}`);

test('a document, its review, a replacement and a rejection reach the other side over the event stream', async ({
  newContext,
  newTab,
  scenario,
}) => {
  const { voyage, seller, buyer } = scenario;
  const sellerTab = await newTab(await newContext());
  const buyerTab = await newTab(await newContext());
  await liveTab(sellerTab, scenario, seller);
  await liveTab(buyerTab, scenario, buyer);
  const sellerItem = billOfLading(sellerTab.page);
  const buyerItem = billOfLading(buyerTab.page);

  // The buyer's instructions require a bill of lading; both pages settle on them.
  const sellerBeforeGive = sellerTab.network.mark();
  const buyerBeforeGive = buyerTab.network.mark();
  await giveInstructions(buyerTab.page, scenario, `To order of Banco ${voyage.reference}`);
  await settle(sellerTab, voyage.id, REVISED, sellerBeforeGive);
  await settle(buyerTab, voyage.id, REVISED, buyerBeforeGive);
  await expect(buyerItem).toContainText('Not uploaded yet');

  // The seller uploads a PDF; the buyer's page shows it without being touched.
  const first = { name: `bill-of-lading-${voyage.reference}.pdf`, buffer: pdf() };
  const buyerQuiet = await expectNotPolling(buyerTab.page, buyerTab.network, voyage.id);
  const sellerBeforeUpload = sellerTab.network.mark();
  await uploadBillOfLading(sellerTab.page, first, 1);

  const uploaded = await waitForMessage(buyerTab.network, voyage.id, UPLOADED, {
    after: buyerQuiet,
  });
  await expect(buyerItem).toContainText(`Version 1: ${first.name}`);
  await expect(buyerItem).toContainText('Pending review');
  await expect(
    timelineEntry(buyerTab.page, 'Uploaded version 1 of the bill of lading'),
  ).toContainText(seller.fullName);
  expectRefreshCausedBy(buyerTab.network, voyage.id, { quiet: buyerQuiet, signal: uploaded });
  expect(writesAndDownloads(buyerTab.network, buyerQuiet)).toEqual([]);
  await settle(sellerTab, voyage.id, UPLOADED, sellerBeforeUpload);

  // The buyer downloads it through the browser: exactly the bytes the seller uploaded.
  const saving = buyerTab.page.waitForEvent('download');
  await buyerItem.getByRole('button', { name: 'Download version 1 of the bill of lading' }).click();
  const download = await saving;
  expect(download.suggestedFilename()).toBe(first.name);
  expect(sha256(await readFile(await download.path()))).toBe(sha256(first.buffer));

  // The buyer approves it; the seller's page shows who did, without being touched.
  const sellerQuiet = await expectNotPolling(sellerTab.page, sellerTab.network, voyage.id);
  const buyerBeforeApprove = buyerTab.network.mark();
  await reviewBillOfLading(buyerTab.page, 1);

  const approved = await waitForMessage(sellerTab.network, voyage.id, REVIEWED, {
    after: sellerQuiet,
  });
  await expect(sellerItem).toContainText(`Approved by ${buyer.fullName}`);
  await expect(
    timelineEntry(sellerTab.page, 'Approved version 1 of the bill of lading'),
  ).toContainText(buyer.fullName);
  expectRefreshCausedBy(sellerTab.network, voyage.id, { quiet: sellerQuiet, signal: approved });
  expect(writesAndDownloads(sellerTab.network, sellerQuiet)).toEqual([]);
  await settle(buyerTab, voyage.id, REVIEWED, buyerBeforeApprove);

  // The seller replaces it; the buyer's page shows version 2 pending, version 1 still approved.
  const second = { name: `bill-of-lading-${voyage.reference}-v2.pdf`, buffer: pdf() };
  const buyerQuietAgain = await expectNotPolling(buyerTab.page, buyerTab.network, voyage.id);
  const sellerBeforeReplace = sellerTab.network.mark();
  await uploadBillOfLading(sellerTab.page, second, 2);

  const replaced = await waitForMessage(buyerTab.network, voyage.id, UPLOADED, {
    after: buyerQuietAgain,
  });
  await expect(buyerItem).toContainText(`Version 2: ${second.name}`);
  await expect(buyerItem).toContainText('Pending review');
  await expect(
    timelineEntry(buyerTab.page, 'Uploaded version 2 of the bill of lading'),
  ).toContainText(seller.fullName);
  expectRefreshCausedBy(buyerTab.network, voyage.id, {
    quiet: buyerQuietAgain,
    signal: replaced,
  });
  expect(writesAndDownloads(buyerTab.network, buyerQuietAgain)).toEqual([]);
  await buyerItem.getByRole('button', { name: 'Earlier versions (1)' }).click();
  const buyerHistory = buyerItem.getByRole('list', {
    name: 'Earlier versions of the bill of lading',
  });
  await expect(buyerHistory).toContainText(`Version 1: ${first.name}`);
  await expect(buyerHistory).toContainText(`Approved by ${buyer.fullName}`);
  await settle(sellerTab, voyage.id, UPLOADED, sellerBeforeReplace);

  // The buyer rejects version 2 with a reason; the seller's page shows it, and the history.
  const reason = `The consignee does not match the instructions (${voyage.reference}).`;
  const sellerQuietAgain = await expectNotPolling(sellerTab.page, sellerTab.network, voyage.id);
  await reviewBillOfLading(buyerTab.page, 2, reason);

  const rejected = await waitForMessage(sellerTab.network, voyage.id, REVIEWED, {
    after: sellerQuietAgain,
  });
  await expect(sellerItem).toContainText(`Rejected by ${buyer.fullName}`);
  await expect(sellerItem.getByLabel('Reason for rejecting version 2')).toHaveText(reason);
  await expect(
    timelineEntry(sellerTab.page, 'Rejected version 2 of the bill of lading'),
  ).toContainText(buyer.fullName);
  expectRefreshCausedBy(sellerTab.network, voyage.id, {
    quiet: sellerQuietAgain,
    signal: rejected,
  });
  expect(writesAndDownloads(sellerTab.network, sellerQuietAgain)).toEqual([]);
  await sellerItem.getByRole('button', { name: 'Earlier versions (1)' }).click();
  const sellerHistory = sellerItem.getByRole('list', {
    name: 'Earlier versions of the bill of lading',
  });
  await expect(sellerHistory).toContainText(`Version 1: ${first.name}`);
  await expect(sellerHistory).toContainText(`Approved by ${buyer.fullName}`);
});
