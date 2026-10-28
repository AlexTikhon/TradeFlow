import { startDemo } from './demo-run.js';

/*
 * Starts the demo for `pnpm demo:verify` with the same code as `pnpm demo`, and stops it after
 * the walkthrough, pass or fail. Tests run in worker processes, which inherit the runner's
 * environment, so the web app's address travels as DEMO_WEB_URL.
 */
export default async function globalSetup(): Promise<() => Promise<void>> {
  const run = await startDemo({
    onStep: (step) => {
      console.log(`[demo] ${step}`);
    },
  });
  const { container, runRoot } = run.resources;
  console.log(`[demo] Ready at ${run.webUrl}: container ${container}, directory ${runRoot}`);
  process.env.DEMO_WEB_URL = run.webUrl;

  return async () => {
    await run.stop();
    console.log(`[demo] Stopped; removed container ${container} and ${runRoot}`);
    // A server that died mid-run fails the run, even if the walkthrough had already passed.
    if (run.unexpectedExit !== undefined) throw new Error(run.unexpectedExit);
  };
}
