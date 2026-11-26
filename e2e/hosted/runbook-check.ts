import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

/*
 * `pnpm hosted:runbook-check`: runs the runbook's privileged shell blocks
 * (docs/hosted-verification.md, marked `<!-- runbook-check: … -->`) offline, in a disposable Linux
 * "instance": a privileged docker-in-docker container with its own daemon, a non-root sudo user
 * (`ssm-user`, like an SSM session), root-only `/run/tradeflow` files and a TLS PostgreSQL 18
 * with its own CA at `/etc/tradeflow/rds-ca.pem`. No AWS account, credential or remote host is
 * involved, and nothing outside this run's container and image tag is touched.
 *
 *   fixtures          the non-root caller feeds the root-only password file to `docker run -i`
 *                     on stdin; files stay private; passwords never reach a command line. The
 *                     tools image is replaced by a probe that reports the bytes it received.
 *   restore-database  with a conflicting PGDATABASE (and DATABASE_URL) in the caller's shell,
 *                     pg_restore must land in restore.env's database. The effective destination
 *                     is read from the server's own connection log and the databases' contents.
 *
 * Each block's reviewed form (10186bd) runs too and must show the reported defect, so the check
 * is known to detect it.
 */

const repo = fileURLToPath(new URL('../../', import.meta.url));
const RUN = randomBytes(4).toString('hex');
const HOST_IMAGE = `tradeflow-runbook-host:${RUN}`;
const INSTANCE = `tradeflow-runbook-${RUN}`;
const BASE_IMAGES = ['docker:29-dind', 'postgres:18'];
const PROBE_IMAGE = 'tradeflow-runbook-probe:local';
const SOURCE_DB = 'tradeflow';
const RESTORE_DB = `tradeflow_restore_${new Date().toISOString().slice(0, 10).replaceAll('-', '')}`;
const BACKUP_ID = 'runbook-check';

/** The reviewed commands, verbatim from docs/hosted-verification.md at 10186bd. */
const REVIEWED = {
  fixtureFeed: `sudo docker run --rm -i --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges=true \\
  --env-file /run/tradeflow/fixtures.env --env DOCUMENT_STORAGE_DRIVER=local --env DOCUMENT_STORAGE_DIR=/tmp/unused \\
  --mount type=bind,source=/etc/tradeflow/rds-ca.pem,target=/etc/tradeflow/rds-ca.pem,readonly \\
  <registry>/tradeflow-portfolio/tools@sha256:<digest> \\
  node --import tsx scripts/verification-fixtures.ts --confirm-database <database_address>:5432/tradeflow \\
  < /run/tradeflow/fixture-passwords.json`,
  // `pg` expanded as the reviewed runbook defined it; run from the backup directory.
  restore: `sudo docker run --rm --read-only --tmpfs /tmp --cap-drop ALL --security-opt no-new-privileges=true --mount type=bind,source=/etc/tradeflow/rds-ca.pem,target=/etc/tradeflow/rds-ca.pem,readonly --env-file /run/tradeflow/pg-restore.env -i postgres:18 pg_restore --dbname="$PGDATABASE" --exit-on-error --no-owner --no-acl < database.dump`,
};

const PLACEHOLDERS: Record<string, string> = {
  '<registry>/tradeflow-portfolio/tools@sha256:<digest>': PROBE_IMAGE,
  '<database_address>': 'db.invalid',
  '<id>': BACKUP_ID,
};

interface Outcome {
  code: number;
  stdout: string;
  stderr: string;
}

function execute(
  command: string,
  args: string[],
  options: { input?: string | Buffer | undefined; allowFailure?: boolean | undefined } = {},
): Promise<Outcome> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
    child.stderr.on('data', (chunk: Buffer) => err.push(chunk));
    child.once('error', reject);
    child.once('close', (code) => {
      const outcome = {
        code: code ?? 1,
        stdout: Buffer.concat(out).toString(),
        stderr: Buffer.concat(err).toString(),
      };
      // Never echo stdout: the fixture block prints the generated passwords there.
      if (outcome.code !== 0 && !options.allowFailure)
        reject(new Error(`${command} ${args[0] ?? ''} exited ${String(code)}: ${outcome.stderr}`));
      else resolve(outcome);
    });
    child.stdin.end(options.input);
  });
}

