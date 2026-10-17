import { type BrowserContext, test as base, type Page } from '@playwright/test';
import pg from 'pg';
import { BrowserNetwork } from './browser-network.js';
import { runConfig } from './run-config.js';
import { createScenario, type Scenario } from './scenario.js';
import type { StreamStats } from './transport-proxy.js';

export { expect } from '@playwright/test';

/** Controls the transport proxy's injected faults for one voyage's event streams. */
export class TransportFaults {
  constructor(private readonly baseUrl: string) {}

  private async call<T>(voyageId: string, action: string, body?: unknown): Promise<T> {
    const path = `/__transport/voyages/${encodeURIComponent(voyageId)}${action}`;
    const response = await fetch(this.baseUrl + path, {
      method: body === undefined ? 'GET' : 'POST',
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    if (!response.ok) throw new Error(`Transport proxy answered ${response.status} to ${path}`);
    return (await response.json()) as T;
  }

  /** INJECTED: the next `refuse` stream requests get a 503; the `hold` after them wait. */
  arm(voyageId: string, faults: { refuse?: number; hold?: number }): Promise<StreamStats> {
    return this.call(voyageId, '/faults', faults);
  }

  /** Lets the held stream requests through to the API. */
  async release(voyageId: string): Promise<number> {
    return (await this.call<{ released: number }>(voyageId, '/release', {})).released;
  }

  /** INJECTED: ends the voyage's open streams, as a server or network closing them would. */
  async drop(voyageId: string): Promise<number> {
    return (await this.call<{ dropped: number }>(voyageId, '/drop', {})).dropped;
  }

  stats(voyageId: string): Promise<StreamStats> {
    return this.call(voyageId, '');
  }
}

/** A tab and the record of what its browser did on the network. */
export interface Tab {
  page: Page;
  network: BrowserNetwork;
}

interface TestFixtures {
  /** Fresh data for this test only. */
  scenario: Scenario;
  /**
   * A new browser context: a separate browser profile with its own cookie jar, as another
   * person on another machine would have. Closed when the test ends.
   */
  newContext: () => Promise<BrowserContext>;
  /** A new tab in `context`, recorded from its first request. */
  newTab: (context: BrowserContext) => Promise<Tab>;
  transport: TransportFaults;
}

interface WorkerFixtures {
  database: pg.Pool;
}

export const test = base.extend<TestFixtures, WorkerFixtures>({
  // Known only once global setup has started the web server.
  // eslint-disable-next-line no-empty-pattern
  baseURL: async ({}, use) => {
    await use(runConfig().webUrl);
  },
  database: [
    // eslint-disable-next-line no-empty-pattern
    async ({}, use) => {
      const pool = new pg.Pool({ connectionString: runConfig().databaseUrl, max: 2 });
      await use(pool);
      await pool.end();
    },
    { scope: 'worker' },
  ],
  scenario: async ({ database }, use) => {
    await use(await createScenario(database, runConfig().passwordHash));
  },
  newContext: async ({ browser, baseURL, contextOptions }, use) => {
    const contexts: BrowserContext[] = [];
    await use(async () => {
      const context = await browser.newContext({
        ...contextOptions,
        ...(baseURL !== undefined && { baseURL }),
      });
      contexts.push(context);
      return context;
    });
    await Promise.all(contexts.map((context) => context.close()));
  },
  // eslint-disable-next-line no-empty-pattern
  newTab: async ({}, use) => {
    await use(async (context) => {
      const page = await context.newPage();
      return { page, network: await BrowserNetwork.record(page) };
    });
  },
  // eslint-disable-next-line no-empty-pattern
  transport: async ({}, use) => {
    await use(new TransportFaults(runConfig().transportUrl));
  },
});
