import { test as base } from '../support/fixtures.js';
import type { Showcase } from './portfolio.js';

export { expect, type Tab } from '../support/fixtures.js';

/**
 * The E2E fixtures (`newContext`, `newTab`), pointed at the demo's web app. The E2E suite's
 * own fixtures that need its run (the database, scenarios, the transport proxy) are not used.
 * `showcase` is the portfolio profile's voyage, for the portfolio verification only.
 */
export const test = base.extend<{ showcase: Showcase }>({
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    const url = process.env.DEMO_WEB_URL;
    if (!url)
      throw new Error('DEMO_WEB_URL is not set: run the walkthrough with "pnpm demo:verify".');
    await use(url);
  },
  // eslint-disable-next-line no-empty-pattern
  showcase: async ({}, use) => {
    const showcase = process.env.DEMO_SHOWCASE;
    if (!showcase)
      throw new Error('DEMO_SHOWCASE is not set: run it with "pnpm demo:portfolio:verify".');
    await use(JSON.parse(showcase) as Showcase);
  },
});
