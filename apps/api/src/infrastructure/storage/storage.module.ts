import { Module } from '@nestjs/common';
import { APP_CONFIG, type AppConfig } from '../../config/app-config.js';
import { DocumentStorage } from './document-storage.js';
import { createDocumentStorage } from './create-document-storage.js';

/** Provides the explicitly configured private storage adapter. */
@Module({
  providers: [
    {
      provide: DocumentStorage,
      useFactory: (config: AppConfig) => createDocumentStorage(config),
      inject: [APP_CONFIG],
    },
  ],
  exports: [DocumentStorage],
})
export class DocumentStorageModule {}
