import { defineConfig } from '@playwright/test';
import walkthrough from './playwright.config.js';

/*
 * `pnpm demo:portfolio:verify`: the portfolio showcase checked in Chromium against a demo started
 * exactly as `pnpm demo:portfolio` starts one (the same global setup, with the portfolio profile):
 * a fresh environment, the real seed, the showcase prepared through the API, production sign-in
 * admission. Everything else as in `pnpm demo:verify`: one worker, no retries, no traces.
 */
export default defineConfig({
  ...walkthrough,
  testMatch: 'portfolio.spec.ts',
  metadata: { demoProfile: 'portfolio' },
  outputDir: '../.output/demo/portfolio-results',
  timeout: 180_000,
});
