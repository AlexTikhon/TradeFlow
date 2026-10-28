import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  dropDatabase,
  e2eDatabaseName,
  insertReferenceData,
  recreateDatabase,
} from './database.js';
import { freePort, OwnedProcess, runScript, waitUntilServing } from './processes.js';
import { DEFAULT_E2E_DATABASE_URL, E2E_PASSWORD, publishRunConfig } from './run-config.js';
import { TransportProxy } from './transport-proxy.js';

/*
 * Builds and starts everything one run uses, all of it owned by the run and released by the
 * returned teardown, whether the tests passed, failed or setup itself failed half way:
 *
 * - a dedicated database (`tradeflow_e2e` by default, on the development Postgres server),
 *   dropped and recreated with the real migrations, and dropped again at the end;
 * - a temporary directory holding the API build, the web build and the document storage;
 * - the API (`node main.js` from that build) and the web app (`vite preview` of that build, whose
 *   same-origin `/api` proxy is the one development uses), each on a port of its own chosen by
 *   the operating system, so `pnpm dev` on 3000 and 5173 can keep running;
 * - the transport proxy between the two (see transport-proxy.ts).
 *
 * Nothing here reads, prints or stores a session token. Server output goes to `.output/logs`.
 */

const repoRoot = fileURLToPath(new URL('../../', import.meta.url));
const apiDir = join(repoRoot, 'apps', 'api');
const webDir = join(repoRoot, 'apps', 'web');
const logsDir = fileURLToPath(new URL('../.output/logs/', import.meta.url));

type Cleanup = () => Promise<void>;

/** Releases what the run acquired, newest first, and reports every failure. */
class Resources {
  private readonly cleanups: { name: string; cleanup: Cleanup }[] = [];
  private readonly processes = new Set<OwnedProcess>();
  private readonly onExit = () => {
    // The runner is exiting without teardown (for example, killed): stop the servers at least.
    for (const owned of this.processes) owned.killNow();
  };

  constructor() {
    process.once('exit', this.onExit);
  }

  add(name: string, cleanup: Cleanup): void {
    this.cleanups.push({ name, cleanup });
  }

  own(owned: OwnedProcess): OwnedProcess {
    this.processes.add(owned);
    this.add(`stop ${owned.name}`, async () => {
      await owned.stop();
      this.processes.delete(owned);
    });
    return owned;
  }

  async release(): Promise<void> {
    const failures: unknown[] = [];
    for (const { name, cleanup } of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        failures.push(new Error(`E2E cleanup "${name}" failed`, { cause: error }));
      }
    }
    this.cleanups.length = 0;
    process.off('exit', this.onExit);
    if (failures.length > 0) throw new AggregateError(failures, 'E2E cleanup failed');
  }
}

/** The Node script of a package's binary, run with the current Node (no shell, no .cmd shims). */
function packageScript(fromDir: string, specifier: string): string {
  return createRequire(join(fromDir, 'package.json')).resolve(specifier);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const databaseUrl = process.env.E2E_DATABASE_URL ?? DEFAULT_E2E_DATABASE_URL;
  // Before anything is created: a wrong database name stops the run here.
  e2eDatabaseName(databaseUrl);

  const resources = new Resources();
  try {
    await mkdir(logsDir, { recursive: true });
    const runDir = await mkdtemp(join(tmpdir(), 'tradeflow-e2e-'));
    const apiBuild = join(runDir, 'api');
    const apiModules = join(apiBuild, 'node_modules');
    resources.add('remove the temporary directory', async () => {
      // Remove the link to apps/api/node_modules itself first, never what it points to.
      await unlink(apiModules).catch(() => undefined);
      await rm(runDir, { recursive: true, force: true, maxRetries: 5 });
    });

    await recreateDatabase(databaseUrl);
    resources.add('drop the E2E database', () => dropDatabase(databaseUrl));
    const childEnv = { ...process.env, DATABASE_URL: databaseUrl };
    await runScript(
      'prisma migrate deploy',
      packageScript(apiDir, 'prisma/build/index.js'),
      ['migrate', 'deploy'],
      { cwd: apiDir, env: childEnv, logFile: join(logsDir, 'migrate.log') },
    );
    await insertReferenceData(databaseUrl);

    // The API, compiled outside the repository so apps/api/dist (and `pnpm dev`) stay as they
    // are. It resolves its dependencies through a link to apps/api/node_modules.
    await mkdir(apiBuild, { recursive: true });
    await writeFile(join(apiBuild, 'package.json'), '{ "type": "module" }\n');
    await symlink(join(apiDir, 'node_modules'), apiModules, 'junction');
    await runScript(
      'API build',
      packageScript(repoRoot, 'typescript/bin/tsc'),
      ['-p', join(apiDir, 'tsconfig.build.json'), '--outDir', join(apiBuild, 'dist')],
      { cwd: apiDir, env: process.env, logFile: join(logsDir, 'api-build.log') },
    );
    const webBuild = join(runDir, 'web');
    const vite = join(webDir, 'node_modules', 'vite', 'bin', 'vite.js');
    await runScript('web build', vite, ['build', '--outDir', webBuild, '--emptyOutDir'], {
      cwd: webDir,
      env: process.env,
      logFile: join(logsDir, 'web-build.log'),
    });

    // Hashed by the API's own code, so scenario users sign in exactly like real ones.
    const passwordModule = pathToFileURL(join(apiBuild, 'dist', 'modules', 'auth', 'password.js'));
    const { hashPassword } = (await import(passwordModule.href)) as {
      hashPassword: (password: string) => Promise<string>;
    };
    const passwordHash = await hashPassword(E2E_PASSWORD);

    const documents = join(runDir, 'documents');
    await mkdir(documents);
    const apiPort = await freePort();
    const api = resources.own(
      OwnedProcess.start('API', join(apiBuild, 'dist', 'main.js'), [], {
        // No .env in this directory: the API sees only the variables given here.
        cwd: apiBuild,
        env: {
          ...childEnv,
          NODE_ENV: 'test',
          PORT: String(apiPort),
          DOCUMENT_STORAGE_DIR: documents,
          // Every browser context reaches the API through the one web server proxy, so the
          // whole run shares one client address: the production budget (20 a minute) would
          // refuse the suite's own sign-ins. Admission itself stays on (ADR 0018).
          SIGN_IN_ATTEMPTS_PER_MINUTE: '1000',
        },
        logFile: join(logsDir, 'api.log'),
      }),
    );
    await waitUntilServing(`http://127.0.0.1:${apiPort}/api/health`, api);

    const transport = await TransportProxy.start(new URL(`http://127.0.0.1:${apiPort}`));
    resources.add('close the transport proxy', () => transport.close());

    const webPort = await freePort();
    const webUrl = `http://127.0.0.1:${webPort}`;
    const web = resources.own(
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
          env: { ...process.env, API_PROXY_TARGET: transport.url },
          logFile: join(logsDir, 'web.log'),
        },
      ),
    );
    await waitUntilServing(`${webUrl}/sign-in`, web);
    // The whole chain: browser origin → web server's /api proxy → transport proxy → API → DB.
    await waitUntilServing(`${webUrl}/api/health`, web);

    publishRunConfig({ webUrl, transportUrl: transport.url, databaseUrl, passwordHash });
    return () => resources.release();
  } catch (error) {
    await resources.release().catch((cleanupError: unknown) => {
      console.error(cleanupError);
    });
    throw error;
  }
}
