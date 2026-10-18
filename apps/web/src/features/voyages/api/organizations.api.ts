import { queryOptions } from '@tanstack/react-query';
import {
  type OrganizationSearchResponse,
  OrganizationSearchResponseSchema,
} from '@tradeflow/contracts';
import { getJson } from '../../../shared/api/http-client';
import type { ProtectedScope } from '../../../shared/auth/identity';

/** Organizations whose name contains `search` (operators only; never the caller's own). */
export function searchOrganizations(
  search: string,
  signal?: AbortSignal,
): Promise<OrganizationSearchResponse> {
  return getJson('/organizations', OrganizationSearchResponseSchema, {
    query: { search },
    ...(signal && { signal }),
  });
}

/**
 * Searches belong to the identity that made them (the API answers per organization and role),
 * so they live under its scope and go with it on every identity change.
 */
export const organizationQueries = {
  search: (scope: ProtectedScope, search: string) =>
    queryOptions({
      queryKey: [...scope, 'organizations', 'search', search] as const,
      queryFn: ({ signal }) => searchOrganizations(search, signal),
    }),
};
