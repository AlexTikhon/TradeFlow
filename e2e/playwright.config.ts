import { defineConfig, devices } from '@playwright/test';

/*
 * Real-browser smoke tests: Chromium against the built web app, the Nest API and a dedicated
 * PostgreSQL database, all started by global setup on ports of their own (support/global-setup.ts).
 * Run with `pnpm test:e2e` from the repository root; never part of `pnpm check`.
 */
export default defineConfig({
  testDir: 'tests',
  globalSetup: './support/global-setup.ts',
  outputDir: '.output/results',
  reporter: [['list'], ['html', { outputFolder: '.output/report', open: 'never' }]],
  // One worker: the tests share one API process, and each drives several browser contexts.
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    // Contexts made by the `newContext` fixture take these too.
    contextOptions: { timezoneId: 'UTC', locale: 'en-GB' },
    // Traces and HAR files record cookies and Set-Cookie headers, which would put session
    // tokens on disk; screenshots of a failure show only what the page shows.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
