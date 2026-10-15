import { QueryCache, QueryClient } from '@tanstack/react-query';
import {
  dropAbandonedProtectedQueries,
  sessionQuery,
  switchIdentity,
} from '../features/auth/session';
import { ApiError, isUnauthenticated } from '../shared/api/http-client';
import { identityKey, PROTECTED_QUERY_ROOT } from '../shared/auth/identity';

const MAX_RETRIES = 2;

interface QueryClientOptions {
  /** Tests turn retries off so failures surface immediately. */
  retry?: boolean;
}

/**
 * Server-state defaults. Client errors (4xx) are deterministic, so retrying them only delays
 * the error screen; transient failures (network, 5xx) get a couple of retries.
 *
 * A 401 on protected data means the session ended (expired, or revoked elsewhere): the client
 * signs out locally, which drops that identity's data and sends the user to the sign-in page.
 * Only failures under the current identity count: a late answer to a request made for an
 * earlier identity must not sign out the current one.
 */
export function createQueryClient({ retry = true }: QueryClientOptions = {}): QueryClient {
  const queryClient: QueryClient = new QueryClient({
    queryCache: new QueryCache({
      onError: (error, query) => {
        const current = queryClient.getQueryData(sessionQuery.queryKey);
        if (
          isUnauthenticated(error) &&
          current &&
          query.queryKey[0] === PROTECTED_QUERY_ROOT &&
          query.queryKey[1] === identityKey(current)
        ) {
          void switchIdentity(queryClient, null);
        }
      },
    }),
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (!retry || (error instanceof ApiError && error.status < 500)) {
            return false;
          }
          return failureCount < MAX_RETRIES;
        },
      },
    },
  });
  dropAbandonedProtectedQueries(queryClient);
  return queryClient;
}
