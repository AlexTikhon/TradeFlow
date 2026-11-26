import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { ListObjectsV2Command, PutObjectCommand } from '@aws-sdk/client-s3';
import { MAX_DOCUMENT_BYTES } from '@tradeflow/contracts';
import { z } from 'zod';
import { loadConfig } from '../src/config/app-config.js';
import { PrismaService } from '../src/infrastructure/prisma/prisma.service.js';
import { verifyDocumentObjects } from '../src/infrastructure/storage/document-integrity.js';
import { S3DocumentStorage } from '../src/infrastructure/storage/s3-document-storage.js';

const Manifest = z.array(
  z
    .object({
      id: z.uuid(),
      storageKey: z.uuid(),
      sizeBytes: z.number().int().min(1).max(MAX_DOCUMENT_BYTES),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
    })
    .strict(),
);

/**
 * Non-secret identity of the stores a backup came from, and its actual recovery point. Written by
 * `export` beside the manifest (before it). `restore-check` and `import` compare it with the
 * configured target before any write, so a restore can never land on its own source.
 */
const SourceRecord = z
  .object({
    format: z.literal(1),
    exportedAt: z.iso.datetime(),
    database: z
      .object({
        urlHost: z.string(),
        urlPort: z.string(),
        database: z.string(),
        serverAddress: z.string().nullable(),
        serverPort: z.number().int().nullable(),
        systemIdentifier: z.string().nullable(),
      })
      .strict(),
    objects: z.object({ bucket: z.string(), prefix: z.string() }).strict(),
    recoveryPoint: z
      .object({
        latestAuditEventAt: z.iso.datetime().nullable(),
        auditEvents: z.number().int().min(0),
        documentVersions: z.number().int().min(0),
        latestMigration: z.string().nullable(),
      })
      .strict(),
  })
  .strict();
type SourceRecord = z.infer<typeof SourceRecord>;
type DatabaseIdentity = SourceRecord['database'];
type ObjectLocation = SourceRecord['objects'];

async function databaseIdentity(db: PrismaService, url: string): Promise<DatabaseIdentity> {
  const parsed = new URL(url);
  const [server] = await db.$queryRaw<
    { database: string; address: string | null; port: number | null }[]
  >`SELECT current_database() AS database, host(inet_server_addr()) AS address, inet_server_port() AS port`;
  let systemIdentifier: string | null;
  try {
    // Unique per cluster (initdb). A provider may deny it to some roles: the URL and the server
    // address still identify the target then.
    const [control] = await db.$queryRaw<
      { id: string }[]
    >`SELECT system_identifier::text AS id FROM pg_control_system()`;
    systemIdentifier = control?.id ?? null;
  } catch {
    systemIdentifier = null;
  }
  return {
    urlHost: parsed.hostname.toLowerCase(),
    urlPort: parsed.port || '5432',
    database: server?.database ?? decodeURIComponent(parsed.pathname.slice(1)),
    serverAddress: server?.address ?? null,
    serverPort: server?.port ?? null,
    systemIdentifier,
  };
}

async function recoveryPoint(db: PrismaService): Promise<SourceRecord['recoveryPoint']> {
  const [audit] = await db.$queryRaw<{ latest: Date | null; count: bigint }[]>`
    SELECT max(occurred_at) AS latest, count(*) AS count FROM audit_events`;
  const [migration] = await db.$queryRaw<{ name: string | null }[]>`
    SELECT max(migration_name) AS name FROM _prisma_migrations
    WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL`;
  return {
    latestAuditEventAt: audit?.latest ? audit.latest.toISOString() : null,
    auditEvents: Number(audit?.count ?? 0),
    documentVersions: await db.documentVersion.count(),
    latestMigration: migration?.name ?? null,
  };
}

/** Same name on the same cluster, host or server address. Errs towards "the same". */
function sameDatabase(a: DatabaseIdentity, b: DatabaseIdentity): boolean {
  if (a.database !== b.database) return false;
  return (
    (a.systemIdentifier !== null && a.systemIdentifier === b.systemIdentifier) ||
    (a.urlHost === b.urlHost && a.urlPort === b.urlPort) ||
    (a.serverAddress !== null &&
      a.serverAddress === b.serverAddress &&
      a.serverPort === b.serverPort)
  );
}

