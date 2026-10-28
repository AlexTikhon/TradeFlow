import { defineConfig, devices } from '@playwright/test';

/*
 * `pnpm demo:verify`: the fresh-voyage walkthrough (docs/demo.md, walkthrough 2) driven in
 * Chromium against a demo started exactly as `pnpm demo` starts one (demo-run.ts): built apps,
 * a fresh PostgreSQL 18 container, all migrations and the real demo seed, production sign-in
 * admission. Separate from `pnpm test:e2e`, whose generated data and raised sign-in budget it
 * does not use.
 */
export default defineConfig({
  testDir: '.',
  testMatch: 'walkthrough.spec.ts',
  globalSetup: './global-setup.ts',
  outputDir: '../.output/demo/results',
  reporter: [['list', { printSteps: true }]],
  workers: 1,
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  timeout: 300_000,
  expect: { timeout: 15_000 },
  use: {
    ...devices['Desktop Chrome'],
    contextOptions: { timezoneId: 'UTC', locale: 'en-GB' },
    // As in the E2E suite: no traces or videos, which would record session cookies.
    trace: 'off',
    video: 'off',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
});
