import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, lstatSync, rmSync, unlinkSync } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { freePort, OwnedProcess, runScript, waitUntilServing } from '../support/processes.js';

/*
 * One run of the local demo, used by `pnpm demo` (interactive) and `pnpm demo:verify` (the
 * automated walkthrough). Everything it uses is its own, created fresh and discarded at the end:
 *
 * - a PostgreSQL 18 container with a unique name and this run's label, its data on a tmpfs inside
 *   the container (no volume), published on a loopback port Docker chooses;
 * - a temporary directory from `mkdtemp` holding the API build, the web build, the documents and
 *   the server logs;
 * - the API (`node main.js` from that build) and the web app (`vite preview` of that build, with
 *   the same-origin `/api` proxy), both on loopback ports of their own.
 *
 * The caller's DATABASE_URL, apps/api/.env and the development or test databases are never used:
 * the app's variables are removed from the inherited environment and set explicitly, and the API
 * runs from the temporary build directory, which holds no .env. Each resource is recorded as owned
 * the moment it exists (the container before it is created, under a name checked to be unused),
 * so a run stopped or failing half way removes exactly what it created, newest first.
 *
 * Processes are started directly with argument arrays, never through a shell, and in process
 * groups of their own: a Ctrl+C reaches only the demo, which then stops them itself.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiDir = join(repoRoot, 'apps', 'api');
const webDir = join(repoRoot, 'apps', 'web');

const POSTGRES_IMAGE = 'postgres:18-alpine';
const DATABASE_NAME = 'tradeflow_demo';
const DATABASE_USER = 'tradeflow';
const RUN_ROOT_PREFIX = 'tradeflow-demo-';
/** Carried by the run's container; checked before it is removed. */
const RUN_LABEL = 'io.tradeflow.demo.run';

/**
 * Variables the API, Prisma, the seed and the web server read. None is inherited from the caller:
 * each one the demo needs is set explicitly below.
 */
const APP_VARIABLES = new Set([
  'DATABASE_URL',
  'TEST_DATABASE_URL',
  'E2E_DATABASE_URL',
  'NODE_ENV',
  'PORT',
  'HOST',
  'TRUSTED_PROXY_CIDRS',
  'SESSION_TTL_MINUTES',
  'SIGN_IN_ATTEMPTS_PER_MINUTE',
  'DOCUMENT_STORAGE_DIR',
  'DOCUMENT_STORAGE_DRIVER',
  'S3_BUCKET',
  'S3_REGION',
  'S3_ENDPOINT',
  'S3_PREFIX',
  'S3_FORCE_PATH_STYLE',
  'API_PROXY_TARGET',
]);

function inheritedEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    // Windows variable names are case-insensitive.
    Object.entries(process.env).filter(([name]) => !APP_VARIABLES.has(name.toUpperCase())),
  );
}

/** The Node script of a package's binary, run with the current Node (no shell, no .cmd shims). */
function packageScript(fromDir: string, specifier: string): string {
  return createRequire(join(fromDir, 'package.json')).resolve(specifier);
}

const messageOf = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** The last lines of a log, to show before the log is removed with the run's directory. */
async function tailOf(logFile: string, lines = 25): Promise<string> {
  try {
    const text = (await readFile(logFile, 'utf8')).trimEnd();
    if (text === '') return `(${basename(logFile)} is empty)`;
    return `Last lines of ${basename(logFile)}:\n${text.split(/\r?\n/).slice(-lines).join('\n')}`;
  } catch {
    return `(${basename(logFile)} could not be read)`;
  }
}

// ── Docker ─────────────────────────────────────────────────────────────────────────────────────

interface DockerOptions {
  timeoutMs: number;
  signal?: AbortSignal;
}