/**
 * Whether the two document object key spaces (`<prefix>objects/`) can share a key: one contains
 * the other. A restore under `tradeflow/restore-1/` beside a source at `tradeflow/` does not
 * (its objects are `tradeflow/restore-1/objects/…`, the source's `tradeflow/objects/…`), which
 * keeps it inside an API role scoped to `tradeflow/*`. Endpoints are ignored on purpose: two
 * endpoint names can reach the same store.
 */
function overlappingObjects(a: ObjectLocation, b: ObjectLocation): boolean {
  const [x, y] = [`${a.prefix}objects/`, `${b.prefix}objects/`];
  return a.bucket === b.bucket && (x.startsWith(y) || y.startsWith(x));
}

/** Relations or enum types outside the system schemas: anything pg_restore could collide with. */
async function databaseObjects(db: PrismaService): Promise<number> {
  const [row] = await db.$queryRaw<{ count: bigint }[]>`
    SELECT (SELECT count(*) FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
              AND n.nspname NOT LIKE 'pg_toast%' AND n.nspname NOT LIKE 'pg_temp%')
         + (SELECT count(*) FROM pg_type t JOIN pg_namespace n ON n.oid = t.typnamespace
            WHERE t.typtype = 'e' AND n.nspname NOT IN ('pg_catalog', 'information_schema'))
      AS count`;
  return Number(row?.count ?? 0);
}

/** Any key at all under the configured prefix, not only document objects. */
async function prefixHasObjects(storage: S3DocumentStorage): Promise<boolean> {
  const page = await storage.client.send(
    new ListObjectsV2Command({
      Bucket: storage.config.bucket,
      Prefix: storage.config.prefix,
      MaxKeys: 1,
    }),
  );
  return (page.Contents?.length ?? 0) > 0;
}

async function readSource(root: string): Promise<SourceRecord> {
  let text: string;
  try {
    text = await readFile(join(root, 'source.json'), 'utf8');
  } catch {
    throw new Error('Backup has no source.json: its source cannot be checked');
  }
  return SourceRecord.parse(JSON.parse(text));
}

async function backupBytes(root: string, file: z.infer<typeof Manifest>[number]): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of createReadStream(join(root, file.storageKey))) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    if (size > file.sizeBytes) throw new Error(`Backup checksum mismatch: ${file.storageKey}`);
    chunks.push(bytes);
  }
  const bytes = Buffer.concat(chunks);
  if (size !== file.sizeBytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256)
    throw new Error(`Backup checksum mismatch: ${file.storageKey}`);
  return bytes;
}

