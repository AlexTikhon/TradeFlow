import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { Locator, Page } from '@playwright/test';
import {
  actionCenterTab,
  actionItem,
  actionItems,
  commandsSent,
  expectQueuePolled,
  linkedRecordStatus,
  openActionCenterAndRead,
} from '../support/action-center.js';
import {
  billOfLading,
  giveInstructions,
  instructionPanel,
  instructionRevision,
  pdf,
  reviewBillOfLading,
  signIn,
  uploadBillOfLading,
} from '../support/app.js';
import type { Scenario } from '../support/scenario.js';
import { ANA, EMRE, LUCIA, WEI_LING } from './accounts.js';
import { expect, type Tab, test } from './fixtures.js';

/*
 * The fresh-voyage walkthrough (docs/demo.md, walkthrough 2, F1 to F8) on the real demo seed,
 * through the UI only: after seeding, every business write (the voyage, its trade string, the
 * instructions, the files and the decisions) is a click or a typed value in Chromium. Ana
 * (seller) and Wei Ling (buyer) each have a browser context of their own; Emre and Lucía, for
 * the visibility checks of F8, too. Sign-in runs with the production admission defaults.
 *
 * Between the two organizations, each Action Center queue learns of the other's command by its
 * own 30-second polling: `expectQueuePolled` moves that page's fake clock (installed by
 * `actionCenterTab` before the page loads) forward 31 seconds, then waits for the browser's read
 * of the queue and its answer. Nothing else is faked; no Refresh is pressed. Seeded voyages have
 * open actions of their own, so the queues are checked for the new voyage's actions only.
 */

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');

const chain = (page: Page) =>
  page.getByRole('list', { name: 'Trade string, from exporter to final buyer' });

/** The trade-string item marked as the viewer's own organization: there is exactly one. */
const ownChainItem = (page: Page) =>
  chain(page).getByRole('listitem').filter({ hasText: 'Your organization' });

const contractBlocks = (page: Page) =>
  page
    .getByRole('list', { name: 'Documentary instructions by contract' })
    .getByRole('listitem', { name: /^Contract \d+ · / });

const timeline = (page: Page) => page.getByRole('list', { name: 'Timeline' });

/** The queue's items for one voyage. */
const actionsOn = (page: Page, reference: string) =>
  actionItems(page).filter({ hasText: reference });

const openLink = (item: Locator, label: string, reference: string) =>
  item.getByRole('link', { name: `${label} on ${reference}, contract 1` });

const navigate = (page: Page, link: 'Voyages' | 'Action Center') =>
  page.getByRole('navigation', { name: 'Main' }).getByRole('link', { name: link }).click();

/** Opens `reference` from the voyage list, as a person would. */
async function openVoyage(page: Page, reference: string) {
  await navigate(page, 'Voyages');
  await page.getByRole('table', { name: 'Voyages' }).getByRole('link', { name: reference }).click();
  await expect(page.getByRole('heading', { level: 1, name: reference })).toBeVisible();
}

/** The timeline shows exactly these entries, newest first: description, actor, contract label. */
async function expectTimeline(page: Page, entries: [string, string, boolean][]) {
  const items = timeline(page).getByRole('listitem');
  await expect(items).toHaveCount(entries.length);
  for (const [index, [description, actor, underContract]] of entries.entries()) {
    const item = items.nth(index);
    await expect(item).toContainText(description);
    await expect(item).toContainText(actor);
    if (underContract) await expect(item).toContainText('Contract 1');
    else await expect(item).not.toContainText('Contract');
  }
}

