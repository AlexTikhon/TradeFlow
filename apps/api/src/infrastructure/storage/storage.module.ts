import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { DocumentStorage } from './document-storage.js';
import { LocalDocumentStorage } from './local-document-storage.js';

/** Provides `DocumentStorage`: the local filesystem, under the configured private directory. */
@Module({
  providers: [
    {
      provide: DocumentStorage,
      useFactory: (config: AppConfig) => new LocalDocumentStorage(config.documentStorage.directory),
      inject: [APP_CONFIG],
    },
  ],
  exports: [DocumentStorage],
})
export class DocumentStorageModule {}
