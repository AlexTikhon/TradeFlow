import { expect, type Page } from '@playwright/test';
import { E2E_PASSWORD } from './run-config.js';
import type { Party, Scenario } from './scenario.js';

/* What a user does in the web app, through its accessible names, as a person would. */

export async function signIn(page: Page, party: Party): Promise<void> {
  const form = page.getByRole('form', { name: 'Sign in' });
  await form.getByLabel('Email').fill(party.email);
  await form.getByLabel('Password').fill(E2E_PASSWORD);
  await form.getByRole('button', { name: 'Sign in' }).click();
}

export async function signOut(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Sign out' }).click();
}

export const voyagePath = (scenario: Scenario) => `/voyages/${scenario.voyage.id}`;

/** The voyage page has rendered for `party`: its heading, and who is signed in. */
export async function expectVoyagePage(page: Page, scenario: Scenario, party: Party) {
  await expect(page.getByRole('heading', { name: scenario.voyage.reference })).toBeVisible();
  await expect(page.getByText(party.fullName, { exact: true })).toBeVisible();
}

/** The sign-in form, and nothing of the protected app around it. */
export async function expectSignedOut(page: Page, scenario: Scenario) {
  await expect(page).toHaveURL(/\/sign-in$/);
  await expect(page.getByRole('form', { name: 'Sign in' })).toBeVisible();
  for (const protectedText of [
    scenario.voyage.reference,
    scenario.seller.fullName,
    scenario.buyer.fullName,
    'ETA notices',
    'Timeline',
  ]) {
    await expect(page.getByText(protectedText)).toHaveCount(0);
  }
  await expect(page.getByRole('button', { name: 'Sign out' })).toHaveCount(0);
}

export const noticeItem = (page: Page, message: string) =>
  page.getByRole('listitem', { name: 'ETA notice, contract 1' }).filter({ hasText: message });

export const timelineEntry = (page: Page, description: string) =>
  page
    .getByRole('list', { name: 'Timeline' })
    .getByRole('listitem')
    .filter({ hasText: description });

/** The documentary instructions under the voyage's only contract. */
export const instructionPanel = (page: Page) =>
  page
    .getByRole('list', { name: 'Documentary instructions by contract' })
    .getByRole('listitem', { name: /^Contract 1 · / });

/** One revision as the panel shows it (outside any open form). */
export const instructionRevision = (page: Page, number: number) =>
  instructionPanel(page).getByRole('region', { name: `Revision ${number}`, exact: true });

/** Opens the buyer's form: for the first instructions, or for a revision of the current ones. */
export async function openInstructionForm(page: Page, kind: 'give' | 'revise') {
  const [button, form] =
    kind === 'give'
      ? ['Give documentary instructions', 'Give documentary instructions']
      : ['Revise instructions', 'Revise documentary instructions'];
  const panel = instructionPanel(page);
  await panel.getByRole('button', { name: button }).click();
  return panel.getByRole('form', { name: form });
}

/** Gives the first instructions through the panel's form, as the buyer, and waits for success. */
export async function giveInstructions(page: Page, scenario: Scenario, consignee: string) {
  const form = await openInstructionForm(page, 'give');
  await form.getByLabel('Consignee').fill(consignee);
  const row = form.getByRole('listitem', { name: 'Required document 1' });
  await row.getByLabel('Document', { exact: true }).selectOption('BILL_OF_LADING');
  await row.getByLabel('Originals', { exact: true }).fill('3');
  await row.getByLabel('Copies', { exact: true }).fill('2');
  await form.getByRole('button', { name: 'Send instructions' }).click();
  await expectInstructionsSent(page, scenario, 1);
}

/** Revises the current instructions with a new consignee, and waits for success. */
export async function reviseInstructions(
  page: Page,
  scenario: Scenario,
  consignee: string,
  revision: number,
) {
  const form = await openInstructionForm(page, 'revise');
  await form.getByLabel('Consignee').fill(consignee);
  await form.getByRole('button', { name: `Send revision ${revision}` }).click();
  await expectInstructionsSent(page, scenario, revision);
}

export async function expectInstructionsSent(page: Page, scenario: Scenario, revision: number) {
  await expect(
    instructionPanel(page).getByText(
      `Revision ${revision} has been sent to ${scenario.seller.organizationName} for acknowledgement.`,
    ),
  ).toBeVisible();
}

/** The bill of lading the current revision requires, with its versions and its form. */
export const billOfLading = (page: Page) =>
  instructionPanel(page).getByRole('listitem', { name: 'Bill of lading', exact: true });

/** Uploads `file` as file version `version` of the bill of lading, as the seller. */
export async function uploadBillOfLading(
  page: Page,
  file: { name: string; buffer: Buffer },
  version: number,
) {
  const item = billOfLading(page);
  await item
    .getByLabel('PDF file for the bill of lading')
    .setInputFiles({ name: file.name, mimeType: 'application/pdf', buffer: file.buffer });
  await item
    .getByRole('button', {
      name: version === 1 ? 'Upload' : `Upload as version ${version}`,
      exact: true,
    })
    .click();
  await expect(
    item.getByText(`Version ${version} of the bill of lading has been uploaded.`),
  ).toBeVisible();
}

/** Approves file version `version` of the bill of lading, or rejects it with `reason`. */
export async function reviewBillOfLading(page: Page, version: number, reason?: string) {
  const item = billOfLading(page);
  if (reason === undefined) {
    await item.getByLabel('Approve', { exact: true }).check();
    await item.getByRole('button', { name: `Approve version ${version}` }).click();
  } else {
    await item.getByLabel('Reject', { exact: true }).check();
    await item.getByLabel('Reason for rejecting').fill(reason);
    await item.getByRole('button', { name: `Reject version ${version}` }).click();
  }
  const verb = reason === undefined ? 'approved' : 'rejected';
  await expect(
    item.getByText(`Version ${version} of the bill of lading has been ${verb}.`),
  ).toBeVisible();
}

/** A `datetime-local` value. Contexts run in UTC, so the local time is the UTC time. */
const localInput = (epochMs: number) => new Date(epochMs).toISOString().slice(0, 16);

const DAY_MS = 24 * 60 * 60 * 1000;

/** Issues an ETA notice through the panel's form, as the seller, and waits for its success. */
export async function issueNotice(page: Page, scenario: Scenario, message: string) {
  await page.getByRole('button', { name: 'Issue ETA notice' }).click();
  const form = page.getByRole('form', { name: 'Issue ETA notice' });
  const now = Date.now();
  await form.getByLabel('Estimated arrival').fill(localInput(now + 3 * DAY_MS));
  await form.getByLabel('Acknowledge by').fill(localInput(now + DAY_MS));
  await form.getByLabel('Message (optional)').fill(message);
  await form.getByRole('button', { name: 'Issue notice' }).click();
  await expect(
    page.getByText(`Your ETA notice to ${scenario.buyer.organizationName} has been issued.`),
  ).toBeVisible();
}
