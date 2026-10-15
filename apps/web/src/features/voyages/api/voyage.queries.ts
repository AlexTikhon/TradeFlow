import { queryOptions } from '@tanstack/react-query';
import type { ListVoyagesQuery } from '@tradeflow/contracts';
import type { ProtectedScope } from '../../../shared/auth/identity';
import { fetchMyContracts, fetchNotices } from './notices.api';
import { fetchTradeString, fetchVoyage, fetchVoyages } from './voyages.api';

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
  /** Nested under the voyage's detail key, so invalidating a voyage refreshes its string too. */
  tradeString: (scope: ProtectedScope, voyageId: string) =>
    queryOptions({
      queryKey: [...voyageQueries.all(scope), 'detail', voyageId, 'trade-string'] as const,
      queryFn: ({ signal }) => fetchTradeString(voyageId, signal),
    }),
  /** The organization's own contracts on the voyage (for choosing one to act under). */
  myContracts: (scope: ProtectedScope, voyageId: string) =>
    queryOptions({
      queryKey: [...voyageQueries.all(scope), 'detail', voyageId, 'my-contracts'] as const,
      queryFn: ({ signal }) => fetchMyContracts(voyageId, signal),
    }),
  /** Notices under the organization's contracts; nested under the voyage like its string. */
  notices: (scope: ProtectedScope, voyageId: string) =>
    queryOptions({
      queryKey: [...voyageQueries.all(scope), 'detail', voyageId, 'notices'] as const,
      queryFn: ({ signal }) => fetchNotices(voyageId, signal),
    }),
};
