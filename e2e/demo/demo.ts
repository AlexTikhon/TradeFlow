import { createInterface } from 'node:readline';
import { ANA, DEMO_PASSWORD, EMRE, LUCIA, RAFAEL, WEI_LING } from './accounts.js';
import { type DemoRun, startDemo } from './demo-run.js';
import {
  PORTFOLIO_PROFILE,
  PORTFOLIO_WRITE_ALLOWANCE,
  SHOWCASE_REASONS,
  type Showcase,
} from './portfolio.js';

/*
 * `pnpm demo`: starts a fresh, isolated demo (demo-run.ts), prints where to open it and who to
 * sign in as, and keeps it running until Ctrl+C (or `q` and Enter). Stopping, a failed startup
 * and a server exiting on its own all end the same way: the servers stopped, the container and
 * the temporary directory removed, and any cleanup failure printed with how to finish it by hand.
 *
 * `pnpm demo:portfolio` (`--portfolio`) is the same run with one more startup step: the portfolio
 * showcase voyage, built through the API (portfolio.ts). Without the argument nothing changes.
 */

const args = process.argv.slice(2);
const portfolio = args.includes('--portfolio');
const unknown = args.filter((arg) => arg !== '--portfolio');
if (unknown.length > 0) {
  console.error(`Unknown argument ${unknown.join(' ')}. Usage: demo.ts [--portfolio]`);
  process.exit(2);
}

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

const account = (role: string, party: typeof ANA) =>
  `  ${role.padEnd(8)} ${party.fullName.padEnd(15)} ${party.email.padEnd(38)} ${party.organizationName}`;

/** The showcase: where it is, who to sign in as, and what each document shows. */
function printShowcase(webUrl: string, showcase: Showcase): void {
  say(`  Showcase    ${showcase.reference}: ${webUrl}/voyages/${showcase.voyageId}`);
  say(`  Password    ${DEMO_PASSWORD} (every seeded user)`);
  say(account('Seller', ANA));
  say(account('Buyer', WEI_LING));
  say(account('Viewer', RAFAEL));
  say(account('Outsider', LUCIA));
  say(`  On ${showcase.reference}, Ana sells to Wei Ling (contract 1). Wei Ling's instructions,`);
  say('  revision 1, were acknowledged by Ana and require four documents:');
  say('    Commercial invoice     not uploaded yet');
  say("    Certificate of origin  version 1 awaits Wei Ling's review (her Action Center)");
  say('    Weight certificate     version 1 rejected; Ana must replace it (her Action Center):');
  say(`                           "${SHOWCASE_REASONS.weightCertificate}"`);
  say('    Bill of lading         version 1 rejected, version 2 approved; both kept, with');
  say('                           their decisions, under "Earlier versions"');
  say("  Rafael (Ana's colleague) reads it all without write controls; Lucía cannot open it.");
  const left = PORTFOLIO_WRITE_ALLOWANCE - showcase.commands;
  say(
    `  Changes     ${PORTFOLIO_WRITE_ALLOWANCE} per run, shared by every account (the showcase used ${showcase.commands}; ${left} left).`,
  );
  say('              Once used up, changes are refused until the demo is reset; reading,');
  say('              downloads and signing in and out still work.');
  say('              Reset: stop this run (Ctrl+C or q), then start pnpm demo:portfolio again.');
  say('  The sign-in page offers these accounts; the in-app Demo guide links here.');
  say('  More: docs/demo.md, "The portfolio showcase". Use one browser profile per account.');
}

function printReady(run: DemoRun<Showcase | undefined>): void {
  const { resources } = run;
  say();
  say('TradeFlow demo is ready.');
  say();
  if (run.prepared === undefined) {
    say(`  Open        ${run.webUrl}/voyages`);
    say(`  Password    ${DEMO_PASSWORD} (every seeded user)`);
    say(account('Seller', ANA));
    say(account('Buyer', WEI_LING));
    say(account('F8', EMRE));
    say(account('Outsider', LUCIA));
    say('  Walkthrough docs/demo.md, "Walkthrough 2: a fresh voyage" (steps F1 to F8);');
    say('              use two browser profiles, one per account.');
  } else {
    printShowcase(run.webUrl, run.prepared);
  }
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
  if (portfolio) {
    say('  Portfolio profile: after seeding, one more voyage is prepared through the API, with');
    say(
      `  its document workflow under way, and the API admits at most ${PORTFOLIO_WRITE_ALLOWANCE}`,
    );
    say('  business commands in this run.');
  }
  say();

  let run: DemoRun<Showcase | undefined>;
  try {
    const onStep = (step: string) => {
      say(`  - ${step}`);
    };
    run = portfolio
      ? await startDemo({ signal: startup.signal, onStep, prepare: PORTFOLIO_PROFILE })
      : await startDemo({ signal: startup.signal, onStep });
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
