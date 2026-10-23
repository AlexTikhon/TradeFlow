import { Module } from '@nestjs/common';
import { DocumentaryInstructionsModule } from '../documentary-instructions/documentary-instructions.module.js';
import { DocumentsModule } from '../documents/documents.module.js';
import { NoticesModule } from '../notices/notices.module.js';
import { VoyagesModule } from '../voyages/voyages.module.js';
import { ActionCenterController } from './action-center.controller.js';
import { ACTION_CENTER_CLOCK, ActionCenterService, type Clock } from './action-center.service.js';

/**
 * Owns no table (ADR 0017). Resolves the contracts in scope through the voyages module's
 * `CounterpartyContracts`, and reads each kind of fact through the reader its owning module
 * exports: `IssuedNotices`, `CurrentRevisions`, `LatestDocumentVersions`. None of those modules
 * depends on this one.
 */
@Module({
  imports: [VoyagesModule, NoticesModule, DocumentaryInstructionsModule, DocumentsModule],
  controllers: [ActionCenterController],
  providers: [
    ActionCenterService,
    { provide: ACTION_CENTER_CLOCK, useValue: (() => new Date()) satisfies Clock },
  ],
})
export class ActionCenterModule {}
