import { spawn } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { startMock } from '../deploy/mock-run.js';
import { verifiedLeafSpki } from '../deploy/tls.js';
import { ENVIRONMENT } from './inputs.js';
import { CHECKPOINT_LINE, type Results } from './suite.js';

/*
 * `pnpm hosted:rehearse-mock [--evidence <new-file>]`: proves the hosted tooling locally, end to
 * end, against a disposable deployment mock (docs/hosted-verification.md#local-rehearsal). It
 * follows the operator runbook with local substitutes:
 *
 *   1. mock without the demo seed; verification accounts through the controlled fixture tool;
 *   2. the hosted suite (public-trust code path, local CA only) with the restart done here,
 *      outside the browser test, on this run's one API container;
 *   3. paired backup: writers stopped, reconcile, pg_dump, object export, checksums;
 *   4. restore into a separate empty database and bucket, behind the identity guards, reconcile,
 *      then the one API pointed at the restored stores and the suite's restored mode.
 *
 * Everything it creates belongs to this run's random Compose project or temporary directory and
 * is removed at the end, on success or failure.
 */

const repo = fileURLToPath(new URL('../../', import.meta.url));
const e2e = fileURLToPath(new URL('../', import.meta.url));
const SOURCE = { database: 'tradeflow_mock', bucket: 'tradeflow-mock' };
const RESTORE = { database: 'tradeflow_restore', bucket: 'tradeflow-restore' };
const PREFIX = 'tradeflow/';

const args = process.argv.slice(2);
if (args.length && (args.length !== 2 || args[0] !== '--evidence' || !args[1])) {
  console.error('Usage: hosted:rehearse-mock [--evidence <new-file>]');
  process.exit(2);
}
const evidenceFile = args[1];

const controller = new AbortController();
process.once('SIGINT', () => {
  controller.abort();
});
process.once('SIGTERM', () => {
  controller.abort();
});

const log = (message: string) => {
  console.log(`[rehearsal] ${message}`);
};
const timings: Record<string, number> = {};
const timed = async <T>(name: string, step: () => Promise<T>): Promise<T> => {
  log(name);
  const started = Date.now();
  const value = await step();
  timings[name] = Date.now() - started;
  return value;
};
const sha256File = async (path: string) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
};

const run = await startMock(log, controller.signal, { demoSeed: false });
const work = await mkdtemp(join(tmpdir(), `${run.project}-rehearsal-`));
const recovery = Object.fromEntries(
  (await readFile(run.recoveryFile, 'utf8'))
    .trim()
    .split('\n')
    .map((line) => {
      const index = line.indexOf('=');
      return [line.slice(0, index), JSON.parse(line.slice(index + 1)) as string];
    }),
);
const generated = [
  recovery.MOCK_DATABASE_PASSWORD ?? '',
  recovery.MOCK_ACCESS_KEY ?? '',
  recovery.MOCK_SECRET_KEY ?? '',
];
const passwords = {
  seller: randomBytes(18).toString('base64url'),
  buyer: randomBytes(18).toString('base64url'),
  outsider: randomBytes(18).toString('base64url'),
};
const redact = (text: string) => {
  let output = text;
  for (const secret of [...generated, ...Object.values(passwords)])
    if (secret) output = output.replaceAll(secret, '[redacted]');
  return output;
};

/** The caller's environment without anything that could redirect Compose or the suite. */
const cleanEnv = () =>
  Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('MOCK_') && !key.startsWith('TRADEFLOW_VERIFY_'),
    ),
  );

interface RunOptions {
  env?: Record<string, string | undefined>;
  input?: string;
  stdinFile?: string;
  stdoutFile?: string;
  cwd?: string;
  /** Exit codes other than 0 resolve instead of rejecting. */
  allowFailure?: boolean;
}

function execute(command: string, commandArgs: string[], options: RunOptions = {}) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(command, commandArgs, {
      cwd: options.cwd ?? repo,
      env: options.env ?? cleanEnv(),
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    // A file output counts as done only once it is flushed, not when the process exits.
    let flushed: Promise<void> = Promise.resolve();
    if (options.stdoutFile) {
      const file = createWriteStream(options.stdoutFile, { mode: 0o600, flags: 'wx' });
      flushed = new Promise((done, fail) => {
        file.once('finish', done);
        file.once('error', fail);
      });
      child.stdout.pipe(file);
    } else
      child.stdout.on('data', (bytes: Buffer) => {
        stdout = (stdout + bytes.toString()).slice(-64_000);
      });
    child.stderr.on('data', (bytes: Buffer) => {
      stderr = (stderr + bytes.toString()).slice(-16_000);
    });
    child.once('error', reject);
    if (options.stdinFile) createReadStream(options.stdinFile).pipe(child.stdin);
    else child.stdin.end(options.input ?? '');
    child.once('close', (code) => {
      const result = { code: code ?? -1, stdout: redact(stdout), stderr: redact(stderr) };
      const settle = () => {
        if (result.code === 0 || options.allowFailure) resolve(result);
        else
          reject(
            new Error(
              `${command} ${commandArgs.slice(0, 6).join(' ')} … exited ${String(code)}:\n${result.stderr}\n${result.stdout.slice(-4_000)}`,
            ),
          );
      };
      flushed.then(settle, reject);
    });
  });
}

