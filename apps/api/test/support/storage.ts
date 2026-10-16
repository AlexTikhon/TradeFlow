import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Readable } from 'node:stream';
import type { StagedObject } from '../../src/infrastructure/storage/document-storage.js';
import { LocalDocumentStorage } from '../../src/infrastructure/storage/local-document-storage.js';

type Operation = 'stage' | 'promote' | 'discard' | 'read' | 'remove';

/**
 * The real local storage, in a temporary directory, that a test can make fail: `failNext`
 * makes the next call of an operation reject, like a full disk or an unavailable volume, after
 * doing nothing. Everything else is the production code path.
 */
export class TestStorage extends LocalDocumentStorage {
  private readonly failures = new Map<Operation, number>();

  private constructor(readonly root: string) {
    super(root);
  }

  static async create(): Promise<TestStorage> {
    return new TestStorage(await mkdtemp(join(tmpdir(), 'tradeflow-documents-')));
  }

  /** Makes the next `times` calls of `operation` fail. */
  failNext(operation: Operation, times = 1): void {
    this.failures.set(operation, times);
  }

  /** Forgets pending failures. */
  reset(): void {
    this.failures.clear();
  }

  /** File names in `staging/` or `objects/`, sorted. */
  async files(area: 'staging' | 'objects'): Promise<string[]> {
    const names = await readdir(join(this.root, area)).catch(() => []);
    return names.sort();
  }

  /** The path of a stored object, for tests that tamper with it. */
  pathOf(key: string): string {
    return join(this.root, 'objects', key);
  }

  /** Empties the storage between tests. */
  async clear(): Promise<void> {
    await rm(join(this.root, 'staging'), { recursive: true, force: true });
    await rm(join(this.root, 'objects'), { recursive: true, force: true });
  }

  async dispose(): Promise<void> {
    await rm(this.root, { recursive: true, force: true });
  }

  override async stage(source: Readable): Promise<StagedObject> {
    if (this.take('stage')) {
      source.destroy();
      throw new Error('storage unavailable: disk full');
    }
    return super.stage(source);
  }

  override async promote(staged: StagedObject): Promise<string> {
    if (this.take('promote')) throw new Error('storage unavailable: cannot move');
    return super.promote(staged);
  }

  override async discard(staged: StagedObject): Promise<void> {
    if (this.take('discard')) throw new Error('storage unavailable: cannot discard');
    return super.discard(staged);
  }

  override async read(key: string): Promise<Readable> {
    if (this.take('read')) throw new Error('storage unavailable: cannot read');
    return super.read(key);
  }

  override async remove(key: string): Promise<void> {
    if (this.take('remove')) throw new Error('storage unavailable: cannot remove');
    return super.remove(key);
  }

  private take(operation: Operation): boolean {
    const left = this.failures.get(operation) ?? 0;
    if (left === 0) return false;
    this.failures.set(operation, left - 1);
    return true;
  }
}
