import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PassThrough, Readable } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StoredObjectMissingError } from './document-storage.js';
import { LocalDocumentStorage } from './local-document-storage.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

describe('LocalDocumentStorage', () => {
  let root: string;
  let storage: LocalDocumentStorage;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'tradeflow-storage-'));
    storage = new LocalDocumentStorage(root);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const files = async (directory: 'staging' | 'objects') =>
    readdir(join(root, directory)).catch(() => []);

  it('stages, promotes under a new UUID key, and reads back the same bytes', async () => {
    const bytes = randomBytes(256 * 1024);

    const staged = await storage.stage(Readable.from([bytes]));
    expect(await files('staging')).toEqual([`${staged.id}.part`]);
    const key = await storage.promote(staged);

    expect(key).toMatch(UUID);
    expect(await files('staging')).toEqual([]);
    expect(await files('objects')).toEqual([key]);
    expect(await buffer(await storage.read(key))).toEqual(bytes);
  });

  it('gives every promoted object a key of its own', async () => {
    const first = await storage.promote(await storage.stage(Readable.from([Buffer.from('a')])));
    const second = await storage.promote(await storage.stage(Readable.from([Buffer.from('a')])));

    expect(first).not.toBe(second);
  });

  it('keeps nothing of a source that fails part-way', async () => {
    const source = new PassThrough();
    const staging = storage.stage(source);
    source.write(randomBytes(64 * 1024));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(await files('staging')).toHaveLength(1);

    source.destroy(new Error('client went away'));

    await expect(staging).rejects.toThrow('client went away');
    expect(await files('staging')).toEqual([]);
  });

  it('discards staged bytes, and removes stored ones, idempotently', async () => {
    const staged = await storage.stage(Readable.from([Buffer.from('x')]));
    await storage.discard(staged);
    await storage.discard(staged);
    expect(await files('staging')).toEqual([]);

    const key = await storage.promote(await storage.stage(Readable.from([Buffer.from('y')])));
    await storage.remove(key);
    await storage.remove(key);
    expect(await files('objects')).toEqual([]);
  });

  it('reports a key with nothing stored under it', async () => {
    await expect(storage.read('01990000-0000-7000-8000-000000000000')).rejects.toBeInstanceOf(
      StoredObjectMissingError,
    );
  });

  it.each(['../staging', '..\\objects', 'a/b', '', 'not-a-key'])(
    'refuses %j as a key, before touching the filesystem',
    async (key) => {
      await expect(storage.read(key)).rejects.toThrow('Not a storage id');
      await expect(storage.remove(key)).rejects.toThrow('Not a storage id');
    },
  );
});
