import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { ReferenceDataModule } from '../reference-data/reference-data.module.js';
import { VoyagesController } from './voyages.controller.js';
import { VoyagesService } from './voyages.service.js';

@Module({
  imports: [ReferenceDataModule, AuditModule],
  controllers: [VoyagesController],
  providers: [VoyagesService],
})
export class VoyagesModule {}
