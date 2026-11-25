import type { FullConfig } from '@playwright/test';
import { startDemo } from './demo-run.js';
import { PORTFOLIO_PROFILE } from './portfolio.js';

/*
 * Starts the demo for `pnpm demo:verify` with the same code as `pnpm demo`, and stops it after
 * the walkthrough, pass or fail. Tests run in worker processes, which inherit the runner's
 * environment, so the web app's address travels as DEMO_WEB_URL.
 *
 * `pnpm demo:portfolio:verify` uses the same setup, its config's `metadata.demoProfile` set to
 * 'portfolio': the run then starts as `pnpm demo:portfolio` starts it, and the showcase voyage
 * (its id and reference only) travels as DEMO_SHOWCASE.
 */
export default async function globalSetup(config: FullConfig): Promise<() => Promise<void>> {
  const onStep = (step: string) => {
    console.log(`[demo] ${step}`);
  };
  const portfolio = config.metadata.demoProfile === 'portfolio';
  const run = portfolio
    ? await startDemo({ onStep, prepare: PORTFOLIO_PROFILE })
    : await startDemo({ onStep });
  const { container, runRoot } = run.resources;
  console.log(`[demo] Ready at ${run.webUrl}: container ${container}, directory ${runRoot}`);
  process.env.DEMO_WEB_URL = run.webUrl;
  if (run.prepared !== undefined) {
    const { reference, voyageId } = run.prepared;
    console.log(`[demo] Showcase ${reference}: ${run.webUrl}/voyages/${voyageId}`);
    process.env.DEMO_SHOWCASE = JSON.stringify(run.prepared);
  }

  return async () => {
    await run.stop();
    console.log(`[demo] Stopped; removed container ${container} and ${runRoot}`);
    // A server that died mid-run fails the run, even if the walkthrough had already passed.
    if (run.unexpectedExit !== undefined) throw new Error(run.unexpectedExit);
  };
}
