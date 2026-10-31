import { execFile } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { CreateBucketCommand, S3Client } from '@aws-sdk/client-s3';
import type { TestProject } from 'vitest/node';
import type { StorageResources } from './resources.js';

const exec = promisify(execFile);
const S3_IMAGE =
  'chrislusf/seaweedfs:4.17@sha256:186de7ef977a20343ee9a5544073f081976a29e2d29ecf8379891e7bf177fbe9';
const LABEL = 'io.tradeflow.storage-test';

/** Isolated real PostgreSQL and authenticated S3; no inherited database or cloud credentials. */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const run = randomUUID();
  const root = await mkdtemp(join(tmpdir(), 'tradeflow-storage-test-'));
  const containers: string[] = [];
  const docker = async (...args: string[]) =>
    (
      await exec('docker', args, {
        windowsHide: true,
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
      })
    ).stdout.trim();
  const cleanup = async () => {
    const errors: unknown[] = [];
    for (const name of containers.reverse()) {
      try {
        const owner = await docker(
          'inspect',
          '--format',
          `{{index .Config.Labels "${LABEL}"}}`,
          name,
        );
        if (owner !== run)
          throw new Error(`Refusing to remove container not owned by this run: ${name}`);
        await docker('rm', '--force', '--volumes', name);
      } catch (error) {
        errors.push(error);
      }
    }
    await rm(root, { recursive: true, force: true });
    if (errors.length) throw new AggregateError(errors, 'Storage-test cleanup failed');
  };
  const create = async (kind: string, args: string[]) => {
    const name = `tradeflow-storage-${kind}-${run}`;
    await docker('create', '--name', name, '--label', `${LABEL}=${run}`, ...args);
    containers.push(name);
    return name;
  };
  const port = async (name: string, inside: string) => {
    const address = await docker('port', name, `${inside}/tcp`);
    if (!/^127\.0\.0\.1:\d+$/.test(address))
      throw new Error('Container was not published on loopback only');
    return address;
  };
  const wait = async (ready: () => Promise<unknown>) => {
    const until = Date.now() + 60_000;
    for (;;) {
      try {
        await ready();
        return;
      } catch (error) {
        if (Date.now() > until) throw error;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  };
  try {
    const password = randomBytes(24).toString('hex');
    const pg = await create('pg', [
      '--env',
      'POSTGRES_USER=tradeflow',
      '--env',
      `POSTGRES_PASSWORD=${password}`,
      '--env',
      'POSTGRES_DB=tradeflow_storage_test',
      '--tmpfs',
      '/var/lib/postgresql',
      '--publish',
      '127.0.0.1::5432',
      'postgres:18-alpine',
    ]);
    const accessKeyId = `test-${run}`;
    const secretAccessKey = randomBytes(24).toString('hex');
    const authFile = join(root, 's3.json');
    await writeFile(
      authFile,
      JSON.stringify({
        identities: [
          {
            name: 'storage-test',
            credentials: [{ accessKey: accessKeyId, secretKey: secretAccessKey }],
            actions: ['Admin', 'Read', 'Write', 'List', 'Tagging'],
          },
        ],
      }),
      { mode: 0o644 },
    );
    const s3 = await create('s3', [
      '--tmpfs',
      '/data:size=256m',
      '--publish',
      '127.0.0.1::8333',
      S3_IMAGE,
      'mini',
      '-dir=/data',
      '-ip=127.0.0.1',
      '-ip.bind=0.0.0.0',
      '-s3.config=/etc/tradeflow-s3.json',
      '-master.volumeSizeLimitMB=64',
      '-admin.ui=false',
      '-webdav=false',
    ]);
    await docker('cp', authFile, `${s3}:/etc/tradeflow-s3.json`);
    await docker('start', pg);
    await docker('start', s3);
    await wait(() => docker('exec', pg, 'pg_isready', '-h', '127.0.0.1', '-U', 'tradeflow'));
    const databaseUrl = `postgresql://tradeflow:${password}@${await port(pg, '5432')}/tradeflow_storage_test`;
    const endpoint = `http://${await port(s3, '8333')}`;
    const client = new S3Client({
      endpoint,
      region: 'us-east-1',
      forcePathStyle: true,
      credentials: { accessKeyId, secretAccessKey },
      maxAttempts: 1,
      requestHandler: { connectionTimeout: 1_000, requestTimeout: 2_000 },
    });
    try {
      await wait(() => client.send(new CreateBucketCommand({ Bucket: 'tradeflow-storage-test' })));
    } finally {
      client.destroy();
    }
    const prismaCli = createRequire(import.meta.url).resolve('prisma/build/index.js');
    await exec(process.execPath, [prismaCli, 'migrate', 'deploy'], {
      windowsHide: true,
      env: { ...process.env, DATABASE_URL: databaseUrl },
      timeout: 60_000,
    });
    project.provide('storageResources', {
      databaseUrl,
      postgresContainer: pg,
      endpoint,
      accessKeyId,
      secretAccessKey,
    } satisfies StorageResources);
    return cleanup;
  } catch (error) {
    for (const name of containers) {
      console.error(
        await docker(
          'inspect',
          '--format',
          '{{json .State}} {{json .Config.Cmd}} {{json .HostConfig.PortBindings}}',
          name,
        ).catch(() => 'No state'),
      );
      console.error(await docker('logs', '--tail', '20', name).catch(() => 'No container logs'));
    }
    await cleanup();
    throw error;
  }
}
