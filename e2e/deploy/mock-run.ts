import { spawn, execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { freePort } from '../support/processes.js';
import { DIAGNOSTICS_DIR, LOG_SERVICES, LOG_TAIL_LINES, sanitize, tail } from './diagnostics.js';

const exec = promisify(execFile);
const repo = fileURLToPath(new URL('../../', import.meta.url));
const CA_PATH = '/data/caddy/pki/authorities/local/root.crt';

/**
 * Docker Compose resources are exclusively scoped by a random project name, never the dev stack.
 * `demoSeed: false` starts with migrations only: no public-password demo users (the hosted
 * rehearsal prepares its own accounts, as a hosted environment would).
 */
export async function startMock(
  onStep: (message: string) => void,
  signal?: AbortSignal,
  options: { demoSeed?: boolean } = {},
) {
  const project = `tradeflow-mock-${randomUUID().slice(0, 8)}`;
  // Evidence of an earlier run must not be mistaken for this one's.
  await rm(DIAGNOSTICS_DIR, { recursive: true, force: true });
  const root = await mkdtemp(join(tmpdir(), `${project}-`));
  const variables = {
    MOCK_API_IMAGE: `tradeflow-api:${project}`,
    MOCK_WEB_IMAGE: `tradeflow-web:${project}`,
    MOCK_TOOLS_IMAGE: `tradeflow-tools:${project}`,
    MOCK_HTTP_PORT: String(await freePort()),
    MOCK_HTTPS_PORT: String(await freePort()),
    MOCK_DATABASE_PASSWORD: randomBytes(24).toString('hex'),
    MOCK_ACCESS_KEY: `mock-${randomUUID()}`,
    MOCK_SECRET_KEY: randomBytes(24).toString('hex'),
    MOCK_TRUSTED_PROXY: '192.0.2.254/32', // replaced with this run's actual edge peer before API starts
    MOCK_S3_AUTH_FILE: join(root, 's3.json'),
    MOCK_CA_FILE: join(root, 'root.crt'),
    MOCK_CADDY_FILE: join(repo, 'deploy', 'mock', 'Caddyfile'),
  };
  const env = { ...process.env, ...variables };
  const recoveryFile = join(root, 'compose.env');
  const saveEnvironment = () =>
    writeFile(
      recoveryFile,
      Object.keys(variables)
        .map((key) => `${key}=${JSON.stringify(env[key as keyof typeof variables])}`)
        .join('\n') + '\n',
      { mode: 0o600 },
    );
  let cleaning = false;
  const docker = async (args: string[], timeout = 120_000) => {
    if (!cleaning) signal?.throwIfAborted();
    try {
      return (
        await exec('docker', args, {
          cwd: repo,
          env,
          windowsHide: true,
          timeout,
          maxBuffer: 4 * 1024 * 1024,
        })
      ).stdout.trim();
    } catch (error) {
      const details = error as { stdout?: string; stderr?: string; code?: unknown };
      let output = `${details.stdout ?? ''}\n${details.stderr ?? ''}`.slice(-12_000);
      for (const secret of [env.MOCK_DATABASE_PASSWORD, env.MOCK_ACCESS_KEY, env.MOCK_SECRET_KEY])
        output = output.replaceAll(secret, '[mock credential]');
      // The raw exec error's command/stack can contain generated credentials. Keep only the
      // bounded, redacted process output rather than attaching that unsafe cause.
      // eslint-disable-next-line preserve-caught-error
      throw new Error(`Docker ${args[0] ?? ''} failed (${String(details.code)}):\n${output}`);
    }
  };
  const compose = (...args: string[]) =>
    docker(['compose', '--project-name', project, '--file', 'deploy/mock/compose.yml', ...args]);
  const container = async (service: string) => compose('ps', '--all', '--quiet', service);
  const build = (target: string, tag: string) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(
        'docker',
        ['build', '--file', 'deploy/Dockerfile', '--target', target, '--tag', tag, '.'],
        { cwd: repo, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
      );
      let output = '';
      child.stdout.on('data', (bytes: Buffer) => {
        output = (output + bytes.toString()).slice(-16_000);
      });
      child.stderr.on('data', (bytes: Buffer) => {
        output = (output + bytes.toString()).slice(-16_000);
      });
      child.once('error', reject);
      child.once('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Docker ${target} build failed:\n${output}`));
      });
    });
  const secrets = () => [env.MOCK_DATABASE_PASSWORD, env.MOCK_ACCESS_KEY, env.MOCK_SECRET_KEY];
  /**
   * Bounded, sanitized log tails of the owned containers, written before they are removed.
   * Never throws: a collection problem must neither block cleanup nor replace the real failure.
   */
  const collectDiagnostics = async (reason: string) => {
    try {
      await mkdir(DIAGNOSTICS_DIR, { recursive: true });
      const failed = (error: unknown) =>
        `(unavailable: ${error instanceof Error ? error.message : 'unknown error'})`;
      const status = await compose(
        'ps',
        '--all',
        '--format',
        '{{.Service}}\t{{.State}}\t{{.Status}}',
      ).catch(failed);
      await writeFile(
        join(DIAGNOSTICS_DIR, 'summary.txt'),
        tail(
          sanitize(
            `Reason: ${reason}\nProject: ${project}\nCollected: ${new Date().toISOString()}\n` +
              `Log tails: last ${String(LOG_TAIL_LINES)} lines per service.\n\nContainers:\n${status}\n`,
            secrets(),
          ),
        ),
      );
      for (const service of LOG_SERVICES) {
        const logs = await compose(
          'logs',
          '--no-color',
          '--timestamps',
          '--tail',
          String(LOG_TAIL_LINES),
          service,
        ).catch(failed);
        const text = tail(sanitize(logs, secrets()));
        await writeFile(join(DIAGNOSTICS_DIR, `${service}.log`), `${text}\n`);
        if (service === 'api') console.error(`[deploy] API log tail:\n${tail(text, 6_000)}`);
      }
      console.error(`[deploy] Sanitized diagnostics: ${DIAGNOSTICS_DIR}`);
    } catch (error) {
      console.error(
        '[deploy] Diagnostics collection failed:',
        sanitize(error instanceof Error ? error.message : 'unknown error', secrets()),
      );
    }
  };
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    cleaning = true;
    // Compose labels protect other projects; never use docker prune or a process-name kill.
    await compose('down', '--volumes', '--remove-orphans', '--timeout', '20');
    // If cleanup fails, keep the recovery environment and directory for an explicit retry.
    // Only the three tags generated by this run. BuildKit's reusable layers remain cached.
    const existing = await docker(['image', 'ls', '--format', '{{.Repository}}:{{.Tag}}']);
    const tags = [env.MOCK_API_IMAGE, env.MOCK_WEB_IMAGE, env.MOCK_TOOLS_IMAGE].filter((tag) =>
      existing.split('\n').includes(tag),
    );
    if (tags.length) await docker(['image', 'rm', ...tags]);
    await rm(root, { recursive: true, force: true });
    stopped = true;
  };
  try {
    await saveEnvironment();
    await writeFile(
      env.MOCK_S3_AUTH_FILE,
      JSON.stringify({
        identities: [
          {
            name: 'mock-only',
            credentials: [{ accessKey: env.MOCK_ACCESS_KEY, secretKey: env.MOCK_SECRET_KEY }],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
        ],
      }),
      { mode: 0o644 },
    );
    for (const [target, tag] of [
      ['api', env.MOCK_API_IMAGE],
      ['web', env.MOCK_WEB_IMAGE],
      ['tools', env.MOCK_TOOLS_IMAGE],
    ]) {
      signal?.throwIfAborted();
      onStep(`Building ${target} image`);
      await build(target ?? '', tag ?? '');
    }
    onStep('Starting isolated PostgreSQL, S3 and the HTTPS edge');
    await compose('up', '--detach', '--wait', '--wait-timeout', '120', 'postgres', 's3', 'edge');
    const edgeId = await container('edge');
    const networks = JSON.parse(
      await docker(['inspect', '--format', '{{json .NetworkSettings.Networks}}', edgeId]),
    ) as Record<string, { IPAddress: string }>;
    const address = networks[`${project}_front`]?.IPAddress;
    if (!address) throw new Error('No edge address on the owned front network');
    env.MOCK_TRUSTED_PROXY = `${address}/32`;
    await saveEnvironment();
    await docker(['cp', `${edgeId}:${CA_PATH}`, join(root, 'root.crt')]);
    // `docker cp` keeps Caddy's 0600 mode and, on a Linux host, gives the copy to the invoking
    // user, so the API's uid 1000 could not read its bind mount and Node would skip
    // NODE_EXTRA_CA_CERTS (S3 TLS then fails). It is the public CA certificate; its key stays put.
    await chmod(join(root, 'root.crt'), 0o644);
    const ca = await readFile(join(root, 'root.crt'));
    const baseURL = `https://localhost:${env.MOCK_HTTPS_PORT}`;
    // Create the mock bucket using the actual signed SDK inside its own network, then migrate.
    onStep('Creating the private mock bucket and applying migrations');
    await compose(
      'run',
      '--rm',
      '--no-deps',
      '--entrypoint',
      'node',
      '-e',
      `S3_ACCESS=${env.MOCK_ACCESS_KEY}`,
      '-e',
      `S3_SECRET=${env.MOCK_SECRET_KEY}`,
      'tools',
      '--input-type=module',
      '-e',
      `import {S3Client,CreateBucketCommand} from '@aws-sdk/client-s3'; const c=new S3Client({endpoint:'http://s3:8333',region:'us-east-1',forcePathStyle:true,credentials:{accessKeyId:process.env.S3_ACCESS,secretAccessKey:process.env.S3_SECRET}});await c.send(new CreateBucketCommand({Bucket:'tradeflow-mock'}));c.destroy();`,
    );
    await compose(
      'run',
      '--rm',
      '--no-deps',
      'tools',
      'node',
      'node_modules/prisma/build/index.js',
      'migrate',
      'deploy',
    );
    if (options.demoSeed ?? true) {
      onStep('Seeding fictional users into this run only');
      await compose(
        'run',
        '--rm',
        '--no-deps',
        'tools',
        'node',
        '--import',
        'tsx',
        'prisma/seed.ts',
      );
    }
    onStep('Starting production API with S3 over the mock HTTPS endpoint');
    await compose('up', '--detach', '--wait', '--wait-timeout', '90', 'api');
    const request = (path: string, options: https.RequestOptions = {}, body?: Buffer | string) =>
      new Promise<{
        status: number;
        headers: import('node:http').IncomingHttpHeaders;
        body: Buffer;
      }>((resolve, reject) => {
        const send = https.request(new URL(path, baseURL), { ...options, ca }, (response) => {
          const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => chunks.push(chunk));
          response.on('end', () => {
            resolve({
              status: response.statusCode ?? 0,
              headers: response.headers,
              body: Buffer.concat(chunks),
            });
          });
          response.on('error', reject);
        });
        send.setTimeout(45_000, () => {
          send.destroy(new Error('HTTPS request timed out'));
        });
        send.on('error', reject);
        send.end(body);
      });
    return {
      project,
      root,
      recoveryFile,
      baseURL,
      httpURL: `http://localhost:${env.MOCK_HTTP_PORT}`,
      ca,
      request,
      compose,
      container,
      docker,
      collectDiagnostics,
      stop,
    };
  } catch (error) {
    await collectDiagnostics(
      `Startup failed: ${error instanceof Error ? error.message.slice(0, 2_000) : 'unknown error'}`,
    );
    await stop().catch((cleanupError: unknown) => {
      console.error(
        'Mock cleanup failed:',
        cleanupError instanceof Error ? cleanupError.message : 'unknown',
      );
    });
    throw error;
  }
}

export type MockRun = Awaited<ReturnType<typeof startMock>>;
