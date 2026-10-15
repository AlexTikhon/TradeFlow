import { QueryClient } from '@tanstack/react-query';
import { ApiError } from '../shared/api/http-client';

const MAX_RETRIES = 2;

/**
 * Server-state defaults. Client errors (4xx) are deterministic, so retrying them only delays
 * the error screen; transient failures (network, 5xx) get a couple of retries.
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        retry: (failureCount, error) => {
          if (error instanceof ApiError && error.status < 500) {
            return false;
          }
          return failureCount < MAX_RETRIES;
        },
      },
    },
  });
}
