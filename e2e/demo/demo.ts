import { createInterface } from 'node:readline';
import { ANA, DEMO_PASSWORD, EMRE, LUCIA, WEI_LING } from './accounts.js';
import { type DemoRun, startDemo } from './demo-run.js';

/*
 * `pnpm demo`: starts a fresh, isolated demo (demo-run.ts), prints where to open it and who to
 * sign in as, and keeps it running until Ctrl+C (or `q` and Enter). Stopping, a failed startup
 * and a server exiting on its own all end the same way: the servers stopped, the container and
 * the temporary directory removed, and any cleanup failure printed with how to finish it by hand.
 */

const STOP_SIGNALS: NodeJS.Signals[] = ['SIGINT', 'SIGTERM', 'SIGHUP'];
if (process.platform === 'win32') STOP_SIGNALS.push('SIGBREAK');

const say = (text = '') => {
  console.log(text);
};

const startup = new AbortController();
let requestStop: (reason: string) => void = () => undefined;
const stopRequested = new Promise<string>((resolve) => {
  requestStop = resolve;
});
let stopping = false;

function onStopRequest(reason: string): void {
  if (stopping) {
    say('Already stopping; cleanup is bounded and will finish shortly.');
    return;
  }
  stopping = true;
  startup.abort();
  requestStop(reason);
}

for (const signal of STOP_SIGNALS) {
  process.on(signal, () => {
    onStopRequest(signal);
  });
}
// `terminal: false`: the terminal keeps handling Ctrl+C, which reaches this process as SIGINT.
const input = createInterface({ input: process.stdin, terminal: false });
input.on('line', (line) => {
  if (['q', 'quit', 'stop'].includes(line.trim().toLowerCase())) onStopRequest('q');
});

function printReady(run: DemoRun): void {
  const { resources } = run;
  const account = (role: string, party: typeof ANA) =>
    `  ${role.padEnd(8)} ${party.fullName.padEnd(15)} ${party.email.padEnd(38)} ${party.organizationName}`;
  say();
  say('TradeFlow demo is ready.');
  say();
  say(`  Open        ${run.webUrl}/voyages`);
  say(`  Password    ${DEMO_PASSWORD} (every seeded user)`);
  say(account('Seller', ANA));
  say(account('Buyer', WEI_LING));
  say(account('F8', EMRE));
  say(account('Outsider', LUCIA));
  say('  Walkthrough docs/demo.md, "Walkthrough 2: a fresh voyage" (steps F1 to F8);');
  say('              use two browser profiles, one per account.');
  say();
  say('  Owned by this run, removed when it stops:');
  say(
    `    container   ${resources.container} (PostgreSQL 18 on 127.0.0.1:${resources.databasePort})`,
  );
  say(`    directory   ${resources.runRoot} (builds, documents, server logs)`);
  say(
    `    processes   API ${String(resources.apiPid)} on 127.0.0.1:${resources.apiPort}, web server ${String(resources.webPid)}`,
  );
  say('  If this terminal is killed before it can clean up, remove them by hand:');
  for (const step of run.recovery) say(`    ${step}`);
  say();
  say('Press Ctrl+C to stop (or type q and press Enter). Nothing of this run is kept.');
}

async function main(): Promise<number> {
  say('TradeFlow local demo');
  say();
  say('  Every run starts fresh and is thrown away when it stops: a new PostgreSQL 18 container,');
  say('  migrated and seeded with the demo data, and a new temporary directory for the builds and');
  say('  uploaded documents. Nothing is kept. Your DATABASE_URL, .env files, development and test');
  say('  databases, containers and running servers are not used or touched.');
  say();

  let run: DemoRun;
  try {
    run = await startDemo({
      signal: startup.signal,
      onStep: (step) => {
        say(`  - ${step}`);
      },
    });
  } catch (error) {
    say();
    say(error instanceof Error ? error.message : String(error));
    say(stopping ? 'Stopped during startup.' : 'The demo could not start.');
    say('Everything this run created has been removed, unless reported otherwise above.');
    return stopping ? 130 : 1;
  }

  printReady(run);
  const failure = await Promise.race([stopRequested.then(() => undefined), run.serverExit]);
  stopping = true;
  say();
  if (failure !== undefined) {
    say(failure);
    say();
    say('The demo cannot continue without it. Stopping.');
  } else {
    say('Stopping the demo.');
  }
  try {
    await run.stop();
  } catch (error) {
    say(error instanceof Error ? error.message : String(error));
    return 1;
  }
  say(`Stopped. Removed container ${run.resources.container} and ${run.resources.runRoot}.`);
  return failure === undefined ? 0 : 1;
}

const code = await main();
input.close();
process.exit(code);
