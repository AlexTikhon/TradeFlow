import {
  type ActionItemPage,
  ActionItemPageSchema,
  type ActionItemType,
} from '@tradeflow/contracts';
import { getJson } from '../../../shared/api/http-client';

/** The queue's filters, as `GET /api/action-items` takes them. */
export interface ActionItemFilters {
  type?: ActionItemType;
  /** Only overdue actions; leave it out for all. */
  overdue?: true;
}

/**
 * One page of the organization's open actions: the first one without `cursor`, then the one after
 * each page's `nextCursor`, sent unchanged with the same filters (ADR 0017).
 */
export function fetchActionItems(
  filters: ActionItemFilters,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<ActionItemPage> {
  return getJson('/action-items', ActionItemPageSchema, {
    query: { type: filters.type, overdue: filters.overdue && 'true', cursor },
    ...(signal && { signal }),
  });
}
