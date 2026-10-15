import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ReferenceDataModule } from '../reference-data/reference-data.module.js';
import { TradeStringController } from './trade-string.controller.js';
import { TradeStringService } from './trade-string.service.js';
import { VoyagesController } from './voyages.controller.js';
import { VoyagesService } from './voyages.service.js';

@Module({
  imports: [ReferenceDataModule, AuditModule],
  controllers: [VoyagesController, TradeStringController],
  providers: [VoyagesService, TradeStringService],
})
export class VoyagesModule {}
