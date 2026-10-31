import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { PutObjectCommand } from '@aws-sdk/client-s3';
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
  if (!['verify', 'export', 'import'].includes(mode ?? '') || (mode !== 'verify' && !directory))
    throw new Error(
      'Usage: document-objects.ts verify | export <new-directory> | import <directory>',
    );
  const config = loadConfig(process.env);
  if (config.documentStorage.driver !== 's3')
    throw new Error('This command requires DOCUMENT_STORAGE_DRIVER=s3');
  const storage = new S3DocumentStorage(config.documentStorage);
  const db = new PrismaService(config);
  try {
    const versions = await db.documentVersion.findMany({
      select: { id: true, storageKey: true, sizeBytes: true, sha256: true },
      orderBy: { id: 'asc' },
    });
    const manifest = versions.map((v) => ({ ...v, sha256: Buffer.from(v.sha256).toString('hex') }));
    if (mode === 'import') {
      // The restored DB must match this backup exactly; target prefix must be completely empty.
      const root = resolve(directory ?? '');
      const saved = Manifest.parse(JSON.parse(await readFile(join(root, 'manifest.json'), 'utf8')));
      if (JSON.stringify(saved) !== JSON.stringify(manifest))
        throw new Error('Manifest does not match the restored database');
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