/** Object half of an offline, paired database+object backup; see docs/storage-recovery.md. */
async function main() {
  const [mode, directory] = process.argv.slice(2);
  if (
    !['verify', 'export', 'restore-check', 'import'].includes(mode ?? '') ||
    (mode !== 'verify' && !directory)
  )
    throw new Error(
      'Usage: document-objects.ts verify | export <new-directory> | restore-check <directory> | import <directory>',
    );
  const config = loadConfig(process.env);
  if (config.documentStorage.driver !== 's3')
    throw new Error('This command requires DOCUMENT_STORAGE_DRIVER=s3');
  const storage = new S3DocumentStorage(config.documentStorage);
  const db = new PrismaService(config);
  try {
    const target: ObjectLocation = { bucket: storage.config.bucket, prefix: storage.config.prefix };
    if (mode === 'restore-check') {
      // Read-only, before pg_restore (so before any table exists): the configured targets must
      // be empty and not the backup's source. Both identities are printed for the operator.
      const source = await readSource(resolve(directory ?? ''));
      const database = await databaseIdentity(db, config.databaseUrl);
      const refusals: string[] = [];
      if (sameDatabase(database, source.database))
        refusals.push('the target database is the backup source database');
      if ((await databaseObjects(db)) > 0) refusals.push('the target database is not empty');
      if (overlappingObjects(target, source.objects))
        refusals.push("the target object prefix overlaps the backup source's");
      if (await prefixHasObjects(storage)) refusals.push('the target object prefix is not empty');
      console.log(
        JSON.stringify({ source, target: { database, objects: target }, refusals }, null, 2),
      );
      if (refusals.length) throw new Error(`Refusing to restore: ${refusals.join('; ')}`);
      return;
    }
    const versions = await db.documentVersion.findMany({
      select: { id: true, storageKey: true, sizeBytes: true, sha256: true },
      orderBy: { id: 'asc' },
    });
    const manifest = versions.map((v) => ({ ...v, sha256: Buffer.from(v.sha256).toString('hex') }));
    if (mode === 'import') {
      // The restored DB must match this backup exactly; target prefix must be completely empty.
      const root = resolve(directory ?? '');
      const source = await readSource(root);
      if (overlappingObjects(target, source.objects))
        throw new Error("Refusing to import into the backup source's object prefix");
      if (sameDatabase(await databaseIdentity(db, config.databaseUrl), source.database))
        throw new Error('Refusing to import: the configured database is the backup source');
      const saved = Manifest.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
      if (JSON.stringify(saved) !== JSON.stringify(manifest))
        throw new Error('Manifest does not match the restored database');
      // The database dump and the object export must come from the same maintenance snapshot.
      if (JSON.stringify(await recoveryPoint(db)) !== JSON.stringify(source.recoveryPoint))
        throw new Error('The restored database is not the recovery point in source.json');
      for await (const _key of storage.keys())
        throw new Error('Refusing to import into a non-empty object prefix');
      // Validate the entire backup before the first target write, with bounded file reads.
      for (const file of saved) await backupBytes(root, file);
      for (const file of saved) {
        const bytes = await backupBytes(root, file);
        await storage.client.send(
          new PutObjectCommand({
            Bucket: storage.config.bucket,
            Key: storage.objectKey(file.storageKey),
            Body: bytes,
            ContentType: 'application/pdf',
            IfNoneMatch: '*',
          }),
        );
      }
    } else if (mode === 'export') {
      const report = await verifyDocumentObjects(versions, storage, storage.keys());
      if (report.problems.length || report.orphans.length)
        throw new Error('Reconcile storage before backup; run document-objects verify');
      const root = resolve(directory ?? '');
      await mkdir(root, { mode: 0o700 }); // refuse an existing path; never overwrite another backup
      const source: SourceRecord = {
        format: 1,
        exportedAt: new Date().toISOString(),
        database: await databaseIdentity(db, config.databaseUrl),
        objects: target,
        recoveryPoint: await recoveryPoint(db),
      };
      await writeFile(join(root, 'source.json'), JSON.stringify(source, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
      for (const file of manifest) {
        const content = await storage.read(file.storageKey);
        const chunks: Buffer[] = [];
        let size = 0;
        for await (const chunk of content) {
          const bytes = chunk as Buffer;
          size += bytes.length;
          if (size > file.sizeBytes) throw new Error('Stored object changed during backup');
          chunks.push(bytes);
        }
        const bytes = Buffer.concat(chunks);
        if (
          size !== file.sizeBytes ||
          createHash('sha256').update(bytes).digest('hex') !== file.sha256
        )
          throw new Error('Stored object changed during backup');
        await writeFile(join(root, file.storageKey), bytes, { mode: 0o600, flag: 'wx' });
      }
      // Written last: a partial export never looks complete.
      await writeFile(join(root, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', {
        mode: 0o600,
        flag: 'wx',
      });
    }
    const report = await verifyDocumentObjects(versions, storage, storage.keys());
    console.log(JSON.stringify(report, null, 2));
    if (report.problems.length || report.orphans.length) process.exitCode = 1;
  } finally {
    await db.$disconnect();
    storage.onModuleDestroy();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Storage maintenance failed');
  process.exitCode = 1;
});
