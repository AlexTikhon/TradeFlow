import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { type ActionItem, type ActionItemPage, ActionItemPageSchema } from '@tradeflow/contracts';
import { actionCenterTab, actionItems, commandsSent } from '../support/action-center.js';
import { instructionPanel, instructionRevision, signIn } from '../support/app.js';
import type { Party } from '../support/scenario.js';
import { ANA, LUCIA, RAFAEL, WEI_LING } from './accounts.js';
import { expect, type Tab, test } from './fixtures.js';
import { SHOWCASE_REASONS } from './portfolio.js';
import { SHOWCASE_FILES, sha256, type ShowcaseFile } from './portfolio-files.js';

/*
 * The portfolio showcase (portfolio.ts) as people see it, in Chromium, on a demo started by
 * `pnpm demo:portfolio`'s code. Ana (seller) and Wei Ling (buyer) each have a browser context of
 * their own; Rafael (Ana's colleague, a viewer) and Lucía (no part in the voyage) too. Nothing is
 * mocked or faked: the queues are the API's real answers, read as the browser received them.
 * The seed's own notices put other items in the queues, so every queue check is scoped to the
 * showcase voyage.
 */

const weiLingDecision = `${WEI_LING.fullName} (${WEI_LING.organizationName})`;

/** One required document on the showcase's only contract. */
const documentItem = (page: Page, label: string) =>
  instructionPanel(page).getByRole('listitem', { name: label, exact: true });

/** The queue's items on one voyage. */
const actionsOn = (page: Page, reference: string) =>
  actionItems(page).filter({ hasText: reference });

/**
 * Signs `party` in on the Action Center and answers the queue's first page as the browser
 * received it from the API, checked against the shared contract.
 */
async function signInOnActionCenter(tab: Tab, party: Party): Promise<ActionItemPage> {
  const answered = tab.page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === '/api/action-items' &&
      response.request().method() === 'GET' &&
      response.status() === 200,
  );
  await actionCenterTab(tab, party);
  return ActionItemPageSchema.parse(await (await answered).json());
}

/** What each showcase action is about, as types and targets: nothing else may be there. */
const showcaseActions = (items: ActionItem[], voyageId: string) =>
  items
    .filter((item) => item.voyage.id === voyageId)
    .map((item) => ({
      type: item.type,
      document: item.target.kind === 'DOCUMENT_VERSION' ? item.target.documentType : null,
      version: item.target.kind === 'DOCUMENT_VERSION' ? item.target.versionNumber : null,
    }));

/** Opens the showcase from the voyage list, as a person would. */
async function openVoyage(page: Page, reference: string) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Voyages' })
    .click();
  await page.getByRole('table', { name: 'Voyages' }).getByRole('link', { name: reference }).click();
  await expect(page.getByRole('heading', { level: 1, name: reference })).toBeVisible();
}

/** Clicks a download button and answers the SHA-256 of what the browser saved. */
async function downloaded(page: Page, button: Locator, file: ShowcaseFile): Promise<string> {
  const saving = page.waitForEvent('download');
  await button.click();
  const download = await saving;
  expect(download.suggestedFilename()).toBe(file.fileName);
  return sha256(await readFile(await download.path()));
}

