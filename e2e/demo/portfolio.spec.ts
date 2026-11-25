import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import { type ActionItem, type ActionItemPage, ActionItemPageSchema } from '@tradeflow/contracts';
import { actionCenterTab, actionItems, commandsSent } from '../support/action-center.js';
import {
  documentSet,
  expectDocumentSet,
  instructionPanel,
  instructionRevision,
  signIn,
} from '../support/app.js';
import type { Party } from '../support/scenario.js';
import { ANA, DEMO_PASSWORD, LUCIA, RAFAEL, WEI_LING } from './accounts.js';
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
 *
 * The portfolio build adds onboarding: the sign-in page explains TradeFlow and offers the four
 * accounts, and a short guide opens after each sign-in sent from that page. The first test
 * follows it as a visitor would; the second closes the guide after each sign-in, checking what it
 * says to that account, and then checks the showcase itself.
 */

const weiLingDecision = `${WEI_LING.fullName} (${WEI_LING.organizationName})`;

/** One required document on the showcase's only contract. */
const documentItem = (page: Page, label: string) =>
  instructionPanel(page).getByRole('listitem', { name: label, exact: true });

/** The queue's items on one voyage. */
const actionsOn = (page: Page, reference: string) =>
  actionItems(page).filter({ hasText: reference });

/** The guide, open after a sign-in: it addresses this account; once closed, the page is usable. */
async function closeGuide(page: Page, addressed: string): Promise<void> {
  const guide = page.getByRole('dialog', { name: 'Demo guide' });
  await expect(guide).toBeVisible();
  await expect(guide).toContainText(addressed);
  await guide.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(guide).toHaveCount(0);
}

/** How the guide addresses each account. */
const ADDRESSED = new Map<Party, string>([
  [ANA, 'You are Ana, the seller'],
  [WEI_LING, 'You are Wei Ling, the buyer'],
  [RAFAEL, 'You are Rafael, a viewer at the seller'],
  [LUCIA, 'You are Lucía'],
]);
const addressed = (party: Party) => ADDRESSED.get(party) ?? party.fullName;

/** Nothing is wider than the viewport: the page cannot be scrolled sideways. */
async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, 'horizontal overflow in CSS pixels').toBeLessThanOrEqual(0);
}

/** `locator` lies within the viewport's width and does not scroll sideways itself. */
async function expectFitsWidth(page: Page, locator: Locator) {
  const box = await locator.boundingBox();
  const width = page.viewportSize()?.width ?? 0;
  expect(box).not.toBeNull();
  expect(box?.x ?? -1).toBeGreaterThanOrEqual(0);
  expect((box?.x ?? 0) + (box?.width ?? Infinity)).toBeLessThanOrEqual(width);
  expect(await locator.evaluate((element) => element.scrollWidth - element.clientWidth)).toBe(0);
}

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
  await actionCenterTab(tab, party, (page) => closeGuide(page, addressed(party)));
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
  // The same counts on every side: one document in each state, one of four approved.
  await expectDocumentSet(page, 'Documents approved: 1 of 4', [1, 1, 1, 1]);

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

