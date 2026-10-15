import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { VoyagesModule } from '../voyages/voyages.module.js';
import { NoticesController } from './notices.controller.js';
import { NoticesService } from './notices.service.js';

/**
 * Owns `notices`. Resolves sale contracts through the voyages module's `CounterpartyContracts`
 * and records its actions through `AuditTrail`; it reads neither module's tables itself.
 */
@Module({
  imports: [VoyagesModule, AuditModule],
  controllers: [NoticesController],
  providers: [NoticesService],
})
export class NoticesModule {}
