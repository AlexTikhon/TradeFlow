import type { AppConfig } from '../../config/app-config.js';
import type { DocumentStorage } from './document-storage.js';
import { LocalDocumentStorage } from './local-document-storage.js';
import { S3DocumentStorage } from './s3-document-storage.js';

/** Shared by the API and seed so cleanup always addresses the configured store. */
export function createDocumentStorage(config: AppConfig): DocumentStorage {
  return config.documentStorage.driver === 's3'
    ? new S3DocumentStorage(config.documentStorage)
    : new LocalDocumentStorage(config.documentStorage.directory);
}
