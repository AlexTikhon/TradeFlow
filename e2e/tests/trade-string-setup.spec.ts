import type { Page } from '@playwright/test';
import { expectInstructionsSent, giveInstructions, signIn, timelineEntry } from '../support/app.js';
import { expect, test } from '../support/fixtures.js';
import { runConfig } from '../support/run-config.js';
import { createUnconnectedParties, type Scenario } from '../support/scenario.js';

/*
 * The whole path from nothing to a working contract, through the browser and the real API only:
 * the exporter creates a voyage, sets up its trade string, and the buyer it named finds the
 * voyage and gives documentary instructions under the contract the setup recorded. Only the two
 * organizations and their operators are written straight into the database; no voyage,
 * participation or contract is.
 */

const chain = (page: Page) =>
  page.getByRole('list', { name: 'Trade string, from exporter to final buyer' });

test('an exporter creates a voyage and sets up its trade string; the buyer gains access and gives instructions', async ({
  database,
  newContext,
  newTab,
}) => {
  const { seller, buyer } = await createUnconnectedParties(database, runConfig().passwordHash);

  // The exporter creates the voyage.
  const { page: sellerPage } = await newTab(await newContext());
  await sellerPage.goto('/voyages/new');
  await signIn(sellerPage, seller);
  const form = sellerPage.getByRole('form', { name: 'New voyage' });
  await form.getByLabel('Vessel').selectOption({ label: 'MV E2E Horizon (IMO 9341237)' });
  await form.getByLabel('Commodity').selectOption({ label: 'Soybeans' });
  await form.getByLabel('Quantity (MT)').fill('60000');
  await form.getByLabel('Load port').selectOption({ label: 'Santos (BRSSZ)' });
  await form.getByLabel('Discharge port').selectOption({ label: 'Rotterdam (NLRTM)' });
  await form.getByLabel('Laycan start').fill('2030-11-01');
  await form.getByLabel('Laycan end').fill('2030-11-10');
  await form.getByRole('button', { name: 'Create voyage' }).click();

  await expect(sellerPage).toHaveURL(/\/voyages\/[0-9a-f-]{36}$/);
  const heading = sellerPage.getByRole('heading', { level: 1 });
  await expect(heading).toHaveText(/^TF-\d{4}-\d{4,}$/);
  const reference = (await heading.textContent()) ?? '';
  const voyageId = new URL(sellerPage.url()).pathname.split('/').at(-1) ?? '';
  await expect(sellerPage.getByText('Trade string not configured')).toBeVisible();

  // It names the buyer, reviews what that means, and sets the string up.
  await sellerPage.getByRole('button', { name: 'Set up trade string' }).click();
  const setup = sellerPage.getByRole('form', { name: 'Set up the trade string' });
  await setup.getByLabel('Find an organization').fill(buyer.organizationName);
  await setup.getByRole('button', { name: `Add ${buyer.organizationName}` }).click();
  await expect(
    setup.getByRole('listitem', { name: `2. ${buyer.organizationName}, Final buyer` }),
  ).toBeVisible();
  await setup.getByRole('button', { name: 'Review the trade string' }).click();
  await expect(
    setup.getByText(`Contract 1: ${seller.organizationName} sells to ${buyer.organizationName}`),
  ).toBeVisible();
  await expect(setup.getByText('It does not record that any of them agreed to it.')).toBeVisible();
  await setup.getByRole('button', { name: 'Set up trade string' }).click();

  await expect(sellerPage.getByText('Trade string set up')).toBeVisible();
  await expect(chain(sellerPage).getByRole('listitem')).toHaveCount(2);
  await expect(chain(sellerPage)).toContainText(buyer.organizationName);
  await expect(sellerPage.getByRole('table', { name: 'Trade parties' })).toContainText(
    buyer.organizationName,
  );
  await expect(sellerPage.getByRole('button', { name: 'Set up trade string' })).toHaveCount(0);

  // The buyer, on a machine of its own, now has the voyage, its string and its contract.
  const { page: buyerPage } = await newTab(await newContext());
  await buyerPage.goto('/voyages');
  await signIn(buyerPage, buyer);
  await buyerPage
    .getByRole('table', { name: 'Voyages' })
    .getByRole('link', { name: reference })
    .click();
  await expect(buyerPage.getByRole('heading', { name: reference })).toBeVisible();
  await expect(chain(buyerPage)).toContainText(seller.organizationName);
  await expect(chain(buyerPage)).toContainText('Your organization');
  await expect(timelineEntry(buyerPage, 'Set up the trade string')).toBeVisible();

  // And gives documentary instructions under it, which reach the exporter.
  const scenario: Scenario = {
    voyage: { id: voyageId, reference },
    seller,
    buyer,
    buyerColleague: buyer,
  };
  await giveInstructions(buyerPage, scenario, `To order of Banco ${reference}`);
  await expectInstructionsSent(buyerPage, scenario, 1);
  await expect(
    sellerPage
      .getByRole('list', { name: 'Documentary instructions by contract' })
      .getByText(`To order of Banco ${reference}`),
  ).toBeVisible();
});
