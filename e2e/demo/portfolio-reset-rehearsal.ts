import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { DocumentListResponseSchema, VoyageListResponseSchema } from '@tradeflow/contracts';
import { LUCIA, WEI_LING } from './accounts.js';
import { type DemoRun, startDemo } from './demo-run.js';
import { PORTFOLIO_PROFILE, PORTFOLIO_WRITE_ALLOWANCE, type Showcase } from './portfolio.js';
import { DemoClient, useUpWriteBudget } from './write-budget.js';

/*
 * `pnpm demo:portfolio:rehearse-reset`: the operator's reset of a portfolio demo (docs/demo.md,
 * "Resetting the portfolio demo") rehearsed end to end, with the code `pnpm demo:portfolio` runs:
 *
 * 1. Start run A. Use up its write budget as a visitor would (through the web origin), and check
 *    that reading and signing out still work.
 * 2. Stop A, as Ctrl+C does. Check that its container, temporary directory and servers are gone.
 * 3. Start run B, which prepares the showcase again (startup fails if any of it differs). Check
 *    that A's changes are gone, the showcase reads as prepared, and B admits exactly the
 *    allowance left after its own preparation: a fresh budget.
 * 4. Stop B and check the same as for A.
 *
 * It creates nothing but its two runs, each removed by its own stop, pass or fail; it never
 * touches DATABASE_URL, a development database or object storage. Exits 1 on the first failed
 * check, 130 if interrupted.
 */

const say = (text = '') => {
  console.log(text);
};

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Reset rehearsal: ${message}`);
  say(`  ok  ${message}`);
}

const interrupted = new AbortController();
let current: DemoRun<Showcase> | undefined;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    say(`\n${signal}: stopping.`);
    // Aborts a startup in progress; a run already up is stopped here, then the process exits.
    interrupted.abort();
    const run = current;
    if (run !== undefined) {
      void run.stop().finally(() => process.exit(130));
    }
  });
}

async function start(name: string): Promise<DemoRun<Showcase>> {
  say(`\nStarting run ${name} (as pnpm demo:portfolio does)`);
  const run = await startDemo({
    signal: interrupted.signal,
    onStep: (step) => {
      say(`  - ${step}`);
    },
    prepare: PORTFOLIO_PROFILE,
  });
  current = run;
  const { container, runRoot } = run.resources;
  say(`  Run ${name}: ${run.webUrl}, container ${container}, directory ${runRoot}`);
  say(`  Showcase ${run.prepared.reference} (${run.prepared.voyageId})`);
  return run;
}

/** Stops `run` as Ctrl+C does, and checks that what it owned is gone. */
async function stop(name: string, run: DemoRun<Showcase>): Promise<void> {
  const { container, runRoot, apiPort } = run.resources;
  say(`\nStopping run ${name}`);
  await run.stop();
  current = undefined;
  check(run.unexpectedExit === undefined, `run ${name}'s servers did not exit on their own`);
  const inspect = spawnSync('docker', ['container', 'inspect', container], {
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30_000,
  });
  check(
    inspect.status !== 0 && /no such (container|object)/i.test(inspect.stderr),
    `run ${name}'s container ${container} is removed`,
  );
  check(!existsSync(runRoot), `run ${name}'s directory ${runRoot} is removed`);
  for (const [server, url] of [
    ['API', `http://127.0.0.1:${apiPort}/api/health`],
    ['web server', `${run.webUrl}/sign-in`],
  ] as const) {
    const answered = await fetch(url, { signal: AbortSignal.timeout(5_000) }).then(
      () => true,
      () => false,
    );
    check(!answered, `run ${name}'s ${server} no longer answers`);
  }
}

async function voyagesOf(client: DemoClient): Promise<number> {
  return VoyageListResponseSchema.parse(await client.readJson('/api/voyages')).items.length;
}

async function main(): Promise<number> {
  say('Rehearsing the portfolio demo reset: stop the run, start a fresh one.');
  const a = await start('A');
  const lucia = await DemoClient.signIn(a.webUrl, LUCIA);
  const seeded = await voyagesOf(lucia);
  const usedA = await useUpWriteBudget(lucia, PORTFOLIO_WRITE_ALLOWANCE);
  check(
    usedA.admitted === PORTFOLIO_WRITE_ALLOWANCE - a.prepared.commands,
    `run A admitted ${usedA.admitted} commands after the showcase's ${a.prepared.commands}, then refused`,
  );
  check(
    usedA.refusal.problem?.type === '/problems/demo-write-budget-exhausted' &&
      usedA.refusal.retryAfter === null,
    "run A's refusal is the demo's 429, without Retry-After",
  );
  check(
    (await voyagesOf(lucia)) === seeded + usedA.admitted,
    `run A lists Lucía's ${usedA.admitted} new voyages`,
  );
  check((await lucia.signOut()) === 204, 'signing out still works in run A');
  await stop('A', a);

  const b = await start('B');
  check(
    b.resources.container !== a.resources.container && b.resources.runRoot !== a.resources.runRoot,
    'run B has a container and directory of its own',
  );
  const luciaB = await DemoClient.signIn(b.webUrl, LUCIA);
  check((await voyagesOf(luciaB)) === seeded, "run A's changes are gone: Lucía sees the seed only");
  const wei = await DemoClient.signIn(b.webUrl, WEI_LING);
  const documents = DocumentListResponseSchema.parse(
    await wei.readJson(`/api/voyages/${b.prepared.voyageId}/documents`),
  ).items;
  check(
    documents.length === 3 && b.prepared.reference === a.prepared.reference,
    `run B prepared the showcase again: ${b.prepared.reference}, three documents for Wei Ling`,
  );
  await wei.signOut();
  const usedB = await useUpWriteBudget(luciaB, PORTFOLIO_WRITE_ALLOWANCE);
  check(
    usedB.admitted === PORTFOLIO_WRITE_ALLOWANCE - b.prepared.commands,
    `run B's budget is fresh: it admitted ${usedB.admitted} commands after the showcase's, then refused`,
  );
  await luciaB.signOut();
  await stop('B', b);

  say('\nReset rehearsed: each run removed what it owned, and the fresh run had the showcase');
  say('and a whole allowance.');
  return 0;
}

let code: number;
try {
  code = await main();
} catch (error) {
  say(error instanceof Error ? error.message : String(error));
  if (current !== undefined) {
    say('Stopping the run still up.');
    await current.stop().catch((stopError: unknown) => {
      say(stopError instanceof Error ? stopError.message : String(stopError));
    });
  }
  code = interrupted.signal.aborted ? 130 : 1;
}
process.exit(code);
