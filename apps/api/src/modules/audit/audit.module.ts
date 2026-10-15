import { Module } from '@nestjs/common';
import { AuditTrail } from './audit-trail.js';

/** Owns `audit_events`. Write-only for now: there is no endpoint that reads, edits or deletes. */
@Module({
  providers: [AuditTrail],
  exports: [AuditTrail],
})
export class AuditModule {}
