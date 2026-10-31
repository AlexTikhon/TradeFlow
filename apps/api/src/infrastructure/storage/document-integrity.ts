import { createHash } from 'node:crypto';
import type { DocumentStorage } from './document-storage.js';
import { StoredObjectMissingError } from './document-storage.js';

export interface StoredVersion {
  id: string;
  storageKey: string;
  sizeBytes: number;
  sha256: Uint8Array;
}

/** Read-only reconciliation. Run with writers stopped; never decides that an orphan is safe to delete. */
export async function verifyDocumentObjects(
  versions: StoredVersion[],
  storage: DocumentStorage,
  keys: AsyncIterable<string>,
) {
  const referenced = new Set(versions.map((version) => version.storageKey));
  const orphans: string[] = [];
  for await (const key of keys) if (!referenced.has(key)) orphans.push(key);
  const problems: { versionId: string; key: string; kind: 'missing' | 'checksum' }[] = [];
  for (const version of versions) {
    try {
      const content = await storage.read(version.storageKey);
      const hash = createHash('sha256');
      let size = 0;
      for await (const chunk of content) {
        const bytes = chunk as Buffer;
        size += bytes.length;
        if (size > version.sizeBytes) break; // closes the stream, even for an unexpectedly huge object
        hash.update(bytes);
      }
      if (size !== version.sizeBytes || !hash.digest().equals(Buffer.from(version.sha256)))
        problems.push({ versionId: version.id, key: version.storageKey, kind: 'checksum' });
    } catch (error) {
      if (!(error instanceof StoredObjectMissingError)) throw error;
      problems.push({ versionId: version.id, key: version.storageKey, kind: 'missing' });
    }
  }
  return { versions: versions.length, problems, orphans: orphans.sort() };
}