const composeBase = [
  'compose',
  '--project-name',
  run.project,
  '--env-file',
  run.recoveryFile,
  '--file',
  'deploy/mock/compose.yml',
];
/** Compose for this run only. `targets` repoints the API/tools at the restored stores. */
const compose = (composeArgs: string[], options: RunOptions & { targets?: typeof RESTORE } = {}) =>
  execute('docker', [...composeBase, ...composeArgs], {
    ...options,
    env: {
      ...cleanEnv(),
      ...(options.targets && {
        MOCK_DATABASE_NAME: options.targets.database,
        MOCK_S3_BUCKET: options.targets.bucket,
      }),
      ...options.env,
    },
  });

/** The storage maintenance CLI from the tools image, against `targets`' database and bucket. */
const storageTool = (
  toolArgs: string[],
  targets: typeof SOURCE,
  options: RunOptions & { mount?: string } = {},
) =>
  compose(
    [
      'run',
      '--rm',
      '--no-deps',
      '-T',
      ...(process.getuid && process.getgid
        ? ['--user', `${process.getuid()}:${process.getgid()}`]
        : []),
      ...(options.mount ? ['--volume', options.mount] : []),
      '-e',
      'DOCUMENT_STORAGE_DRIVER=s3',
      '-e',
      `S3_BUCKET=${targets.bucket}`,
      '-e',
      'S3_REGION=us-east-1',
      '-e',
      'S3_ENDPOINT=http://s3:8333',
      '-e',
      'S3_FORCE_PATH_STYLE=true',
      '-e',
      `S3_PREFIX=${PREFIX}`,
      // Values come from this process's environment, never from the command line.
      '-e',
      'AWS_ACCESS_KEY_ID',
      '-e',
      'AWS_SECRET_ACCESS_KEY',
      'tools',
      'node',
      '--import',
      'tsx',
      'scripts/document-objects.ts',
      ...toolArgs,
    ],
    {
      ...options,
      targets,
      env: {
        AWS_ACCESS_KEY_ID: recovery.MOCK_ACCESS_KEY,
        AWS_SECRET_ACCESS_KEY: recovery.MOCK_SECRET_KEY,
      },
    },
  );

const apiContainers = async (running: boolean) =>
  (
    await execute('docker', [
      'ps',
      ...(running ? [] : ['--all']),
      '--quiet',
      '--filter',
      `label=com.docker.compose.project=${run.project}`,
      '--filter',
      'label=com.docker.compose.service=api',
      '--filter',
      'label=com.docker.compose.oneoff=False',
    ])
  ).stdout
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const waitHealthy = async () => {
  const until = Date.now() + 120_000;
  for (;;) {
    const answer = await run.request('/api/health').catch(() => ({ status: 0 }));
    if (answer.status === 200) return;
    if (Date.now() > until) throw new Error('The API did not become ready through the edge');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
};

const trustFile = join(work, 'local-mock-trust.json');
const verifierEnv = () => ({
  ...cleanEnv(),
  [ENVIRONMENT.seller.email]: 'seller@verification.tradeflow.example',
  [ENVIRONMENT.seller.password]: passwords.seller,
  [ENVIRONMENT.buyer.email]: 'buyer@verification.tradeflow.example',
  [ENVIRONMENT.buyer.password]: passwords.buyer,
  [ENVIRONMENT.outsider.email]: 'outsider@verification.tradeflow.example',
  [ENVIRONMENT.outsider.password]: passwords.outsider,
});

/** The suite as its own process, exactly as an operator runs it; this answers its checkpoint. */
function hostedVerify(suiteArgs: string[], onCheckpoint?: () => Promise<void>) {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        '--import',
        'tsx',
        'hosted/verify.ts',
        '--origin',
        run.baseURL,
        '--local-mock-trust',
        trustFile,
        ...suiteArgs,
      ],
      { cwd: e2e, env: verifierEnv(), windowsHide: true, stdio: ['pipe', 'pipe', 'inherit'] },
    );
    const abort = () => child.kill();
    controller.signal.addEventListener('abort', abort, { once: true });
    createInterface({ input: child.stdout }).on('line', (line) => {
      console.log(`  [suite] ${redact(line)}`);
      if (line === CHECKPOINT_LINE) {
        if (!onCheckpoint) {
          child.stdin.write('abort\n');
          return;
        }
        onCheckpoint().then(
          () => child.stdin.write('restarted\n'),
          (error: unknown) => {
            console.error(
              `[rehearsal] Restart failed: ${error instanceof Error ? error.message : 'unknown'}`,
            );
            child.stdin.write('abort\n');
          },
        );
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      controller.signal.removeEventListener('abort', abort);
      if (code === 0) resolve();
      else reject(new Error(`hosted:verify ${suiteArgs.join(' ')} exited ${String(code)}`));
    });
  });
}

