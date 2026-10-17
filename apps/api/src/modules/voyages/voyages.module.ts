import { Module } from '@nestjs/common';
import { AuditModule } from '../audit/audit.module.js';
import { AuthModule } from '../auth/auth.module.js';
import { ReferenceDataModule } from '../reference-data/reference-data.module.js';
import { CounterpartyContracts } from './counterparty-contracts.js';
import { CounterpartyContractsController } from './counterparty-contracts.controller.js';
import { TradeStringController } from './trade-string.controller.js';
import { TradeStringService } from './trade-string.service.js';
import { VoyageEventBus } from './voyage-event-bus.js';
import {
  DEFAULT_VOYAGE_EVENT_STREAM_OPTIONS,
  VOYAGE_EVENT_STREAM_OPTIONS,
  VoyageEventStreams,
} from './voyage-event-streams.js';
import { VoyageEventsController } from './voyage-events.controller.js';
import { VoyageTimelineController } from './voyage-timeline.controller.js';
import { VoyageTimelineService } from './voyage-timeline.service.js';
import { VoyagesController } from './voyages.controller.js';
import { VoyagesService } from './voyages.service.js';

@Module({
  imports: [ReferenceDataModule, AuditModule, AuthModule],
  controllers: [
    VoyagesController,
    TradeStringController,
    CounterpartyContractsController,
    VoyageTimelineController,
    VoyageEventsController,
  ],
  providers: [
    VoyagesService,
    TradeStringService,
    CounterpartyContracts,
    VoyageTimelineService,
    VoyageEventBus,
    VoyageEventStreams,
    { provide: VOYAGE_EVENT_STREAM_OPTIONS, useValue: DEFAULT_VOYAGE_EVENT_STREAM_OPTIONS },
  ],
  // Other modules resolve sale contracts through `CounterpartyContracts`, never through the
  // tables, and announce committed changes to open voyage streams through `VoyageEventBus`.
  exports: [CounterpartyContracts, VoyageEventBus],
})
export class VoyagesModule {}
