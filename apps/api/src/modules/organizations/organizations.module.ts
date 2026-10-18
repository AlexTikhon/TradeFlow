import { Module } from '@nestjs/common';
import { OrganizationsController } from './organizations.controller.js';
import { OrganizationsService } from './organizations.service.js';

/** Reads the curated set of organizations. Nothing creates, invites or edits them (ADR 0016). */
@Module({
  controllers: [OrganizationsController],
  providers: [OrganizationsService],
})
export class OrganizationsModule {}