test('portfolio onboarding: a visitor picks an account, signs in, and follows the guide to the showcase', async ({
  newContext,
  newTab,
  showcase,
}) => {
  const { reference, voyageId } = showcase;
  const visitor = await newTab(await newContext());
  const { page } = visitor;
  const accounts = page.getByRole('list', { name: 'Demo accounts' });
  const form = page.getByRole('form', { name: 'Sign in' });
  const guide = page.getByRole('dialog', { name: 'Demo guide' });
  const reopen = page.getByRole('button', { name: 'Demo guide' });
  let signedIn = 0;

  await test.step('The sign-in page explains TradeFlow and offers the four fictional accounts', async () => {
    // A protected page first: signing in must come back to it.
    await page.goto('/actions');
    await expect(page).toHaveURL(/\/sign-in$/);
    await expect(page.getByText(/one shared record of its execution/)).toBeVisible();
    await expect(page.getByText(/stay confidential to its seller and buyer/)).toBeVisible();
    await expect(page.getByText(/Fictional people and companies/)).toContainText(DEMO_PASSWORD);
    await expect(accounts.getByRole('button')).toHaveText([
      /^Seller · Cerrado Grãos.*Ana Souza/,
      /^Buyer · Meridian Agri Trading.*Tan Wei Ling/,
      /^Viewer · Cerrado Grãos.*Rafael Lima/,
      /^Outsider · Pampa Litoral.*Lucía Ferreyra/,
    ]);
    await expectNoHorizontalOverflow(page);
  });

  await test.step('Choosing an account with the keyboard fills the form and sends nothing', async () => {
    const before = visitor.network.mark();
    // Nothing has focus on arrival: the first Tab reaches the first account.
    await page.keyboard.press('Tab');
    await expect(accounts.getByRole('button', { name: /Ana Souza/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(form.getByLabel('Email')).toHaveValue(ANA.email);
    await expect(form.getByLabel('Password')).toHaveValue(DEMO_PASSWORD);
    await expect(accounts.getByRole('button', { name: /Ana Souza/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    await expect(form.getByRole('button', { name: 'Sign in' })).toBeFocused();
    await expect(page).toHaveURL(/\/sign-in$/);
    expect(
      visitor.network
        .entries('request', { after: before })
        .filter((request) => request.path.startsWith('/api/auth/'))
        .map((request) => `${request.method} ${request.path}`),
    ).toEqual([]);
  });

  await test.step('Submitting signs in normally, returns to the Action Center and opens the guide', async () => {
    const answered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/auth/sign-in' &&
        response.request().method() === 'POST',
    );
    await page.keyboard.press('Enter');
    expect((await answered).status()).toBe(200);
    signedIn = visitor.network.mark();
    await expect(page).toHaveURL(/\/actions$/);
    await expect(guide).toBeVisible();
    await expect(guide).toContainText(addressed(ANA));
    await expect(guide).toContainText('replace the rejected weight certificate');
    await expect(guide).toContainText('two browser profiles, or a normal and a private window');
    await expect(guide).toContainText('disappears when the demo stops');
    await expect(
      guide.getByRole('link', { name: `Open showcase voyage ${reference}` }),
    ).toHaveAttribute('href', `/voyages/${voyageId}`);
    await expectNoHorizontalOverflow(page);
    await expectFitsWidth(page, guide);
  });

  await test.step('The guide leads to the showcase voyage and to the Action Center, and reopens', async () => {
    await guide.getByRole('link', { name: `Open showcase voyage ${reference}` }).click();
    await expect(guide).toHaveCount(0);
    await expect(page).toHaveURL(new RegExp(`/voyages/${voyageId}$`));
    await expect(page.getByRole('heading', { level: 1, name: reference })).toBeVisible();

    await reopen.click();
    await expect(guide).toBeVisible();
    await guide.getByRole('link', { name: 'Open Action Center' }).click();
    await expect(guide).toHaveCount(0);
    await expect(page).toHaveURL(/\/actions$/);
    await expect(page.getByRole('heading', { name: 'Action Center' })).toBeVisible();

    // By keyboard: it opens from the demo bar, Escape closes it, focus returns to the bar.
    await reopen.focus();
    await page.keyboard.press('Enter');
    await expect(guide).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(guide).toHaveCount(0);
    await expect(reopen).toBeFocused();

    // Following the guide only reads: no command, decision or upload was sent.
    expect(commandsSent(visitor.network, signedIn)).toEqual([]);
  });

  await test.step('At 390 px wide nothing overflows, signed in or not, and the guide fits', async () => {
    await page.setViewportSize({ width: 390, height: 844 });
    await expectNoHorizontalOverflow(page);
    await expect(reopen).toBeVisible();
    await expect(page.getByRole('button', { name: 'Sign out' })).toBeVisible();
    await reopen.click();
    await expect(guide).toBeVisible();
    await expectNoHorizontalOverflow(page);
    await expectFitsWidth(page, guide);
    await expect(guide.getByRole('link', { name: 'Open Action Center' })).toBeVisible();
    await guide.getByRole('button', { name: 'Close the demo guide' }).click();
    await expect(guide).toHaveCount(0);

    await page.getByRole('button', { name: 'Sign out' }).click();
    await expect(form).toBeVisible();
    await expectNoHorizontalOverflow(page);
    for (const account of await accounts.getByRole('button').all()) {
      await account.scrollIntoViewIfNeeded();
      await expectFitsWidth(page, account);
    }
    await expectFitsWidth(page, form.getByRole('button', { name: 'Sign in' }));
    expect(commandsSent(visitor.network, signedIn)).toEqual(['POST /api/auth/sign-out']);
  });
});

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
    const viewerGuide = viewer.page.getByRole('dialog', { name: 'Demo guide' });
    await expect(viewerGuide).toContainText('cannot upload, review or acknowledge anything');
    await expect(
      viewerGuide.getByRole('link', { name: `Open showcase voyage ${reference}` }),
    ).toHaveAttribute('href', `/voyages/${voyageId}`);
    await closeGuide(viewer.page, addressed(RAFAEL));
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

    // At 390 px the summary still fits, every count still says what it counts in words.
    await viewer.page.setViewportSize({ width: 390, height: 844 });
    const summary = documentSet(viewer.page);
    await summary.scrollIntoViewIfNeeded();
    await expectDocumentSet(viewer.page, 'Documents approved: 1 of 4', [1, 1, 1, 1]);
    await expectFitsWidth(viewer.page, summary);
    for (const count of await summary.getByRole('listitem').all()) {
      await expectFitsWidth(viewer.page, count);
    }
    expect(commandsSent(viewer.network, reading)).toEqual([]);
  });

  await test.step('Lucía, who takes no part in the voyage, cannot open it', async () => {
    const outsider = await newTab(await newContext());
    await outsider.page.goto(`/voyages/${voyageId}`);
    await signIn(outsider.page, LUCIA);
    const outsiderGuide = outsider.page.getByRole('dialog', { name: 'Demo guide' });
    await expect(outsiderGuide).toContainText('takes no part in the showcase voyage');
    await expect(outsiderGuide).toContainText('that is intended');
    await closeGuide(outsider.page, addressed(LUCIA));
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