/** Runs the Docker CLI with `args` and resolves its trimmed standard output. */
function docker(args: string[], { timeoutMs, signal }: DockerOptions): Promise<string> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn('docker', args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      detached: true,
      timeout: timeoutMs,
      ...(signal !== undefined && { signal }),
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.once('error', (error) => {
      reject(
        signal?.aborted
          ? new Error(`docker ${args[0] ?? ''} was interrupted`)
          : new Error(`docker ${args[0] ?? ''} could not run: ${error.message}`),
      );
    });
    child.once('close', (code, killedBy) => {
      if (code === 0) resolvePromise(stdout.trim());
      else if (signal?.aborted) reject(new Error(`docker ${args[0] ?? ''} was interrupted`));
      else if (killedBy !== null) {
        reject(new Error(`docker ${args.join(' ')} did not finish within ${timeoutMs} ms`));
      } else
        reject(new Error(`docker ${args[0] ?? ''} failed: ${stderr.trim() || `exit ${code}`}`));
    });
  });
}

const isNoSuchContainer = (error: unknown) => /no such (container|object)/i.test(messageOf(error));

/** The run label of container `name`, or undefined if there is no such container. */
async function labelOf(name: string): Promise<string | undefined> {
  try {
    return await docker(
      ['container', 'inspect', '--format', `{{index .Config.Labels "${RUN_LABEL}"}}`, name],
      { timeoutMs: 30_000 },
    );
  } catch (error) {
    if (isNoSuchContainer(error)) return undefined;
    throw error;
  }
}

/** Removes container `name`, with its anonymous volumes, only if it carries `runId`. */
async function removeContainer(name: string, runId: string): Promise<void> {
  const label = await labelOf(name);
  if (label === undefined) return;
  if (label !== runId) {
    throw new Error(`container ${name} does not carry this run's label, so it was left alone`);
  }
  await docker(['rm', '--force', '--volumes', name], { timeoutMs: 60_000 });
  if ((await labelOf(name)) !== undefined) throw new Error(`container ${name} still exists`);
}

/** The same, synchronously: the last resort when the process exits without stopping the run. */
function removeContainerNow(name: string, runId: string): void {
  const inspect = spawnSync(
    'docker',
    ['container', 'inspect', '--format', `{{index .Config.Labels "${RUN_LABEL}"}}`, name],
    { timeout: 15_000, windowsHide: true, encoding: 'utf8' },
  );
  if (inspect.status === 0 && inspect.stdout.trim() === runId) {
    spawnSync('docker', ['rm', '--force', '--volumes', name], { timeout: 30_000 });
  }
}

/** Waits until the database answers a query, failing at once if the container stops. */
async function waitForDatabase(
  databaseUrl: string,
  container: string,
  signal: AbortSignal | undefined,
  timeoutMs = 90_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    signal?.throwIfAborted();
    const client = new pg.Client({ connectionString: databaseUrl, connectionTimeoutMillis: 3_000 });
    // A connection reset while PostgreSQL starts must not become an unhandled 'error' event.
    client.on('error', () => undefined);
    try {
      await client.connect();
      await client.query('SELECT 1');
      return;
    } catch {
      // Not accepting connections yet: the image initializes, then restarts the server.
    } finally {
      await client.end().catch(() => undefined);
    }
    const running = await docker(
      ['container', 'inspect', '--format', '{{.State.Running}}', container],
      {
        timeoutMs: 30_000,
        ...(signal !== undefined && { signal }),
      },
    );
    if (running !== 'true') {
      const logs = await docker(['logs', '--tail', '25', container], { timeoutMs: 30_000 }).catch(
        (error: unknown) => messageOf(error),
      );
      throw new Error(`PostgreSQL container ${container} stopped while starting:\n${logs}`);
    }
    if (Date.now() > deadline) {
      throw new Error(
        `PostgreSQL in ${container} did not accept connections within ${timeoutMs} ms`,
      );
    }
    await delay(500, undefined, signal !== undefined ? { signal } : {});
  }
}

// ── The run's temporary directory ──────────────────────────────────────────────────────────────