/** The four document states, as every reader on the seller's or the buyer's side sees them. */
async function expectDocumentStates(page: Page) {
  await expect(instructionRevision(page, 1)).toContainText('Acknowledged by the seller');

  const invoice = documentItem(page, 'Commercial invoice');
  await expect(invoice).toContainText('Not uploaded yet');
  await expect(invoice.getByRole('button', { name: /^Download/ })).toHaveCount(0);

  const origin = documentItem(page, 'Certificate of origin');
  await expect(origin).toContainText('Version 1');
  await expect(origin).toContainText('Pending review');
  await expect(origin).toContainText(`Version 1: ${SHOWCASE_FILES.certificateOfOrigin.fileName}`);
  await expect(origin).toContainText(`Pending review by ${WEI_LING.organizationName}`);

  const weight = documentItem(page, 'Weight certificate');
  await expect(weight).toContainText(`Version 1: ${SHOWCASE_FILES.weightCertificate.fileName}`);
  await expect(weight).toContainText(`Rejected by ${weiLingDecision}`);
  await expect(weight.getByLabel('Reason for rejecting version 1')).toHaveText(
    SHOWCASE_REASONS.weightCertificate,
  );

  const bill = documentItem(page, 'Bill of lading');
  await expect(bill).toContainText(`Version 2: ${SHOWCASE_FILES.billOfLadingV2.fileName}`);
  await expect(bill).toContainText(`Approved by ${weiLingDecision}`);
  await bill.getByRole('button', { name: 'Earlier versions (1)' }).click();
  const history = bill.getByRole('list', { name: 'Earlier versions of the bill of lading' });
  await expect(history).toContainText(`Version 1: ${SHOWCASE_FILES.billOfLadingV1.fileName}`);
  await expect(history).toContainText(`Rejected by ${weiLingDecision}`);
  await expect(history.getByLabel('Reason for rejecting version 1')).toHaveText(
    SHOWCASE_REASONS.billOfLading,
  );
}

/** The current and the historical bill of lading download with their expected SHA-256. */
async function expectBillOfLadingDownloads(page: Page) {
  const bill = documentItem(page, 'Bill of lading');
  const current = bill.getByRole('button', { name: 'Download version 2 of the bill of lading' });
  const earlier = bill
    .getByRole('list', { name: 'Earlier versions of the bill of lading' })
    .getByRole('button', { name: 'Download version 1 of the bill of lading' });
  expect(await downloaded(page, current, SHOWCASE_FILES.billOfLadingV2)).toBe(
    SHOWCASE_FILES.billOfLadingV2.sha256,
  );
  expect(await downloaded(page, earlier, SHOWCASE_FILES.billOfLadingV1)).toBe(
    SHOWCASE_FILES.billOfLadingV1.sha256,
  );
}

