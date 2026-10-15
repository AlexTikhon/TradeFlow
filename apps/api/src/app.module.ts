import { Module } from '@nestjs/common';
import { ConfigModule } from './config/app-config.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { VoyagesModule } from './modules/voyages/voyages.module.js';

@Module({
  imports: [ConfigModule, PrismaModule, HealthModule, VoyagesModule],
})
export class AppModule {}
