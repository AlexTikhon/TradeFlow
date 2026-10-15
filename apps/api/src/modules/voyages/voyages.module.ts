import { Module } from '@nestjs/common';
import { VoyagesController } from './voyages.controller.js';
import { VoyagesService } from './voyages.service.js';

@Module({
  controllers: [VoyagesController],
  providers: [VoyagesService],
})
export class VoyagesModule {}
