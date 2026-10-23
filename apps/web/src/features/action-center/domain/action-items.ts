import {
  type ActionItem,
  type ActionItemType,
  ActionItemTypeSchema,
  type DocumentVersionTarget,
} from '@tradeflow/contracts';
import { DOCUMENT_LABELS } from '../../voyages/domain/documentary-instructions';
import type { ActionItemFilters } from '../api/action-items.api';

/*
 * Presentation rules for the Action Center. Which actions exist, who owes them and which are
 * overdue are the API's to decide (ADR 0017); these only name them and say where to go.
 */

export const ACTION_TYPE_LABELS: Record<ActionItemType, string> = {
  ACKNOWLEDGE_NOTICE: 'Acknowledge ETA notice',
  ACKNOWLEDGE_INSTRUCTIONS: 'Acknowledge instructions',
  REVIEW_DOCUMENT: 'Review document',
  REPLACE_REJECTED_DOCUMENT: 'Replace rejected document',
};

/** The URL's filters: those it states validly, and the names of those it states otherwise. */
export interface QueueFilters {
  filters: ActionItemFilters;
  /** Parameters present with a value the queue does not know; they are ignored. */
  ignored: ('type' | 'overdue')[];
}

/**
 * Reads the queue's filters from the address, which anyone may have edited. A value the queue
 * does not know (or a parameter given twice) is ignored, never guessed at, and reported, so the
 * page can say it shows the queue without it.
 */
export function parseQueueFilters(search: URLSearchParams): QueueFilters {
  const filters: ActionItemFilters = {};
  const ignored: QueueFilters['ignored'] = [];

  const types = search.getAll('type');
  if (types.length > 0) {
    const type = types.length === 1 ? ActionItemTypeSchema.safeParse(types[0]) : undefined;
    if (type?.success) filters.type = type.data;
    else ignored.push('type');
  }
  const overdue = search.getAll('overdue');
  if (overdue.length > 0) {
    if (overdue.length === 1 && overdue[0] === 'true') filters.overdue = true;
    else ignored.push('overdue');
  }
  return { filters, ignored };
}

/** The address's parameters for `filters`: nothing else, so ignored values are dropped. */
export function queueSearch({ type, overdue }: ActionItemFilters): URLSearchParams {
  const search = new URLSearchParams();
  if (type) search.set('type', type);
  if (overdue) search.set('overdue', 'true');
  return search;
}

const documentLabel = ({ target }: { target: DocumentVersionTarget }) =>
  DOCUMENT_LABELS[target.documentType].toLowerCase();

/** What the organization is asked to do, in a sentence. */
export function describeRequiredAction(item: ActionItem): string {
  switch (item.type) {
    case 'ACKNOWLEDGE_NOTICE':
      return `Acknowledge receipt of the ETA notice ${item.counterparty.name} issued.`;
    case 'ACKNOWLEDGE_INSTRUCTIONS':
      return `Acknowledge receipt of revision ${item.target.revisionNumber} of the documentary instructions ${item.counterparty.name} gave.`;
    case 'REVIEW_DOCUMENT':
      return `Approve or reject version ${item.target.versionNumber} of the ${documentLabel(item)} ${item.counterparty.name} presented.`;
    case 'REPLACE_REJECTED_DOCUMENT':
      return `Upload a replacement for version ${item.target.versionNumber} of the ${documentLabel(item)}, which ${item.counterparty.name} rejected.`;
  }
}

/** The exact revision or file version the action concerns; null for a notice. */
export function describeRecord(item: ActionItem): string | null {
  switch (item.target.kind) {
    case 'NOTICE':
      return null;
    case 'INSTRUCTION_REVISION':
      return `Revision ${item.target.revisionNumber}`;
    case 'DOCUMENT_VERSION':
      return `${DOCUMENT_LABELS[item.target.documentType]}, version ${item.target.versionNumber} (instructions revision ${item.target.revisionNumber})`;
  }
}

/** The text of the link to the record, which starts its accessible name too. */
export function openLabel(item: ActionItem): string {
  switch (item.target.kind) {
    case 'NOTICE':
      return 'Open ETA notice';
    case 'INSTRUCTION_REVISION':
      return `Open revision ${item.target.revisionNumber}`;
    case 'DOCUMENT_VERSION':
      return `Open version ${item.target.versionNumber}`;
  }
}