test('a fresh voyage on the demo seed: created and set up, then instructions, a rejected and replaced bill of lading, both queues and the timeline', async ({
  newContext,
  newTab,
}) => {
  const seller: Tab = await newTab(await newContext());
  const buyer: Tab = await newTab(await newContext());
  const sellerPage = seller.page;
  const buyerPage = buyer.page;
  const anaActor = `${ANA.fullName} (${ANA.organizationName})`;
  const weiLingActor = `${WEI_LING.fullName} (${WEI_LING.organizationName})`;
  const consignee = 'To order of Banco Demo';
  const reason = 'Consignee does not match revision 1.';
  const first = { name: 'bl-v1.pdf', buffer: pdf() };
  const second = { name: 'bl-v2.pdf', buffer: pdf() };
  let reference = '';
  let voyageId = '';

  await test.step('Ana and Wei Ling sign in, each on the Action Center, in contexts of their own', async () => {
    await actionCenterTab(seller, ANA);
    await actionCenterTab(buyer, WEI_LING);
    // The seed's open notice to Meridian on TF-2026-0002: this is the seeded database.
    await expect(actionItem(buyerPage, 'Acknowledge ETA notice', 'TF-2026-0002')).toBeVisible();
  });

  await test.step('F1: Ana creates a voyage; Wei Ling cannot see it', async () => {
    await navigate(sellerPage, 'Voyages');
    await sellerPage.getByRole('link', { name: 'New voyage' }).click();
    const form = sellerPage.getByRole('form', { name: 'New voyage' });
    await expect(form).toContainText(
      `${ANA.organizationName} will be the exporter on this voyage.`,
    );
    await form.getByLabel('Vessel').selectOption({ label: 'MV Cape Aurora (IMO 9812640)' });
    await form.getByLabel('Commodity').selectOption({ label: 'Soybeans' });
    await form.getByLabel('Quantity (MT)').fill('30000');
    await form.getByLabel('Load port').selectOption({ label: 'Paranaguá (BRPNG)' });
    await form.getByLabel('Discharge port').selectOption({ label: 'Mersin (TRMER)' });
    await form.getByLabel('Laycan start').fill('2026-12-01');
    await form.getByLabel('Laycan end').fill('2026-12-10');
    await form.getByRole('button', { name: 'Create voyage' }).click();

    await expect(sellerPage).toHaveURL(/\/voyages\/[0-9a-f-]{36}$/);
    const heading = sellerPage.getByRole('heading', { level: 1 });
    await expect(heading).toHaveText(/^TF-\d{4}-\d{4,}$/);
    reference = (await heading.textContent()) ?? '';
    voyageId = new URL(sellerPage.url()).pathname.split('/').at(-1) ?? '';
    test.info().annotations.push({ type: 'voyage', description: `${reference} (${voyageId})` });
    // Seeded references are TF-2026-0001 to 0007; the seed sets the counter past them.
    expect(reference).not.toMatch(/^TF-2026-000[1-7]$/);

    await expect(sellerPage.getByText('Trade string not configured')).toBeVisible();
    await expect(sellerPage.getByRole('button', { name: 'Set up trade string' })).toBeVisible();
    await expect(sellerPage.getByRole('table', { name: 'Trade parties' })).toContainText(
      ANA.organizationName,
    );
    await expectTimeline(sellerPage, [['Created the voyage', anaActor, false]]);

    await navigate(buyerPage, 'Voyages');
    const list = buyerPage.getByRole('table', { name: 'Voyages' });
    await expect(list.getByRole('link', { name: 'TF-2026-0002' })).toBeVisible();
    await expect(list.getByRole('link', { name: reference })).toHaveCount(0);
    await buyerPage.goto(`/voyages/${voyageId}`);
    await expect(buyerPage.getByText('Voyage not found')).toBeVisible();
    await expect(
      buyerPage.getByText('This voyage does not exist, or you do not have access to it.'),
    ).toBeVisible();
  });

  await test.step('F2: Ana sets up the trade string Cerrado → Meridian → Anatolia', async () => {
    await sellerPage.getByRole('button', { name: 'Set up trade string' }).click();
    const setup = sellerPage.getByRole('form', { name: 'Set up the trade string' });
    const search = setup.getByLabel('Find an organization');
    await search.fill('Cerr');
    await expect(setup.getByText('No organization matches “Cerr”.')).toBeVisible();
    await search.fill('Meridian');
    await setup.getByRole('button', { name: `Add ${WEI_LING.organizationName}` }).click();
    await expect(
      setup.getByRole('listitem', { name: `2. ${WEI_LING.organizationName}, Final buyer` }),
    ).toBeVisible();
    await search.fill('Anatolia');
    await setup.getByRole('button', { name: `Add ${EMRE.organizationName}` }).click();
    await expect(
      setup.getByRole('listitem', { name: `2. ${WEI_LING.organizationName}, Trader` }),
    ).toBeVisible();
    await expect(
      setup.getByRole('listitem', { name: `3. ${EMRE.organizationName}, Final buyer` }),
    ).toBeVisible();

    await setup.getByRole('button', { name: 'Review the trade string' }).click();
    await expect(
      setup.getByText(`Contract 1: ${ANA.organizationName} sells to ${WEI_LING.organizationName}`),
    ).toBeVisible();
    await expect(
      setup.getByText(`Contract 2: ${WEI_LING.organizationName} sells to ${EMRE.organizationName}`),
    ).toBeVisible();
    await expect(
      setup.getByText('It does not record that any of them agreed to it.'),
    ).toBeVisible();
    await setup.getByRole('button', { name: 'Set up trade string' }).click();

    await expect(sellerPage.getByText('Trade string set up')).toBeVisible();
    await expect(sellerPage.getByText(/now take part in this voyage\.$/)).toBeVisible();
    await expect(sellerPage.getByRole('button', { name: 'Set up trade string' })).toHaveCount(0);
    await expect(chain(sellerPage).getByRole('listitem')).toHaveCount(3);
    for (const party of [ANA, WEI_LING, EMRE]) {
      await expect(chain(sellerPage)).toContainText(party.organizationName);
    }
    await expect(contractBlocks(sellerPage)).toHaveCount(1);
    await expect(instructionPanel(sellerPage)).toContainText('You sell: you receive them');
    await expect(instructionPanel(sellerPage)).toContainText(
      'The buyer has not given documentary instructions under this contract yet.',
    );
    await expectTimeline(sellerPage, [
      ['Set up the trade string', anaActor, false],
      ['Created the voyage', anaActor, false],
    ]);
  });

  const scenario: Scenario = {
    voyage: { id: voyageId, reference },
    seller: ANA,
    buyer: WEI_LING,
    buyerColleague: WEI_LING,
  };

  await test.step('F3: Wei Ling gains access: the voyage, the string and both her contracts', async () => {
    await openVoyage(buyerPage, reference);
    await expect(chain(buyerPage).getByRole('listitem')).toHaveCount(3);
    await expect(ownChainItem(buyerPage)).toContainText(WEI_LING.organizationName);
    await expect(contractBlocks(buyerPage)).toHaveCount(2);
    await expect(instructionPanel(buyerPage)).toContainText('You buy: you give them');
    await expect(instructionPanel(buyerPage)).toContainText(
      'Your organization has not given documentary instructions under this contract yet.',
    );
    await expect(contractBlocks(buyerPage).nth(1)).toContainText('You sell: you receive them');
    await expectTimeline(buyerPage, [
      ['Set up the trade string', anaActor, false],
      ['Created the voyage', anaActor, false],
    ]);
  });

  await test.step('F4: Wei Ling gives instructions; Ana’s queue asks her to acknowledge them', async () => {
    await openActionCenterAndRead(seller);
    await expect(actionsOn(sellerPage, reference)).toHaveCount(0);

    await giveInstructions(buyerPage, scenario, consignee);

    await expectQueuePolled(seller);
    const actions = actionsOn(sellerPage, reference);
    await expect(actions.getByRole('heading')).toHaveText(['Acknowledge instructions']);
    await expect(actions).toContainText(`${WEI_LING.organizationName} · Contract 1`);
    await expect(actions).toContainText('Revision 1');

    const opened = seller.network.mark();
    await openLink(actions, 'Open revision 1', reference).click();
    await expect(linkedRecordStatus(sellerPage)).toContainText(
      'Revision 1 is waiting for your organization to acknowledge receipt',
    );
    await expect(instructionRevision(sellerPage, 1)).toBeFocused();
    await expect(instructionRevision(sellerPage, 1)).toContainText(consignee);
    expect(commandsSent(seller.network, opened)).toEqual([]);

    await sellerPage.getByRole('button', { name: 'Acknowledge receipt of revision 1' }).click();
    await expect(instructionRevision(sellerPage, 1)).toContainText('Acknowledged by the seller');
    // Wei Ling's voyage page, untouched, learns of it over its event stream.
    await expect(instructionRevision(buyerPage, 1)).toContainText('Acknowledged by the seller');
    await openActionCenterAndRead(seller);
    await expect(actionsOn(sellerPage, reference)).toHaveCount(0);
  });

  await test.step('F5: Ana uploads a PDF; Wei Ling’s queue asks for a decision; the download matches by SHA-256', async () => {
    await openActionCenterAndRead(buyer);
    await expect(actionsOn(buyerPage, reference)).toHaveCount(0);

    await openVoyage(sellerPage, reference);
    await uploadBillOfLading(sellerPage, first, 1);
    await openActionCenterAndRead(seller);
    await expect(actionsOn(sellerPage, reference)).toHaveCount(0);

    await expectQueuePolled(buyer);
    const actions = actionsOn(buyerPage, reference);
    await expect(actions.getByRole('heading')).toHaveText(['Review document']);
    await expect(actions).toContainText(`${ANA.organizationName} · Contract 1`);
    await expect(actions).toContainText('Bill of lading, version 1 (instructions revision 1)');

    const opened = buyer.network.mark();
    await openLink(actions, 'Open version 1', reference).click();
    await expect(linkedRecordStatus(buyerPage)).toContainText(
      'Version 1 of the bill of lading is waiting for your organization’s decision',
    );
    const version1 = billOfLading(buyerPage).getByRole('group', {
      name: 'Version 1 of the bill of lading',
    });
    await expect(version1).toBeFocused();
    await expect(billOfLading(buyerPage)).toContainText(`Version 1: ${first.name}`);
    await expect(billOfLading(buyerPage)).toContainText('Pending review');
    const review = buyerPage.getByRole('form', { name: 'Review version 1 of the bill of lading' });
    await expect(review.getByLabel('Approve', { exact: true })).not.toBeChecked();
    await expect(review.getByLabel('Reject', { exact: true })).not.toBeChecked();
    expect(commandsSent(buyer.network, opened)).toEqual([]);

    const saving = buyerPage.waitForEvent('download');
    await billOfLading(buyerPage)
      .getByRole('button', { name: 'Download version 1 of the bill of lading' })
      .click();
    const download = await saving;
    expect(download.suggestedFilename()).toBe(first.name);
    expect(sha256(await readFile(await download.path()))).toBe(sha256(first.buffer));
    await expect(billOfLading(buyerPage)).toContainText(sha256(first.buffer).slice(0, 12));
  });

  await test.step('F6: Wei Ling rejects version 1; Ana’s queue asks her to replace it, with the reason', async () => {
    await reviewBillOfLading(buyerPage, 1, reason);
    await openActionCenterAndRead(buyer);
    await expect(actionsOn(buyerPage, reference)).toHaveCount(0);

    await expectQueuePolled(seller);
    const actions = actionsOn(sellerPage, reference);
    await expect(actions.getByRole('heading')).toHaveText(['Replace rejected document']);
    await expect(actions).toContainText(reason);
    await expect(actions).toContainText(`${WEI_LING.organizationName} · Contract 1`);

    const opened = seller.network.mark();
    await openLink(actions, 'Open version 1', reference).click();
    // Waits for the page's fresh read before choosing a file (docs/demo.md, A4).
    await expect(linkedRecordStatus(sellerPage)).toContainText(
      'Version 1 of the bill of lading was rejected and is waiting for your organization to replace it',
    );
    await expect(
      billOfLading(sellerPage).getByRole('group', { name: 'Version 1 of the bill of lading' }),
    ).toBeFocused();
    await expect(billOfLading(sellerPage)).toContainText(`Rejected by ${WEI_LING.fullName}`);
    expect(commandsSent(seller.network, opened)).toEqual([]);
  });

  await test.step('F7: Ana uploads the replacement; Wei Ling approves version 2; no action is left on the voyage', async () => {
    await uploadBillOfLading(sellerPage, second, 2);
    await openActionCenterAndRead(seller);
    await expect(actionsOn(sellerPage, reference)).toHaveCount(0);

    await expectQueuePolled(buyer);
    const actions = actionsOn(buyerPage, reference);
    await expect(actions.getByRole('heading')).toHaveText(['Review document']);
    await expect(actions).toContainText('Bill of lading, version 2 (instructions revision 1)');

    const opened = buyer.network.mark();
    await openLink(actions, 'Open version 2', reference).click();
    await expect(linkedRecordStatus(buyerPage)).toContainText(
      'Version 2 of the bill of lading is waiting for your organization’s decision',
    );
    await expect(
      billOfLading(buyerPage).getByRole('group', { name: 'Version 2 of the bill of lading' }),
    ).toBeFocused();
    expect(commandsSent(buyer.network, opened)).toEqual([]);
    await reviewBillOfLading(buyerPage, 2);
    await expect(linkedRecordStatus(buyerPage)).toContainText(
      'Version 2 of the bill of lading has already been approved',
    );

    await openActionCenterAndRead(buyer);
    await expect(actionsOn(buyerPage, reference)).toHaveCount(0);
    await expect(actionItem(buyerPage, 'Acknowledge ETA notice', 'TF-2026-0002')).toBeVisible();
    await expectQueuePolled(seller);
    await expect(actionsOn(sellerPage, reference)).toHaveCount(0);
  });

  await test.step('Earlier versions keep their decisions, on both sides', async () => {
    await openVoyage(sellerPage, reference);
    await openVoyage(buyerPage, reference);
    for (const page of [sellerPage, buyerPage]) {
      const item = billOfLading(page);
      await expect(item).toContainText(`Version 2: ${second.name}`);
      await expect(item).toContainText(`Approved by ${WEI_LING.fullName}`);
      await item.getByRole('button', { name: 'Earlier versions (1)' }).click();
      const history = item.getByRole('list', { name: 'Earlier versions of the bill of lading' });
      await expect(history).toContainText(`Version 1: ${first.name}`);
      await expect(history).toContainText(`Rejected by ${WEI_LING.fullName}`);
      await expect(history.getByLabel('Reason for rejecting version 1')).toHaveText(reason);
    }
  });

  await test.step('F8: the timeline on both sides, the final buyer’s view and an outsider', async () => {
    const entries: [string, string, boolean][] = [
      ['Approved version 2 of the bill of lading (instructions revision 1)', weiLingActor, true],
      ['Uploaded version 2 of the bill of lading (instructions revision 1)', anaActor, true],
      ['Rejected version 1 of the bill of lading (instructions revision 1)', weiLingActor, true],
      ['Uploaded version 1 of the bill of lading (instructions revision 1)', anaActor, true],
      ['Acknowledged revision 1 of the documentary instructions', anaActor, true],
      ['Gave documentary instructions', weiLingActor, true],
      ['Set up the trade string', anaActor, false],
      ['Created the voyage', anaActor, false],
    ];
    for (const page of [sellerPage, buyerPage]) {
      await expectTimeline(page, entries);
      // Identifiers only: no consignee, file name or reason.
      for (const content of [consignee, first.name, second.name, reason]) {
        await expect(timeline(page)).not.toContainText(content);
      }
    }

    const { page: finalBuyerPage } = await newTab(await newContext());
    await finalBuyerPage.goto('/voyages');
    await signIn(finalBuyerPage, EMRE);
    await openVoyage(finalBuyerPage, reference);
    await expect(ownChainItem(finalBuyerPage)).toContainText(EMRE.organizationName);
    await expect(contractBlocks(finalBuyerPage)).toHaveCount(1);
    await expect(contractBlocks(finalBuyerPage)).toHaveAccessibleName(/^Contract 2 · /);
    await expect(contractBlocks(finalBuyerPage)).toContainText('You buy: you give them');
    await expectTimeline(finalBuyerPage, [
      ['Set up the trade string', anaActor, false],
      ['Created the voyage', anaActor, false],
    ]);
    for (const content of [consignee, first.name, second.name, reason]) {
      await expect(finalBuyerPage.getByText(content)).toHaveCount(0);
    }

    const { page: outsiderPage } = await newTab(await newContext());
    await outsiderPage.goto(`/voyages/${voyageId}`);
    await signIn(outsiderPage, LUCIA);
    await expect(outsiderPage.getByText('Voyage not found')).toBeVisible();
    await expect(outsiderPage.getByText(reference)).toHaveCount(0);
  });

  console.log(`Walkthrough passed on ${reference} (${voyageId}).`);
});
