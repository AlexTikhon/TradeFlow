import { Module } from '@nestjs/common';
import { ConfigModule } from './config/app-config.js';
import { HealthModule } from './health/health.module.js';
import { PrismaModule } from './infrastructure/prisma/prisma.module.js';
import { AuditModule } from './modules/audit/audit.module.js';
import { AuthModule } from './modules/auth/auth.module.js';
import { DocumentaryInstructionsModule } from './modules/documentary-instructions/documentary-instructions.module.js';
import { DocumentsModule } from './modules/documents/documents.module.js';
import { NoticesModule } from './modules/notices/notices.module.js';
import { OrganizationsModule } from './modules/organizations/organizations.module.js';
import { ReferenceDataModule } from './modules/reference-data/reference-data.module.js';
import { VoyagesModule } from './modules/voyages/voyages.module.js';

@Module({
  imports: [
    ConfigModule,
    PrismaModule,
    HealthModule,
    AuthModule,
    AuditModule,
    ReferenceDataModule,
    OrganizationsModule,
    VoyagesModule,
    NoticesModule,
    DocumentaryInstructionsModule,
    DocumentsModule,
  ],
})
export class AppModule {}
