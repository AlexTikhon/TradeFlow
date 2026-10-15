import { queryOptions } from '@tanstack/react-query';
import type { ListVoyagesQuery } from '@tradeflow/contracts';
import type { ProtectedScope } from '../../../shared/auth/identity';
import { fetchVoyage, fetchVoyages } from './voyages.api';

/**
 * Query key hierarchy for voyages. Voyage data is visible only to participating organizations,
 * so every key starts with the signed-in identity's scope (`useProtectedScope()`). Keys nest so
 * that a future mutation can invalidate precisely: `all(scope)`, `lists(scope)`, or one detail.
 */
export const voyageQueries = {
  all: (scope: ProtectedScope) => [...scope, 'voyages'] as const,
  lists: (scope: ProtectedScope) => [...voyageQueries.all(scope), 'list'] as const,
  list: (scope: ProtectedScope, query: ListVoyagesQuery) =>
    queryOptions({
      queryKey: [...voyageQueries.lists(scope), query] as const,
      queryFn: ({ signal }) => fetchVoyages(query, signal),
    }),
  detail: (scope: ProtectedScope, voyageId: string) =>
    queryOptions({
      queryKey: [...voyageQueries.all(scope), 'detail', voyageId] as const,
      queryFn: ({ signal }) => fetchVoyage(voyageId, signal),
    }),
};
