import { type VoyageTimelinePage, VoyageTimelinePageSchema } from '@tradeflow/contracts';
import { getJson } from '../../../shared/api/http-client';

/**
 * One page of the voyage's timeline as the signed-in organization may see it, newest first.
 * `cursor` is the previous page's `nextCursor`, passed back unchanged; absent for the first page.
 */
export function fetchVoyageTimeline(
  voyageId: string,
  cursor: string | undefined,
  signal?: AbortSignal,
): Promise<VoyageTimelinePage> {
  return getJson(`/voyages/${encodeURIComponent(voyageId)}/timeline`, VoyageTimelinePageSchema, {
    query: { cursor },
    ...(signal && { signal }),
  });
}
