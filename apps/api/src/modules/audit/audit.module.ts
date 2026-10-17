import { Module } from '@nestjs/common';
import { AuditTimeline } from './audit-timeline.js';
import { AuditTrail } from './audit-trail.js';

/**
 * Owns `audit_events`: records them (`AuditTrail`) and reads them as a voyage's timeline
 * (`AuditTimeline`). Nothing edits or deletes them. It imports no other module: callers that
 * know who may see what (the voyages module) pass that in, so the dependency runs one way.
 */
@Module({
  providers: [AuditTrail, AuditTimeline],
  exports: [AuditTrail, AuditTimeline],
})
export class AuditModule {}
