import { queryOptions } from '@tanstack/react-query';
import type { ListVoyagesQuery } from '@tradeflow/contracts';
import { fetchVoyage, fetchVoyages } from './voyages.api';

/**
 * Query key hierarchy for voyages. Keys nest so that a future mutation can invalidate
 * precisely: `voyageQueries.all()` (everything), `lists()` (every filter), or one detail.
 */
export const voyageQueries = {
  all: () => ['voyages'] as const,
  lists: () => [...voyageQueries.all(), 'list'] as const,
  list: (query: ListVoyagesQuery) =>
    queryOptions({
      queryKey: [...voyageQueries.lists(), query] as const,
      queryFn: ({ signal }) => fetchVoyages(query, signal),
    }),
  detail: (voyageId: string) =>
    queryOptions({
      queryKey: [...voyageQueries.all(), 'detail', voyageId] as const,
      queryFn: ({ signal }) => fetchVoyage(voyageId, signal),
    }),
};