/** A command in the instance, as root unless `user` is given. */
const inInstance = (
  script: string,
  options: {
    user?: string | undefined;
    env?: Record<string, string> | undefined;
    input?: string | undefined;
    allowFailure?: boolean | undefined;
  } = {},
) =>
  execute(
    'docker',
    [
      'exec',
      '-i',
      ...(options.user ? ['-u', options.user] : []),
      ...Object.entries(options.env ?? {}).flatMap(([name, value]) => ['-e', `${name}=${value}`]),
      INSTANCE,
      'bash',
      '-c',
      script,
    ],
    { input: options.input, allowFailure: options.allowFailure },
  );

/** Runs shell text as `ssm-user` from a file in the instance, with errexit and pipefail. */
async function asOperator(
  name: string,
  text: string,
  options: { env?: Record<string, string>; input?: string; cwd?: string; user?: string } = {},
) {
  const path = `/srv/runbook/${name}.sh`;
  await inInstance(`install -d -m 0755 /srv/runbook && cat > ${path} && chmod 0644 ${path}`, {
    input: `set -eo pipefail\n${options.cwd ? `cd ${options.cwd}\n` : ''}${text}\n`,
  });
  return inInstance(`bash ${path}`, {
    user: options.user ?? 'ssm-user',
    env: options.env,
    input: options.input,
    allowFailure: true,
  });
}

function check(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Check failed: ${message}`);
}

async function waitUntil(probe: () => Promise<boolean>, timeoutMs: number, what: string) {
  const until = Date.now() + timeoutMs;
  while (!(await probe())) {
    if (Date.now() > until) throw new Error(`Timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
}

/** The shell block after `<!-- runbook-check: name … -->`, placeholders substituted. */
async function runbookBlock(name: string): Promise<string> {
  const doc = await readFile(`${repo}docs/hosted-verification.md`, 'utf8');
  const marker = doc.indexOf(`<!-- runbook-check: ${name} `);
  check(marker >= 0, `docs/hosted-verification.md has a runbook-check block "${name}"`);
  const match = /```sh\n([\s\S]*?)\n```/.exec(doc.slice(marker));
  check(match?.[1], `the "${name}" marker is followed by a sh block`);
  return substitute(match[1]);
}

function substitute(text: string): string {
  let result = text;
  for (const [placeholder, value] of Object.entries(PLACEHOLDERS))
    result = result.replaceAll(placeholder, value);
  const left = /<[a-z_]+>/.exec(result);
  check(!left, `no unknown placeholder remains (found ${left?.[0] ?? ''})`);
  return result;
}

/** Logical commands: backslash-continued lines joined. */
function commands(block: string): string[] {
  const result: string[] = [];
  let current = '';
  for (const line of block.split('\n')) {
    current += (current ? '\n' : '') + line;
    if (!line.endsWith('\\')) {
      result.push(current);
      current = '';
    }
  }
  return result;
}

/** Docker state outside the run, compared before and after. */
async function dockerState() {
  const list = async (args: string[]) =>
    (await execute('docker', args)).stdout.split('\n').filter(Boolean).sort().join(',');
  return {
    containers: await list(['ps', '-aq', '--no-trunc']),
    volumes: await list(['volume', 'ls', '-q']),
    images: await list(['images', '-q', '--no-trunc']),
    networks: await list(['network', 'ls', '-q']),
  };
}

const log = (message: string) => {
  console.log(`[runbook-check] ${message}`);
};

for (const image of BASE_IMAGES) {
  const present = await execute('docker', ['image', 'inspect', image], { allowFailure: true });
  if (present.code !== 0) {
    log(`pulling ${image}`);
    await execute('docker', ['pull', '-q', image]);
  }
}
const before = await dockerState();
const evidence: Record<string, unknown> = { run: RUN, environment: 'local docker-in-docker' };
let failed = true;

