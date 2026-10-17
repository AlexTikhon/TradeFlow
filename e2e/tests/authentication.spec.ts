import { expectVoyagePage, signIn } from '../support/app.js';
import { expect, test } from '../support/fixtures.js';

test('signs in through the form and stays signed in across a reload, by the HttpOnly cookie', async ({
  newContext,
  newTab,
  scenario,
}) => {
  const context = await newContext();
  const { page, network } = await newTab(context);

  await page.goto('/voyages');
  await expect(page).toHaveURL(/\/sign-in$/);
  await signIn(page, scenario.seller);

  await expect(page).toHaveURL(/\/voyages$/);
  await expect(page.getByText(scenario.seller.fullName, { exact: true })).toBeVisible();
  await expect(page.getByRole('link', { name: scenario.voyage.reference })).toBeVisible();

  // The session cookie's attributes only, never its value: a failing assertion prints what it
  // compares, and the token must not end up in the output.
  const cookies = (await context.cookies()).map(({ name, httpOnly, sameSite, secure, path }) => ({
    name,
    httpOnly,
    sameSite,
    secure,
    path,
  }));
  expect(cookies).toEqual([
    // Not Secure: the run serves plain HTTP on 127.0.0.1. HTTPS is not covered here.
    { name: 'tradeflow_session', httpOnly: true, sameSite: 'Strict', secure: false, path: '/' },
  ]);
  const scriptSeesCookie = await page.evaluate(() => document.cookie.includes('tradeflow_session'));
  expect(scriptSeesCookie).toBe(false);

  const beforeReload = network.mark();
  await page.reload();

  await expect(page).toHaveURL(/\/voyages$/);
  await expect(page.getByText(scenario.seller.fullName, { exact: true })).toBeVisible();
  await page.getByRole('link', { name: scenario.voyage.reference }).click();
  await expectVoyagePage(page, scenario, scenario.seller);

  // After the reload the browser asked who is signed in and the server confirmed it from the
  // cookie alone: no sign-in was sent again and nothing was refused.
  const sessionCheck = await network.waitFor(
    'response',
    (response) => network.requestOf(response.id).path === '/api/auth/me',
    { after: beforeReload, description: 'the session check after the reload' },
  );
  expect(sessionCheck.status).toBe(200);
  const sentAfterReload = network.entries('request', { after: beforeReload });
  expect(sentAfterReload.filter((request) => request.path === '/api/auth/sign-in')).toEqual([]);
  expect(
    network.entries('response', { after: beforeReload }).filter(({ status }) => status === 401),
  ).toEqual([]);
});
