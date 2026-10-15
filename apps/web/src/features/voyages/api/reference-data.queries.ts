import { queryOptions } from '@tanstack/react-query';
import type { ProtectedScope } from '../../../shared/auth/identity';
import { fetchCommodities, fetchPorts, fetchVessels } from './reference-data.api';

/**
 * Vessels, commodities and ports are the same for every organization, but they are fetched with
 * a session, so they live under the identity's scope like everything else fetched that way and
 * are dropped with it. They change rarely: cached for longer than the default.
 */
const REFERENCE_DATA_STALE_TIME = 10 * 60_000;

export const referenceDataQueries = {
  vessels: (scope: ProtectedScope) =>
    queryOptions({
      queryKey: [...scope, 'reference-data', 'vessels'] as const,
      queryFn: ({ signal }) => fetchVessels(signal),
      staleTime: REFERENCE_DATA_STALE_TIME,
    }),
  commodities: (scope: ProtectedScope) =>
    queryOptions({
      queryKey: [...scope, 'reference-data', 'commodities'] as const,
      queryFn: ({ signal }) => fetchCommodities(signal),
      staleTime: REFERENCE_DATA_STALE_TIME,
    }),
  ports: (scope: ProtectedScope) =>
    queryOptions({
      queryKey: [...scope, 'reference-data', 'ports'] as const,
      queryFn: ({ signal }) => fetchPorts(signal),
      staleTime: REFERENCE_DATA_STALE_TIME,
    }),
};