try {
  log('building the instance image (docker:29-dind + bash, sudo, openssl, ssm-user)');
  await execute('docker', ['build', '-q', '-t', HOST_IMAGE, '-'], {
    input: [
      'FROM docker:29-dind',
      'RUN apk add --no-cache bash sudo openssl \\',
      ' && adduser -D -u 1001 -s /bin/bash ssm-user \\',
      " && echo 'ssm-user ALL=(ALL) NOPASSWD: ALL' > /etc/sudoers.d/ssm-user \\",
      ' && chmod 0440 /etc/sudoers.d/ssm-user',
      '',
    ].join('\n'),
  });
  await execute('docker', [
    'run',
    '--detach',
    '--privileged',
    '--name',
    INSTANCE,
    '--env',
    'DOCKER_TLS_CERTDIR=',
    HOST_IMAGE,
  ]);
  await waitUntil(
    async () => (await inInstance('docker info', { allowFailure: true })).code === 0,
    90_000,
    "the instance's Docker daemon",
  );
  log('loading postgres:18 into the instance');
  await new Promise<void>((resolve, reject) => {
    const save = spawn('docker', ['save', 'postgres:18'], { stdio: ['ignore', 'pipe', 'inherit'] });
    const load = spawn('docker', ['exec', '-i', INSTANCE, 'docker', 'load', '-q'], {
      stdio: ['pipe', 'ignore', 'inherit'],
    });
    save.stdout.pipe(load.stdin);
    save.once('error', reject);
    load.once('error', reject);
    load.once('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`docker load exited ${String(code)}`));
    });
  });

  // ---- The instance's database: TLS with a private CA at the runbook's CA path. -------------
  const gateway = (
    await inInstance(
      "docker network inspect bridge --format '{{range .IPAM.Config}}{{.Gateway}}{{end}}'",
    )
  ).stdout.trim();
  check(/^\d+\.\d+\.\d+\.\d+$/.test(gateway), 'the instance bridge has an IPv4 gateway');
  const adminPassword = randomBytes(16).toString('hex');
  const migratorPassword = randomBytes(16).toString('hex');
  await inInstance(
    [
      'set -e',
      'install -d -m 0755 /etc/tradeflow',
      'install -d -m 0700 /srv/pg',
      'cd /srv/pg',
      'openssl req -x509 -newkey rsa:2048 -nodes -days 1 -subj /CN=runbook-check-ca -keyout ca.key -out /etc/tradeflow/rds-ca.pem 2>/dev/null',
      `openssl req -newkey rsa:2048 -nodes -subj /CN=${gateway} -keyout server.key -out server.csr 2>/dev/null`,
      `printf 'subjectAltName=IP:${gateway}\\n' > ext`,
      'openssl x509 -req -days 1 -in server.csr -CA /etc/tradeflow/rds-ca.pem -CAkey ca.key -CAcreateserial -extfile ext -out server.crt 2>/dev/null',
      'chmod 0644 /etc/tradeflow/rds-ca.pem && chown 999:999 server.key server.crt && chmod 0600 server.key',
      'chmod 0755 /srv/pg',
      `docker run --detach --name pg -p 5432:5432 -e POSTGRES_USER=tradeflow_admin -e POSTGRES_PASSWORD=${adminPassword} ` +
        '-v /srv/pg:/srv/pg:ro postgres:18 -c ssl=on -c ssl_cert_file=/srv/pg/server.crt ' +
        '-c ssl_key_file=/srv/pg/server.key -c log_connections=on > /dev/null',
    ].join('\n'),
  );
  await waitUntil(
    async () =>
      (
        await inInstance('docker exec pg pg_isready -q -h 127.0.0.1 -U tradeflow_admin', {
          allowFailure: true,
        })
      ).code === 0,
    90_000,
    'PostgreSQL in the instance',
  );
  const psql = async (database: string, sql: string) =>
    (
      await inInstance(
        `docker exec -i pg psql -X -q -At -v ON_ERROR_STOP=1 -U tradeflow_admin -d ${database}`,
        { input: sql },
      )
    ).stdout.trim();
  await psql(
    'postgres',
    `CREATE ROLE tradeflow_migrator LOGIN PASSWORD '${migratorPassword}';
     CREATE DATABASE ${SOURCE_DB} OWNER tradeflow_migrator;
     CREATE DATABASE ${RESTORE_DB} OWNER tradeflow_migrator;`,
  );
  await psql(
    SOURCE_DB,
    "CREATE TABLE restore_marker (note text NOT NULL); INSERT INTO restore_marker VALUES ('from-source');",
  );
  const sourceRows = () => psql(SOURCE_DB, 'SELECT count(*) FROM restore_marker');
  const restoreTables = () =>
    psql(RESTORE_DB, "SELECT count(*) FROM pg_tables WHERE schemaname = 'public'");
  const url = (database: string) =>
    `postgresql://tradeflow_migrator:${migratorPassword}@${gateway}:5432/${database}?sslmode=verify-full&sslrootcert=/etc/tradeflow/rds-ca.pem`;

  // Backup directory as in step 3 (uid 1000, 0700); the dump written by root as in step 4.
  const backupDir = `/var/lib/tradeflow-backups/${BACKUP_ID}`;
  await inInstance(
    `install -d -m 0755 /var/lib/tradeflow-backups && install -d -o 1000 -g 1000 -m 0700 ${backupDir} && ` +
      `docker exec pg pg_dump -U tradeflow_admin -d ${SOURCE_DB} --format=custom --no-owner --no-acl > ${backupDir}/database.dump`,
  );
  // Root-only maintenance files, as the runbook describes them.
  await inInstance(
    [
      'umask 077',
      'install -d -m 0700 /run/tradeflow',
      'cat > /run/tradeflow/restore.env <<EOF',
      `DATABASE_URL=${url(RESTORE_DB)}`,
      'DOCUMENT_STORAGE_DRIVER=s3',
      'S3_BUCKET=tradeflow-documents-example',
      'S3_REGION=eu-central-1',
      `S3_PREFIX=tradeflow/restore-${RESTORE_DB.slice(-8)}/`,
      'AWS_ACCESS_KEY_ID=ASIAEXAMPLEONLY',
      'AWS_SECRET_ACCESS_KEY=example-only',
      'EOF',
      // The reviewed runbook's hand-written libpq file, naming the restore database.
      'cat > /run/tradeflow/pg-restore.env <<EOF',
      `PGHOST=${gateway}`,
      'PGPORT=5432',
      `PGDATABASE=${RESTORE_DB}`,
      'PGUSER=tradeflow_migrator',
      `PGPASSWORD=${migratorPassword}`,
      'PGSSLMODE=verify-full',
      'PGSSLROOTCERT=/etc/tradeflow/rds-ca.pem',
      'EOF',
    ].join('\n'),
  );
  // The operator's own shell still holds the source's identity.
  const conflicting = { PGDATABASE: SOURCE_DB, DATABASE_URL: url(SOURCE_DB) };

  /** Databases tradeflow_migrator connected to while `step` ran, from the server's log. */
  const connections = async (step: () => Promise<Outcome>) => {
    const logLines = async () => (await inInstance('docker logs pg 2>&1')).stdout.split('\n');
    const start = (await logLines()).length;
    const outcome = await step();
    const lines = (await logLines()).slice(start);
    const authorized = lines
      .map((line) =>
        /connection authorized: user=tradeflow_migrator database=(\S+)(.*)$/.exec(line),
      )
      .filter((match) => match !== null)
      .map((match) => ({
        database: match[1] ?? '',
        ssl: (match[2] ?? '').includes('SSL enabled'),
      }));
    return { outcome, authorized };
  };

  // ---- restore-database ---------------------------------------------------------------------
  log(
    'restore-database: reviewed command (root shell, so the redirection itself can open the dump)',
  );
  const reviewedRestore = await connections(() =>
    asOperator('restore-reviewed', REVIEWED.restore, {
      user: 'root',
      env: conflicting,
      cwd: backupDir,
    }),
  );
  check(reviewedRestore.outcome.code !== 0, 'the reviewed restore did not succeed');
  check(
    reviewedRestore.authorized.some(({ database }) => database === SOURCE_DB),
    `the reviewed restore connected to the source database (saw ${JSON.stringify(reviewedRestore.authorized)})`,
  );
  check(
    !reviewedRestore.authorized.some(({ database }) => database === RESTORE_DB),
    'the reviewed restore never reached the restore database',
  );
  check(
    (await restoreTables()) === '0',
    'the restore database is still empty after the reviewed attempt',
  );
  check((await sourceRows()) === '1', 'the source is unchanged after the reviewed attempt');
  evidence.restoreReviewed = {
    exitCode: reviewedRestore.outcome.code,
    connectedTo: reviewedRestore.authorized.map(({ database }) => database),
    error: reviewedRestore.outcome.stderr.match(/pg_restore: error: [^\n]*/)?.[0] ?? null,
  };

  log('restore-database: runbook block as ssm-user with PGDATABASE/DATABASE_URL naming the source');
  const restoreBlock = await runbookBlock('restore-database');
  const fixedRestore = await connections(() =>
    asOperator('restore-runbook', restoreBlock, { env: conflicting }),
  );
  check(
    fixedRestore.outcome.code === 0,
    `the runbook restore succeeded (stderr: ${fixedRestore.outcome.stderr.trim()})`,
  );
  check(fixedRestore.authorized.length > 0, 'the runbook restore connected to the server');
  check(
    fixedRestore.authorized.every(({ database, ssl }) => database === RESTORE_DB && ssl),
    `every runbook restore connection was to ${RESTORE_DB} over TLS (saw ${JSON.stringify(fixedRestore.authorized)})`,
  );
  check(
    (await psql(RESTORE_DB, 'SELECT note FROM restore_marker')) === 'from-source',
    'the restore database now holds the dumped row',
  );
  check((await sourceRows()) === '1', 'the source still holds exactly its one row');
  const derived = (await inInstance('cat /run/tradeflow/pg-restore.env')).stdout.trim();
  check(
    derived === `DATABASE_URL=${url(RESTORE_DB)}`,
    "pg-restore.env is restore.env's DATABASE_URL line only",
  );
  const modes = (
    await inInstance(
      'stat -c "%a %U %n" /run/tradeflow /run/tradeflow/restore.env /run/tradeflow/pg-restore.env',
    )
  ).stdout.trim();
  check(
    modes ===
      '700 root /run/tradeflow\n600 root /run/tradeflow/restore.env\n600 root /run/tradeflow/pg-restore.env',
    `maintenance files stay root-only (${modes})`,
  );
  evidence.restoreRunbook = {
    exitCode: 0,
    connectedTo: [...new Set(fixedRestore.authorized.map(({ database }) => database))],
    tls: true,
    restoredRow: 'from-source',
    sourceRowsAfter: 1,
    files: modes.split('\n'),
  };

  // ---- fixtures -----------------------------------------------------------------------------
  log('fixtures: building the probe that stands in for the tools image');
  await inInstance(
    [
      'set -e',
      'install -d /srv/probe',
      "printf '%s\\n' '#!/bin/sh' 'printf \"probe-argv: %s\\n\" \"$*\"' " +
        '\'printf "probe-stdin-sha256: %s\\n" "$(sha256sum | cut -d " " -f 1)"\' > /srv/probe/probe.sh',
      'printf \'FROM postgres:18\\nCOPY probe.sh /probe.sh\\nENTRYPOINT ["/bin/sh", "/probe.sh"]\\n\' > /srv/probe/Dockerfile',
      `docker build -q -t ${PROBE_IMAGE} /srv/probe > /dev/null`,
    ].join('\n'),
  );
  const fixtureCommands = commands(await runbookBlock('fixtures'));
  const feedIndex = fixtureCommands.findIndex((command) => command.includes('docker run'));
  check(feedIndex > 0, 'the fixtures block has a docker run command after its preparation');
  const prepare = fixtureCommands.slice(0, feedIndex).join('\n');
  const feed = fixtureCommands[feedIndex] ?? '';
  const cleanup = fixtureCommands.slice(feedIndex + 1).join('\n');

  const prepared = await asOperator('fixtures-prepare', prepare, {
    input: `DATABASE_URL=postgresql://tradeflow_migrator:example@db.invalid:5432/tradeflow?sslmode=verify-full&sslrootcert=/etc/tradeflow/rds-ca.pem\n`,
  });
  check(prepared.code === 0, `the preparation ran as ssm-user (stderr: ${prepared.stderr.trim()})`);
  const fixtureModes = (
    await inInstance(
      'stat -c "%a %U %n" /run/tradeflow /run/tradeflow/fixtures.env /run/tradeflow/fixture-passwords.json',
    )
  ).stdout.trim();
  check(
    fixtureModes ===
      '700 root /run/tradeflow\n600 root /run/tradeflow/fixtures.env\n600 root /run/tradeflow/fixture-passwords.json',
    `fixture files are root-only (${fixtureModes})`,
  );
  const direct = await inInstance('cat /run/tradeflow/fixture-passwords.json', {
    user: 'ssm-user',
    allowFailure: true,
  });
  check(
    direct.code !== 0 && direct.stderr.includes('Permission denied'),
    'ssm-user cannot read the password file',
  );
  const passwordJson = (await inInstance('cat /run/tradeflow/fixture-passwords.json')).stdout;
  const passwords = Object.values(JSON.parse(passwordJson) as Record<string, string>);
  check(
    passwords.length === 3 && passwords.every((p) => /^[0-9a-f]{48}$/.test(p)),
    'three generated passwords',
  );
  const expectedSha = (
    await inInstance('sha256sum /run/tradeflow/fixture-passwords.json | cut -d " " -f 1')
  ).stdout.trim();

  log('fixtures: reviewed feed (redirection opened by the non-root shell)');
  const reviewedFeed = await asOperator('fixtures-reviewed', substitute(REVIEWED.fixtureFeed));
  check(reviewedFeed.code !== 0, 'the reviewed feed failed');
  check(
    reviewedFeed.stderr.includes('Permission denied'),
    'the reviewed feed failed with Permission denied',
  );
  check(!reviewedFeed.stdout.includes('probe-'), 'the reviewed feed never started the container');
  evidence.fixturesReviewed = {
    exitCode: reviewedFeed.code,
    error: reviewedFeed.stderr.match(/[^\n]*Permission denied[^\n]*/)?.[0]?.trim() ?? null,
    containerStarted: false,
  };

  log('fixtures: runbook feed (sudo cat | sudo docker run -i)');
  const fed = await asOperator('fixtures-feed', feed);
  check(fed.code === 0, `the runbook feed succeeded (stderr: ${fed.stderr.trim()})`);
  const received = /probe-stdin-sha256: ([0-9a-f]{64})/.exec(fed.stdout)?.[1];
  const argv = /probe-argv: (.*)/.exec(fed.stdout)?.[1] ?? '';
  check(received === expectedSha, 'the container received exactly the password file on stdin');
  check(
    argv.includes('--confirm-database db.invalid:5432/tradeflow'),
    'the container got the tool arguments',
  );
  for (const password of passwords) {
    check(!argv.includes(password), 'no password in the container arguments');
    check(!feed.includes(password), 'no password in the host command line');
    check(!fed.stderr.includes(password), 'no password in diagnostics');
  }
  const cleaned = await asOperator('fixtures-cleanup', cleanup);
  check(cleaned.code === 0, `the cleanup ran (stderr: ${cleaned.stderr.trim()})`);
  const remaining = (
    await inInstance('ls -A /run/tradeflow; stat -c "%a %U" /run/tradeflow')
  ).stdout.trim();
  check(
    !remaining.includes('fixture') && remaining.endsWith('700 root'),
    `fixture files removed, directory still private (${remaining.replaceAll('\n', ' ')})`,
  );
  evidence.fixturesRunbook = {
    exitCode: 0,
    caller: 'ssm-user (uid 1001, sudo)',
    files: fixtureModes.split('\n'),
    stdinMatchesFile: true,
    passwordsInArgumentsOrDiagnostics: false,
    removedAfterwards: true,
  };
  failed = false;
} finally {
  await execute('docker', ['rm', '--force', '--volumes', INSTANCE], { allowFailure: true });
  await execute('docker', ['image', 'rm', HOST_IMAGE], { allowFailure: true });
  const after = await dockerState();
  const unchanged = JSON.stringify(after) === JSON.stringify(before);
  evidence.cleanup = { dockerStateUnchanged: unchanged };
  console.log(
    JSON.stringify({ ...evidence, outcome: failed || !unchanged ? 'failed' : 'passed' }, null, 2),
  );
  if (!unchanged) {
    console.error('[runbook-check] Docker state differs from before the run');
    process.exitCode = 1;
  }
}