let failed = true;
try {
  const confirm = `postgres:5432/${SOURCE.database}`;
  await timed('fixtures', async () => {
    const fixture = (target: string) =>
      compose(
        [
          'run',
          '--rm',
          '--no-deps',
          '-T',
          'tools',
          'node',
          '--import',
          'tsx',
          'scripts/verification-fixtures.ts',
          '--confirm-database',
          target,
        ],
        { input: JSON.stringify(passwords), allowFailure: true },
      );
    const wrongTarget = await fixture('postgres:5432/some_other_database');
    if (wrongTarget.code === 0 || !wrongTarget.stderr.includes('not at the confirmed target'))
      throw new Error('The fixture tool did not refuse an unconfirmed target');
    const prepared = await fixture(confirm);
    if (prepared.code !== 0) throw new Error(`Fixture preparation failed:\n${prepared.stderr}`);
    const users = await compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'tradeflow',
      '-d',
      SOURCE.database,
      '-Atc',
      'SELECT count(*) FROM users',
    ]);
    if (users.stdout.trim() !== '3')
      throw new Error('Expected exactly the three verification users');
  });

  await timed('local trust', async () => {
    const spki = await verifiedLeafSpki(run.baseURL, run.ca);
    await writeFile(
      trustFile,
      JSON.stringify({ ca: run.ca.toString(), spki, httpOrigin: run.httpURL }),
      {
        mode: 0o600,
      },
    );
  });

  const fullResults = join(work, 'results-full.json');
  const restart: Record<string, number | string> = {};
  await timed('hosted suite, full run with API restart', () =>
    hostedVerify(['--results', fullResults, '--restart-timeout', '10'], async () => {
      // Outside the browser test, scoped to this run's one API container, as on a host.
      const before = await apiContainers(true);
      if (before.length !== 1)
        throw new Error(`Expected one running API container, found ${before.length}`);
      const [id] = before;
      const started = Date.now();
      await execute('docker', ['restart', '--timeout', '20', id ?? '']);
      await waitHealthy();
      const after = await apiContainers(true);
      if (after.length !== 1 || after[0] !== id)
        throw new Error('Not the same single API container after restart');
      restart.container = id ?? '';
      restart.restartToReadyMs = Date.now() - started;
      log(
        `API container ${id ?? ''} restarted; ready after ${String(restart.restartToReadyMs)} ms`,
      );
    }),
  );
  const full = JSON.parse(await readFile(fullResults, 'utf8')) as Results;

  const backup = join(work, 'backup');
  const writersStoppedAt = new Date().toISOString();
  await timed('stop writers', async () => {
    await compose(['stop', '--timeout', '20', 'api']);
    if ((await apiContainers(true)).length) throw new Error('An API container is still running');
  });
  const sourceReport = await timed('reconcile source', () => storageTool(['verify'], SOURCE));
  await timed('export database', async () => {
    // A new private directory; the dump streams out of the database container into it.
    await mkdir(backup, { mode: 0o700 });
    await compose(
      [
        'exec',
        '-T',
        'postgres',
        'pg_dump',
        '-U',
        'tradeflow',
        '-d',
        SOURCE.database,
        '--format=custom',
        '--no-owner',
        '--no-acl',
      ],
      { stdoutFile: join(backup, 'database.dump') },
    );
  });
  await timed('export objects', () =>
    storageTool(['export', '/backup/objects'], SOURCE, { mount: `${backup}:/backup` }),
  );
  const source = JSON.parse(await readFile(join(backup, 'objects', 'source.json'), 'utf8')) as {
    exportedAt: string;
    recoveryPoint: Record<string, unknown>;
  };
  const checksums = {
    'database.dump': await sha256File(join(backup, 'database.dump')),
    'objects/manifest.json': await sha256File(join(backup, 'objects', 'manifest.json')),
    'objects/source.json': await sha256File(join(backup, 'objects', 'source.json')),
  };

  const restoreStarted = Date.now();
  await timed('create empty restore targets', async () => {
    await compose([
      'exec',
      '-T',
      'postgres',
      'psql',
      '-U',
      'tradeflow',
      '-d',
      'postgres',
      '-v',
      'ON_ERROR_STOP=1',
      '-c',
      `CREATE DATABASE ${RESTORE.database}`,
    ]);
    await compose(
      [
        'run',
        '--rm',
        '--no-deps',
        '-T',
        '-e',
        'S3_ACCESS',
        '-e',
        'S3_SECRET',
        '--entrypoint',
        'node',
        'tools',
        '--input-type=module',
        '-e',
        `import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3'; const c=new S3Client({endpoint:'http://s3:8333',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS,secretAccessKey:process.env.S3_SECRET}});await c.send(new CreateBucketCommand({Bucket:'${RESTORE.bucket}'}));c.destroy();`,
      ],
      { env: { S3_ACCESS: recovery.MOCK_ACCESS_KEY, S3_SECRET: recovery.MOCK_SECRET_KEY } },
    );
  });
  const guards = await timed('target identity guards', async () => {
    const onSource = await storageTool(['restore-check', '/backup/objects'], SOURCE, {
      mount: `${backup}:/backup:ro`,
      allowFailure: true,
    });
    if (onSource.code === 0 || !onSource.stderr.includes('Refusing to restore'))
      throw new Error('restore-check did not refuse the source');
    const onTarget = await storageTool(['restore-check', '/backup/objects'], RESTORE, {
      mount: `${backup}:/backup:ro`,
    });
    const checked = JSON.parse(onTarget.stdout) as { refusals: string[]; target: unknown };
    if (checked.refusals.length) throw new Error('restore-check refused the empty targets');
    return {
      refusedSource: onSource.stderr.trim().split('\n').pop() ?? '',
      target: checked.target,
    };
  });
  await timed('restore database', () =>
    compose(
      [
        'exec',
        '-T',
        'postgres',
        'pg_restore',
        '-U',
        'tradeflow',
        '-d',
        RESTORE.database,
        '--exit-on-error',
        '--no-owner',
        '--no-acl',
      ],
      { stdinFile: join(backup, 'database.dump') },
    ),
  );
  await timed('import objects', () =>
    storageTool(['import', '/backup/objects'], RESTORE, { mount: `${backup}:/backup:ro` }),
  );
  const restoredReport = await timed('reconcile restored', () => storageTool(['verify'], RESTORE));
  await timed('start the one API on the restored stores', async () => {
    await compose(
      ['up', '--detach', '--wait', '--wait-timeout', '90', '--no-deps', '--force-recreate', 'api'],
      {
        targets: RESTORE,
      },
    );
    if ((await apiContainers(true)).length !== 1)
      throw new Error('Expected exactly one running API');
    await waitHealthy();
  });
  const restoredResults = join(work, 'results-restored.json');
  await timed('hosted suite, restored mode', () =>
    hostedVerify(['--mode', 'restored', '--expect', fullResults, '--results', restoredResults]),
  );
  const restoreElapsedMs = Date.now() - restoreStarted;
  const restored = JSON.parse(await readFile(restoredResults, 'utf8')) as Results;

  const evidence = {
    format: 'tradeflow-hosted-rehearsal/1',
    environment: 'local deployment mock (not AWS)',
    project: run.project,
    finishedAt: new Date().toISOString(),
    hostedSuite: {
      full: full.outcome,
      restored: restored.outcome,
      checks: { full: full.checks, restored: restored.checks },
      restart: { ...full.restart, ...restart },
    },
    recovery: {
      writersStoppedAt,
      backupExportedAt: source.exportedAt,
      recoveryPoint: source.recoveryPoint,
      checksums,
      sourceReconcile: JSON.parse(sourceReport.stdout) as unknown,
      restoredReconcile: JSON.parse(restoredReport.stdout) as unknown,
      guards,
      restoreElapsedMs,
    },
    timingsMs: timings,
  };
  console.log(JSON.stringify(evidence, null, 2));
  if (evidenceFile) {
    await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    log(`Evidence written to ${evidenceFile}`);
  }
  log(
    `Passed. Restore to verified API: ${String(restoreElapsedMs)} ms (local mock; not an AWS measurement)`,
  );
  failed = false;
} catch (error) {
  console.error(
    `[rehearsal] Failed: ${redact(error instanceof Error ? error.message : 'unknown error')}`,
  );
  await run.collectDiagnostics(
    `Hosted rehearsal failed: ${redact(error instanceof Error ? error.message : 'unknown error').slice(0, 2_000)}`,
  );
} finally {
  await run.stop().catch((error: unknown) => {
    console.error(
      `[rehearsal] Cleanup failed; recover with ${run.recoveryFile}: ${redact(String(error))}`,
    );
  });
  await rm(work, { recursive: true, force: true });
  log("Removed this run's containers, volumes, images and temporary files");
}
process.exitCode = failed ? 1 : 0;
