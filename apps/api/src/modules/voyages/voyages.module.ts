import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ReferenceDataModule } from '../reference-data/reference-data.module.js';
import { CounterpartyContracts } from './counterparty-contracts.js';
import { CounterpartyContractsController } from './counterparty-contracts.controller.js';
import { TradeStringController } from './trade-string.controller.js';
import { TradeStringService } from './trade-string.service.js';
import { VoyageTimelineController } from './voyage-timeline.controller.js';
import { VoyageTimelineService } from './voyage-timeline.service.js';
import { VoyagesController } from './voyages.controller.js';
import { VoyagesService } from './voyages.service.js';

@Module({
  imports: [ReferenceDataModule, AuditModule],
  controllers: [
    VoyagesController,
    TradeStringController,
    CounterpartyContractsController,
    VoyageTimelineController,
  ],
  providers: [VoyagesService, TradeStringService, CounterpartyContracts, VoyageTimelineService],
  // Other modules resolve sale contracts through this provider, never through the tables.
  exports: [CounterpartyContracts],
})
export class VoyagesModule {}
