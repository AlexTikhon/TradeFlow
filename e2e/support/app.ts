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
