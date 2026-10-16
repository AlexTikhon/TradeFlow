import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { VoyagesModule } from '../voyages/voyages.module.js';
import { DocumentaryInstructionsController } from './documentary-instructions.controller.js';
import { DocumentaryInstructionsService } from './documentary-instructions.service.js';

/**
 * Owns `documentary_instructions` and their revisions and acknowledgements. Resolves sale
 * contracts through the voyages module's `CounterpartyContracts` and records its actions
 * through `AuditTrail`; it reads neither module's tables itself.
 */
@Module({
  imports: [VoyagesModule, AuditModule],
  controllers: [DocumentaryInstructionsController],
  providers: [DocumentaryInstructionsService],
})
export class DocumentaryInstructionsModule {}