test('the portfolio showcase: four document states, both queues, history and downloads, a viewer and an outsider', async ({
  newContext,
  newTab,
  showcase,
}) => {
  const { reference, voyageId } = showcase;
  test.info().annotations.push({ type: 'showcase', description: `${reference} (${voyageId})` });
  const seller = await newTab(await newContext());
  const buyer = await newTab(await newContext());

  await test.step("Wei Ling's Action Center: the certificate of origin to review, and nothing else on the showcase", async () => {
    const queue = await signInOnActionCenter(buyer, WEI_LING);
    // The whole queue is on its first page, so nothing on the showcase can be missing from it.
    expect(queue.nextCursor).toBeNull();
    expect(showcaseActions(queue.items, voyageId)).toEqual([
      { type: 'REVIEW_DOCUMENT', document: 'CERTIFICATE_OF_ORIGIN', version: 1 },
    ]);
    const actions = actionsOn(buyer.page, reference);
    await expect(actions.getByRole('heading')).toHaveText(['Review document']);
    await expect(actions).toContainText(`${ANA.organizationName} · Contract 1`);
    await expect(actions).toContainText(
      'Certificate of origin, version 1 (instructions revision 1)',
    );
    // The seeded notice: this is the seeded database, and its items stay where they were.
    await expect(
      actionItems(buyer.page).filter({ hasText: 'TF-2026-0002' }).getByRole('heading'),
    ).toHaveText(['Acknowledge ETA notice']);
  });

  await test.step("Ana's Action Center: the rejected weight certificate to replace, and nothing else on the showcase", async () => {
    const queue = await signInOnActionCenter(seller, ANA);
    expect(queue.nextCursor).toBeNull();
    expect(showcaseActions(queue.items, voyageId)).toEqual([
      { type: 'REPLACE_REJECTED_DOCUMENT', document: 'WEIGHT_CERTIFICATE', version: 1 },
    ]);
    const replace = queue.items.find((item) => item.voyage.id === voyageId);
    expect(replace?.type === 'REPLACE_REJECTED_DOCUMENT' && replace.rejectionReason).toBe(
      SHOWCASE_REASONS.weightCertificate,
    );
    const actions = actionsOn(seller.page, reference);
    await expect(actions.getByRole('heading')).toHaveText(['Replace rejected document']);
    await expect(actions).toContainText(`${WEI_LING.organizationName} · Contract 1`);
    await expect(actions).toContainText(SHOWCASE_REASONS.weightCertificate);
    // Neither the missing invoice nor the approved bill of lading asks anything of anyone.
    for (const page of [seller.page, buyer.page]) {
      await expect(actionsOn(page, reference)).not.toContainText('Commercial invoice');
      await expect(actionsOn(page, reference)).not.toContainText('Bill of lading');
    }
  });

  await test.step('Both sides see the four document states; the bill of lading keeps rejected version 1', async () => {
    await openVoyage(seller.page, reference);
    await openVoyage(buyer.page, reference);
    for (const page of [seller.page, buyer.page]) await expectDocumentStates(page);

    // What each operator may do next: Ana can upload the invoice and replace the rejected
    // weight certificate; Wei Ling can decide on the certificate of origin, and on nothing else.
    for (const label of ['Commercial invoice', 'Weight certificate']) {
      await expect(seller.page.getByRole('form', { name: `Upload ${label}` })).toBeVisible();
    }
    await expect(
      buyer.page.getByRole('form', { name: 'Review version 1 of the certificate of origin' }),
    ).toBeVisible();
    await expect(buyer.page.getByRole('form', { name: /^Review version/ })).toHaveCount(1);
  });

  await test.step('The current and the historical bill of lading download with their expected SHA-256', async () => {
    for (const page of [buyer.page, seller.page]) await expectBillOfLadingDownloads(page);
  });

  await test.step('Rafael, a viewer at the seller, reads every record and has no write control', async () => {
    const viewer = await newTab(await newContext());
    await viewer.page.goto(`/voyages/${voyageId}`);
    await signIn(viewer.page, RAFAEL);
    await expect(viewer.page.getByRole('heading', { level: 1, name: reference })).toBeVisible();
    await expect(viewer.page.getByText(RAFAEL.fullName, { exact: true })).toBeVisible();
    const reading = viewer.network.mark();

    await expectDocumentStates(viewer.page);
    await expectBillOfLadingDownloads(viewer.page);
    await expect(
      documentItem(viewer.page, 'Commercial invoice').getByText(
        'An operator in your organization can upload it.',
      ),
    ).toBeVisible();
    await expect(viewer.page.locator('input[type="file"]')).toHaveCount(0);
    await expect(viewer.page.getByRole('form', { name: /^(Upload|Review) / })).toHaveCount(0);
    await expect(viewer.page.getByRole('button', { name: /^Upload/ })).toHaveCount(0);
    await expect(viewer.page.getByRole('radio')).toHaveCount(0);
    for (const name of [
      /^Acknowledge receipt/,
      /^(Revise|Give) .*instructions$/,
      'Issue ETA notice',
      'Set up trade string',
    ]) {
      await expect(viewer.page.getByRole('button', { name })).toHaveCount(0);
    }
    expect(commandsSent(viewer.network, reading)).toEqual([]);
  });

  await test.step('Lucía, who takes no part in the voyage, cannot open it', async () => {
    const outsider = await newTab(await newContext());
    await outsider.page.goto(`/voyages/${voyageId}`);
    await signIn(outsider.page, LUCIA);
    await expect(outsider.page.getByText('Voyage not found')).toBeVisible();
    await expect(outsider.page.getByText(reference)).toHaveCount(0);
    await outsider.page
      .getByRole('navigation', { name: 'Main' })
      .getByRole('link', { name: 'Voyages' })
      .click();
    await expect(outsider.page.getByRole('table', { name: 'Voyages' })).toBeVisible();
    await expect(outsider.page.getByText(reference)).toHaveCount(0);
  });

  console.log(`Portfolio showcase verified on ${reference} (${voyageId}).`);
});
