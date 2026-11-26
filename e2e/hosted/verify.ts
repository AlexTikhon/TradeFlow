import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { type HostedInputs, InputError, parseInputs, USAGE } from './inputs.js';
import { runSuite } from './suite.js';

/*
 * `pnpm hosted:verify --origin https://<host> …`: the hosted verification of one environment.
 * See docs/hosted-verification.md. Exit status: 0 passed, 1 a check failed, 2 invalid inputs.
 */

function readInputs(): HostedInputs {
  try {
    const parsed = parseInputs(process.argv.slice(2), process.env, (path) =>
      readFileSync(path, 'utf8'),
    );
    if (parsed.resultsFile && existsSync(parsed.resultsFile))
      throw new InputError('--results must name a new file; earlier evidence is never overwritten');
    return parsed;
  } catch (error) {
    if (!(error instanceof InputError)) throw error;
    console.error(`hosted:verify: ${error.message}\n\n${USAGE}`);
    process.exit(2);
  }
}

const inputs = readInputs();

// Operator confirmation of the restart, read line by line from standard input.
const lines: string[] = [];
const waiters: (() => void)[] = [];
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  lines.push(line.trim().toLowerCase());
  for (const wake of waiters.splice(0)) wake();
});
let inputClosed = false;
input.on('close', () => {
  inputClosed = true;
  for (const wake of waiters.splice(0)) wake();
});

const waitForRestart = async (timeoutMs: number) => {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const line = lines.shift();
    if (line === 'restarted') return;
    if (line === 'abort') throw new Error('The operator aborted at the restart checkpoint');
    if (line !== undefined) {
      console.log('Type "restarted" once the API restart has completed, or "abort".');
      continue;
    }
    if (inputClosed) throw new Error('Standard input closed before the restart was confirmed');
    const remaining = until - Date.now();
    if (remaining <= 0)
      throw new Error(`The restart was not confirmed within ${String(timeoutMs / 60_000)} minutes`);
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, remaining);
      waiters.push(() => {
        clearTimeout(timer);
        resolve();
      });
    });
  }
};

console.log(
  `hosted:verify ${inputs.mode} run against ${inputs.origin} (${inputs.trust.kind === 'public' ? 'public certificate verification' : 'local mock CA'})`,
);
const results = await runSuite(
  inputs,
  {
    log: (line) => {
      console.log(line);
    },
    waitForRestart,
  },
  (path) => readFileSync(path, 'utf8'),
);
input.close();

const width = Math.max(...results.checks.map(({ id }) => id.length));
console.log(`\nResults (${results.outcome}):`);
for (const { id, outcome, durationMs } of results.checks)
  console.log(
    `  ${id.padEnd(width)}  ${outcome.toUpperCase().padEnd(7)}${durationMs === undefined ? '' : `  ${String(durationMs)} ms`}`,
  );
if (inputs.resultsFile) {
  // Identifiers, statuses, timings and hashes only. A new file: never overwrite earlier evidence.
  writeFileSync(inputs.resultsFile, `${JSON.stringify(results, null, 2)}\n`, { flag: 'wx' });
  console.log(`Results written to ${inputs.resultsFile}`);
}
process.exitCode = results.outcome === 'passed' ? 0 : 1;