/** Throws unless `target` is `root` itself or inside it. */
function assertInside(root: string, target: string): void {
  const path = relative(root, resolve(target));
  if (path.startsWith('..') || isAbsolute(path)) {
    throw new Error(`refusing to remove ${target}: it is outside the run's directory ${root}`);
  }
}

/** Throws unless `root` is a directory this module creates: `<tmpdir>/tradeflow-demo-…`. */
function assertRunRoot(root: string, systemTemp: string): void {
  if (dirname(root) !== systemTemp || !basename(root).startsWith(RUN_ROOT_PREFIX)) {
    throw new Error(
      `refusing to remove ${root}: it is not a ${RUN_ROOT_PREFIX}… temporary directory`,
    );
  }
}

/**
 * Removes the run's directory. The API build reaches its packages through a link to
 * apps/api/node_modules: the link itself is removed first, never what it points to.
 */
async function removeRunRoot(root: string, systemTemp: string, link: string): Promise<void> {
  assertRunRoot(root, systemTemp);
  assertInside(root, link);
  const linkStat = await lstat(link).catch(() => undefined);
  if (linkStat?.isSymbolicLink()) await unlink(link);
  else if (linkStat !== undefined)
    throw new Error(`${link} is not a link; ${root} was left in place`);
  await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  if (existsSync(root)) throw new Error(`${root} still exists`);
}

function removeRunRootNow(root: string, systemTemp: string, link: string): void {
  assertRunRoot(root, systemTemp);
  assertInside(root, link);
  try {
    if (lstatSync(link).isSymbolicLink()) unlinkSync(link);
  } catch {
    // No link yet.
  }
  if (existsSync(link)) return;
  rmSync(root, { recursive: true, force: true, maxRetries: 5 });
}

// ── Ownership ──────────────────────────────────────────────────────────────────────────────────

interface Owned {
  name: string;
  release: () => Promise<void>;
  /** What to do by hand if releasing fails, or the demo is killed before it can. */
  recovery: string;
  /** Synchronous last resort, when the process exits without releasing. */
  releaseNow?: () => void;
}

/** What the run owns, released newest first; every failure is reported with its recovery. */
class Ownership {
  private readonly owned: Owned[] = [];
  private readonly onExit = () => {
    for (const owned of [...this.owned].reverse()) {
      try {
        owned.releaseNow?.();
      } catch {
        // Exiting: nothing more can be done here; the recovery steps were printed at startup.
      }
    }
  };

  constructor() {
    process.once('exit', this.onExit);
  }

  add(owned: Owned): void {
    this.owned.push(owned);
  }

  /** The manual recovery for everything still owned, in release order (newest first). */
  recoverySteps(): string[] {
    return [...this.owned].reverse().map((owned) => owned.recovery);
  }

  async release(): Promise<void> {
    const failures: string[] = [];
    for (const owned of [...this.owned].reverse()) {
      try {
        await owned.release();
      } catch (error) {
        failures.push(
          `- Could not ${owned.name}: ${messageOf(error)}\n  Recover: ${owned.recovery}`,
        );
      }
    }
    this.owned.length = 0;
    process.off('exit', this.onExit);
    if (failures.length > 0) {
      throw new Error(`Cleanup was incomplete:\n${failures.join('\n')}`);
    }
  }
}

// ── The run ────────────────────────────────────────────────────────────────────────────────────

export interface DemoResources {
  runRoot: string;
  container: string;
  databasePort: number;
  apiPort: number;
  apiPid: number | undefined;
  webPid: number | undefined;
}

export interface DemoRun {
  /** The web app's origin: the only address a browser needs. */
  readonly webUrl: string;
  readonly resources: DemoResources;
  /** Manual recovery steps for an uncatchable forced termination, printed at startup. */
  readonly recovery: string[];
  /**
   * Settles with a description (and the server's last log lines) if the API or the web server
   * exits on its own. Never settles for a run stopped first.
   */
  readonly serverExit: Promise<string>;
  /** Set once a server has exited on its own. */
  readonly unexpectedExit: string | undefined;
  /** Stops the servers, removes the container and the temporary directory. Idempotent. */
  stop(): Promise<void>;
}

