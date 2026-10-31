import type { Readable } from 'node:stream';

/*
 * Private storage for document bytes (ADR 0013). Small on purpose: what the documents module
 * needs to receive an upload outside any database transaction, keep it under a key of the
 * server's choosing, read it back, and undo it. Implemented by the local filesystem and S3.
 *
 * Bytes move through two places: a **staging** area while they are being received, and their
 * final place under a **key**. Neither is ever derived from anything the client sends.
 */

/** Bytes fully received into staging, not yet stored under a key. */
export interface StagedObject {
  readonly id: string;
}

/** Nothing is stored under the key: a data error, since only stored keys are ever recorded. */
export class StoredObjectMissingError extends Error {
  constructor(key: string) {
    super(`No stored object under key ${key}`);
    this.name = 'StoredObjectMissingError';
  }
}

/** The Nest injection token is the class itself. */
export abstract class DocumentStorage {
  /**
   * Writes `source` to staging and resolves once every byte is durably written. If `source`
   * fails or is destroyed (an aborted upload, a size limit), whatever was written is removed and
   * this rejects with that error.
   */
  abstract stage(source: Readable): Promise<StagedObject>;

  /**
   * Moves staged bytes to their final place under a new key, generated here, and returns it. The
   * staged object is used up. If this rejects, the staged bytes are still there to discard.
   * This may be a logical promotion: S3 already has the bytes under their final private key;
   * only recording that key in the database publishes them to authorized readers.
   */
  abstract promote(staged: StagedObject): Promise<string>;

  /** Removes staged bytes that will not be kept. Removing what is already gone is not an error. */
  abstract discard(staged: StagedObject): Promise<void>;

  /** Opens the bytes stored under `key`; rejects with `StoredObjectMissingError` if there are none. */
  abstract read(key: string): Promise<Readable>;

  /** Removes the bytes stored under `key`. Removing what is already gone is not an error. */
  abstract remove(key: string): Promise<void>;
}
