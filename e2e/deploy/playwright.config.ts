import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: '.',
  testMatch: 'https.spec.ts',
  globalSetup: './global-setup.ts',
  outputDir: '../.output/deploy/results',
  reporter: [['list', { printSteps: true }]],
  workers: 1,
  retries: 0,
  forbidOnly: true,
  timeout: 180_000,
  expect: { timeout: 15_000 },
  use: { trace: 'off', video: 'off', screenshot: 'only-on-failure' },
});
