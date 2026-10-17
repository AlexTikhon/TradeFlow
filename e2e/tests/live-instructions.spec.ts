import type { Page } from '@playwright/test';
import {
  expectInstructionsSent,
  giveInstructions,
  instructionPanel,
  instructionRevision,
  openInstructionForm,
  reviseInstructions,
  timelineEntry,
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
 * Documentary instructions between the buyer and the seller of the voyage's only contract, each
 * in a browser profile of their own. Every stream message here is sent by the real API after a
 * real command committed; the test only waits for what the browser reports.
 */

const REVISED = 'DOCUMENTARY_INSTRUCTION_REVISED';
const ACKNOWLEDGED = 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED';

/** The instruction writes (PUT) the page sent after `after`. */
const instructionWrites = (network: BrowserNetwork, after: number) =>
  network
    .entries('request', { after })
    .filter(
      (request) => request.method === 'PUT' && request.path.endsWith('/documentary-instructions'),
    );

const consigneeField = (page: Page) =>
  instructionPanel(page)
    .getByRole('form', { name: 'Revise documentary instructions' })
    .getByLabel('Consignee');

test('instructions, their acknowledgement and a revision reach the other side over the event stream', async ({
  newContext,
  newTab,
  scenario,
}) => {
  const { voyage, seller, buyer } = scenario;
  const sellerTab = await newTab(await newContext());
  const buyerTab = await newTab(await newContext());
  await liveTab(sellerTab, scenario, seller);
  await liveTab(buyerTab, scenario, buyer);
  await expect(
    instructionPanel(sellerTab.page).getByText(
      'The buyer has not given documentary instructions under this contract yet.',
    ),
  ).toBeVisible();

  // The buyer gives them; the seller's page shows them without being touched.
  const consignee = `To order of Banco ${voyage.reference}`;
  const sellerQuiet = await expectNotPolling(sellerTab.page, sellerTab.network, voyage.id);
  const buyerBeforeGive = buyerTab.network.mark();
  await giveInstructions(buyerTab.page, scenario, consignee);

  const given = await waitForMessage(sellerTab.network, voyage.id, REVISED, {
    after: sellerQuiet,
  });
  const sellerRevision1 = instructionRevision(sellerTab.page, 1);
  await expect(sellerRevision1).toContainText(consignee);
  await expect(sellerRevision1).toContainText('Not acknowledged');
  await expect(timelineEntry(sellerTab.page, 'Gave documentary instructions')).toContainText(
    buyer.fullName,
  );
  expectRefreshCausedBy(sellerTab.network, voyage.id, { quiet: sellerQuiet, signal: given });

  // The buyer's own page is told too; let it settle before the seller acts.
  await settle(buyerTab, voyage.id, REVISED, buyerBeforeGive);
  await expect(instructionRevision(buyerTab.page, 1)).toContainText('Not acknowledged');

  // The seller acknowledges; the buyer's page shows it, and who did, without being touched.
  const buyerQuiet = await expectNotPolling(buyerTab.page, buyerTab.network, voyage.id);
  const sellerBeforeAcknowledge = sellerTab.network.mark();
  await instructionPanel(sellerTab.page)
    .getByRole('button', { name: 'Acknowledge receipt of revision 1' })
    .click();
  await expect(sellerRevision1).toContainText('Acknowledged by the seller');

  const acknowledged = await waitForMessage(buyerTab.network, voyage.id, ACKNOWLEDGED, {
    after: buyerQuiet,
  });
  const buyerRevision1 = instructionRevision(buyerTab.page, 1);
  await expect(buyerRevision1).toContainText('Acknowledged by the seller');
  await expect(buyerRevision1).toContainText(seller.fullName);
  await expect(
    timelineEntry(buyerTab.page, 'Acknowledged revision 1 of the documentary instructions'),
  ).toContainText(seller.fullName);
  expectRefreshCausedBy(buyerTab.network, voyage.id, { quiet: buyerQuiet, signal: acknowledged });
  await settle(sellerTab, voyage.id, ACKNOWLEDGED, sellerBeforeAcknowledge);

  // The buyer revises; the seller's page moves on to revision 2, again unacknowledged.
  const revisedConsignee = `To order of Another Bank ${voyage.reference}`;
  const sellerQuietAgain = await expectNotPolling(sellerTab.page, sellerTab.network, voyage.id);
  await reviseInstructions(buyerTab.page, scenario, revisedConsignee, 2);

  const revised = await waitForMessage(sellerTab.network, voyage.id, REVISED, {
    after: sellerQuietAgain,
  });
  const sellerRevision2 = instructionRevision(sellerTab.page, 2);
  await expect(sellerRevision2).toContainText(revisedConsignee);
  await expect(sellerRevision2).toContainText('Not acknowledged');
  await expect(
    instructionPanel(sellerTab.page).getByRole('button', {
      name: 'Acknowledge receipt of revision 2',
    }),
  ).toBeVisible();
  await expect(
    timelineEntry(sellerTab.page, 'Revised the documentary instructions (revision 2)'),
  ).toContainText(buyer.fullName);
  expectRefreshCausedBy(sellerTab.network, voyage.id, { quiet: sellerQuietAgain, signal: revised });
});

test('a revision pushed while the buyer drafts leaves the draft and its version alone', async ({
  newContext,
  newTab,
  scenario,
}) => {
  const { voyage, buyer, buyerColleague } = scenario;
  const buyerTab = await newTab(await newContext());
  const colleagueTab = await newTab(await newContext());
  await liveTab(buyerTab, scenario, buyer);
  await liveTab(colleagueTab, scenario, buyerColleague);

  // The colleague gives the first instructions; the buyer's page shows them.
  const buyerBeforeGive = buyerTab.network.mark();
  await giveInstructions(colleagueTab.page, scenario, `To order of Banco ${voyage.reference}`);
  await settle(buyerTab, voyage.id, REVISED, buyerBeforeGive);
  await expect(instructionRevision(buyerTab.page, 1)).toBeVisible();

  // The buyer starts a revision of revision 1, and leaves it unsent.
  const draft = `Draft: to order of My Bank ${voyage.reference}`;
  await openInstructionForm(buyerTab.page, 'revise');
  await consigneeField(buyerTab.page).fill(draft);
  const buyerQuiet = await expectNotPolling(buyerTab.page, buyerTab.network, voyage.id);

  // Meanwhile the colleague sends revision 2.
  const theirs = `To order of Colleague Bank ${voyage.reference}`;
  await reviseInstructions(colleagueTab.page, scenario, theirs, 2);

  const pushed = await waitForMessage(buyerTab.network, voyage.id, REVISED, { after: buyerQuiet });
  const form = instructionPanel(buyerTab.page).getByRole('form', {
    name: 'Revise documentary instructions',
  });
  const latest = form.getByRole('region', { name: 'Latest version' });
  await expect(latest).toContainText(`Revision 2 was given by ${buyerColleague.fullName}`);
  await expect(latest).toContainText(theirs);
  expectRefreshCausedBy(buyerTab.network, voyage.id, { quiet: buyerQuiet, signal: pushed });
  // The draft is as the buyer left it, still based on revision 1, and cannot be sent as is.
  await expect(consigneeField(buyerTab.page)).toHaveValue(draft);
  await expect(form.getByRole('button', { name: 'Send revision 2' })).toBeDisabled();
  // Nothing was written, rebased or retried by the page.
  expect(instructionWrites(buyerTab.network, buyerQuiet)).toEqual([]);

  // Only the buyer's choice bases the draft on revision 2; then it is sent as revision 3.
  const colleagueBeforeSend = colleagueTab.network.mark();
  await latest.getByRole('button', { name: 'Base my draft on revision 2' }).click();
  await expect(consigneeField(buyerTab.page)).toHaveValue(draft);
  await form.getByRole('button', { name: 'Send revision 3' }).click();
  await expectInstructionsSent(buyerTab.page, scenario, 3);
  const writes = instructionWrites(buyerTab.network, buyerQuiet);
  expect(writes).toHaveLength(1);

  // And the colleague's page hears of it.
  await waitForMessage(colleagueTab.network, voyage.id, REVISED, { after: colleagueBeforeSend });
  await expect(instructionRevision(colleagueTab.page, 3)).toContainText(draft);
});
