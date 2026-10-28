import { test as base } from '../support/fixtures.js';

export { expect, type Tab } from '../support/fixtures.js';

/**
 * The E2E fixtures (`newContext`, `newTab`), pointed at the demo's web app. The E2E suite's
 * own fixtures that need its run (the database, scenarios, the transport proxy) are not used.
 */
export const test = base.extend({
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const url = process.env.DEMO_WEB_URL;
    if (!url)
      throw new Error('DEMO_WEB_URL is not set: run the walkthrough with "pnpm demo:verify".');
    await use(url);
  },
});