export interface StartOptions {
  /** Aborts startup (a Ctrl+C): whatever was created so far is removed. */
  signal?: AbortSignal;
  /** Told each step as it begins. */
  onStep?: (step: string) => void;
}

export async function startDemo({
  signal,
  onStep = () => undefined,
}: StartOptions = {}): Promise<DemoRun> {
  const ownership = new Ownership();
  const runId = randomBytes(4).toString('hex');
  const container = `tradeflow-demo-${runId}`;
  // The log of the step in progress, shown if it fails.
  let stepLog: string | undefined;
  // Set before servers are stopped on purpose, so their exit is not reported as a failure.
  let stopping = false;
  try {
    onStep('Checking that the Docker daemon is running');
    await docker(['version', '--format', '{{.Server.Version}}'], {
      timeoutMs: 30_000,
      ...(signal !== undefined && { signal }),
    }).catch((error: unknown) => {
      signal?.throwIfAborted();
      throw new Error(
        `The Docker daemon is not reachable; start Docker and try again.\n${messageOf(error)}`,
      );
    });

    onStep('Creating the temporary directory');
    const systemTemp = await realpath(tmpdir());
    const runRoot = await realpath(await mkdtemp(join(systemTemp, RUN_ROOT_PREFIX)));
    assertRunRoot(runRoot, systemTemp);
    const apiBuild = join(runRoot, 'api');
    const apiModules = join(apiBuild, 'node_modules');
    ownership.add({
      name: `remove the temporary directory ${runRoot}`,
      release: () => removeRunRoot(runRoot, systemTemp, apiModules),
      recovery: runRootRecovery(runRoot, apiModules),
      releaseNow: () => {
        removeRunRootNow(runRoot, systemTemp, apiModules);
      },
    });
    const logsDir = join(runRoot, 'logs');
    const documents = join(runRoot, 'documents');
    await mkdir(logsDir);
    await mkdir(documents);

    if ((await labelOf(container)) !== undefined) {
      throw new Error(`A container named ${container} already exists; it was left alone`);
    }
    const image = await docker(['image', 'inspect', '--format', '{{.Id}}', POSTGRES_IMAGE], {
      timeoutMs: 30_000,
    }).catch(() => undefined);
    if (image === undefined) {
      onStep(`Pulling ${POSTGRES_IMAGE} (first run only)`);
      await docker(['pull', POSTGRES_IMAGE], {
        timeoutMs: 10 * 60_000,
        ...(signal !== undefined && { signal }),
      });
    }

    onStep(`Starting PostgreSQL 18 in container ${container}`);
    const password = randomBytes(18).toString('base64url');
    // Owned from before `docker run`: a container created by a run that then fails is removed too.
    ownership.add({
      name: `remove the container ${container}`,
      release: () => removeContainer(container, runId),
      recovery: `docker rm --force --volumes ${container}`,
      releaseNow: () => {
        removeContainerNow(container, runId);
      },
    });
    await docker(
      [
        'run',
        '--detach',
        '--name',
        container,
        '--label',
        `${RUN_LABEL}=${runId}`,
        '--env',
        `POSTGRES_USER=${DATABASE_USER}`,
        '--env',
        `POSTGRES_PASSWORD=${password}`,
        '--env',
        `POSTGRES_DB=${DATABASE_NAME}`,
        // The data lives in the container's memory: nothing outlives the container.
        '--tmpfs',
        '/var/lib/postgresql',
        // Loopback only, on a port Docker chooses.
        '--publish',
        '127.0.0.1::5432',
        POSTGRES_IMAGE,
      ],
      { timeoutMs: 120_000, ...(signal !== undefined && { signal }) },
    );
    const published = await docker(['port', container, '5432/tcp'], { timeoutMs: 30_000 });
    const match = /^127\.0\.0\.1:(\d+)$/m.exec(published);
    if (!match?.[1]) throw new Error(`Unexpected published address for ${container}: ${published}`);
    const databasePort = Number(match[1]);
    const databaseUrl = `postgresql://${DATABASE_USER}:${password}@127.0.0.1:${databasePort}/${DATABASE_NAME}`;

    const inherited = inheritedEnvironment();
    // The API's documented configuration, explicit. NODE_ENV=development only because the
    // demo serves plain HTTP on loopback: it keeps the session cookie without `Secure` (and its
    // `__Host-` name), which a browser would not send back over HTTP. Sign-in admission is not
    // set, so it runs with its production defaults (ADR 0018).
    const appEnv = {
      ...inherited,
      DATABASE_URL: databaseUrl,
      DOCUMENT_STORAGE_DIR: documents,
      NODE_ENV: 'development',
    };

    // Built while PostgreSQL initializes. The API is compiled outside the repository, so
    // apps/api/dist (and `pnpm dev`) stay as they are; it resolves its packages through a link.
    onStep('Building the API');
    await mkdir(apiBuild);
    await writeFile(join(apiBuild, 'package.json'), '{ "type": "module" }\n');
    await symlink(join(apiDir, 'node_modules'), apiModules, 'junction');
    stepLog = join(logsDir, 'api-build.log');
    await runScript(
      'API build',
      packageScript(repoRoot, 'typescript/bin/tsc'),
      ['-p', join(apiDir, 'tsconfig.build.json'), '--outDir', join(apiBuild, 'dist')],
      {
        cwd: apiDir,
        env: inherited,
        logFile: stepLog,
        timeoutMs: 5 * 60_000,
        detached: true,
        ...(signal !== undefined && { signal }),
      },
    );

    onStep('Building the web app');
    const webBuild = join(runRoot, 'web');
    const vite = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
    stepLog = join(logsDir, 'web-build.log');
    await runScript('web build', vite, ['build', '--outDir', webBuild, '--emptyOutDir'], {
      cwd: webDir,
      env: inherited,
      logFile: stepLog,
      timeoutMs: 5 * 60_000,
      detached: true,
      ...(signal !== undefined && { signal }),
    });

    onStep('Waiting for PostgreSQL to accept connections');
    stepLog = undefined;
    await waitForDatabase(databaseUrl, container, signal);

    onStep('Applying the migrations (prisma migrate deploy)');
    stepLog = join(logsDir, 'migrate.log');
    await runScript(
      'prisma migrate deploy',
      packageScript(apiDir, 'prisma/build/index.js'),
      ['migrate', 'deploy'],
      {
        cwd: apiDir,
        env: appEnv,
        logFile: stepLog,
        timeoutMs: 2 * 60_000,
        detached: true,
        ...(signal !== undefined && { signal }),
      },
    );
    await expectAllMigrationsApplied(databaseUrl);

    onStep('Seeding the demo data (apps/api/prisma/seed.ts)');
    stepLog = join(logsDir, 'seed.log');
    // The seed command Prisma is configured with (`tsx prisma/seed.ts`), as a tsx import in one
    // Node process; tsx's compile cache is off, so nothing is written outside the run.
    await runScript('demo seed', 'prisma/seed.ts', [], {
      cwd: apiDir,
      env: { ...appEnv, TSX_DISABLE_CACHE: '1' },
      nodeOptions: ['--import', 'tsx'],
      logFile: stepLog,
      timeoutMs: 2 * 60_000,
      detached: true,
      ...(signal !== undefined && { signal }),
    });

    let unexpectedExit: string | undefined;
    let reportExit: (description: string) => void = () => undefined;
    const serverExit = new Promise<string>((resolvePromise) => {
      reportExit = resolvePromise;
    });
    const own = (server: OwnedProcess) => {
      ownership.add({
        name: `stop the ${server.name} (process id ${String(server.pid)})`,
        release: () => server.stop(),
        recovery:
          process.platform === 'win32'
            ? `taskkill /PID ${String(server.pid)} /F`
            : `kill -9 ${String(server.pid)}`,
        releaseNow: () => {
          server.killNow();
        },
      });
      void server.exited.then(async (code) => {
        if (stopping) return;
        unexpectedExit = `The ${server.name} exited on its own (exit code ${String(code)}).\n${await tailOf(server.logFile)}`;
        reportExit(unexpectedExit);
      });
      return server;
    };

    onStep('Starting the API');
    const apiPort = await freePort();
    stepLog = join(logsDir, 'api.log');
    const api = own(
      OwnedProcess.start('API', join(apiBuild, 'dist', 'main.js'), [], {
        cwd: apiBuild,
        env: { ...appEnv, HOST: '127.0.0.1', PORT: String(apiPort) },
        logFile: stepLog,
        detached: true,
      }),
    );
    await waitUntilServing(`http://127.0.0.1:${apiPort}/api/health`, api, 60_000, signal);

    onStep('Starting the web server');
    const webPort = await freePort();
    const webUrl = `http://127.0.0.1:${webPort}`;
    stepLog = join(logsDir, 'web.log');
    const web = own(
      OwnedProcess.start(
        'web server',
        vite,
        [
          'preview',
          '--outDir',
          webBuild,
          '--host',
          '127.0.0.1',
          '--port',
          String(webPort),
          '--strictPort',
        ],
        {
          cwd: webDir,
          env: { ...inherited, API_PROXY_TARGET: `http://127.0.0.1:${apiPort}` },
          logFile: stepLog,
          detached: true,
        },
      ),
    );
    await waitUntilServing(`${webUrl}/sign-in`, web, 60_000, signal);
    // The whole chain: browser origin → web server's /api proxy → API → database.
    await waitUntilServing(`${webUrl}/api/health`, web, 60_000, signal);

    let stopped: Promise<void> | undefined;
    return {
      webUrl,
      resources: { runRoot, container, databasePort, apiPort, apiPid: api.pid, webPid: web.pid },
      recovery: ownership.recoverySteps(),
      serverExit,
      get unexpectedExit() {
        return unexpectedExit;
      },
      stop() {
        stopping = true;
        stopped ??= ownership.release();
        return stopped;
      },
    };
  } catch (error) {
    const failure = signal?.aborted
      ? new Error('Startup was interrupted.')
      : new Error(
          stepLog === undefined
            ? messageOf(error)
            : `${messageOf(error)}\n${await tailOf(stepLog)}`,
        );
    stopping = true;
    try {
      await ownership.release();
    } catch (cleanupError) {
      failure.message += `\n${messageOf(cleanupError)}`;
    }
    throw failure;
  }
}

/** Fails unless every migration in apps/api/prisma/migrations is recorded as applied. */
async function expectAllMigrationsApplied(databaseUrl: string): Promise<void> {
  const entries = await readdir(join(apiDir, 'prisma', 'migrations'), { withFileTypes: true });
  const expected = entries.filter((entry) => entry.isDirectory()).length;
  const client = new pg.Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const { rows } = await client.query<{ applied: string }>(
      'SELECT count(*) AS applied FROM _prisma_migrations WHERE finished_at IS NOT NULL',
    );
    const applied = Number(rows[0]?.applied);
    if (applied !== expected) {
      throw new Error(`${applied} of ${expected} migrations were applied to the demo database`);
    }
  } finally {
    await client.end();
  }
}

/**
 * How to delete the run's directory by hand. The link must go first: Windows PowerShell 5.1's
 * `Remove-Item -Recurse` can follow a junction into the repository's apps/api/node_modules.
 */
function runRootRecovery(runRoot: string, link: string): string {
  return process.platform === 'win32'
    ? `in cmd: (if exist "${link}" rmdir "${link}") & rmdir /s /q "${runRoot}"`
    : `rm -f "${link}" && rm -rf "${runRoot}"`;
}
