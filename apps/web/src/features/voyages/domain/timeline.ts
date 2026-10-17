import type { TimelineEvent } from '@tradeflow/contracts';
import { DOCUMENT_LABELS } from './documentary-instructions';

/*
 * How timeline events read. The API serves identifiers only, so each sentence is built from the
 * action, the revision or file version it names, and the document type: never from contents.
 */

const documentName = (event: { documentType: keyof typeof DOCUMENT_LABELS }) =>
  DOCUMENT_LABELS[event.documentType].toLowerCase();

/** "Uploaded version 2 of the bill of lading (instructions revision 1)" */
export function describeTimelineEvent(event: TimelineEvent): string {
  switch (event.action) {
    case 'VOYAGE_CREATED':
      return 'Created the voyage';
    case 'NOTICE_ISSUED':
      return 'Issued a notice';
    case 'NOTICE_ACKNOWLEDGED':
      return 'Acknowledged receipt of a notice';
    case 'DOCUMENTARY_INSTRUCTION_REVISED':
      return event.revisionNumber === 1
        ? 'Gave documentary instructions'
        : `Revised the documentary instructions (revision ${event.revisionNumber})`;
    case 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED':
      return `Acknowledged revision ${event.revisionNumber} of the documentary instructions`;
    case 'DOCUMENT_VERSION_UPLOADED':
      return `Uploaded version ${event.versionNumber} of the ${documentName(event)} (instructions revision ${event.revisionNumber})`;
    case 'DOCUMENT_VERSION_REVIEWED':
      return `${event.decision === 'APPROVED' ? 'Approved' : 'Rejected'} version ${event.versionNumber} of the ${documentName(event)} (instructions revision ${event.revisionNumber})`;
  }
}

/** "Contract 2", or null for an event about the voyage itself. */
export const timelineContractLabel = (event: TimelineEvent): string | null =>
  'contract' in event ? `Contract ${event.contract.position}` : null;
