import { Module } from '@nestjs/common';
import { DocumentStorageModule } from '../../infrastructure/storage/storage.module.js';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { DocumentaryInstructionsModule } from '../documentary-instructions/documentary-instructions.module.js';
import { VoyagesModule } from '../voyages/voyages.module.js';
import { DocumentsController } from './documents.controller.js';
import { DocumentsService } from './documents.service.js';

/**
 * Owns `documents` and `document_versions`, and the bytes in document storage. Resolves sale
 * contracts through the voyages module's `CounterpartyContracts`, instruction revisions through
 * `InstructionRevisions`, the session as it is now through `SessionPrincipals`, and records its
 * actions through `AuditTrail`; it reads none of those modules' tables itself.
 */
@Module({
  imports: [
    VoyagesModule,
    DocumentaryInstructionsModule,
    AuthModule,
    AuditModule,
    DocumentStorageModule,
  ],
  controllers: [DocumentsController],
  providers: [DocumentsService],
})
export class DocumentsModule {}
