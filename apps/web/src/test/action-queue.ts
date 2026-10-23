import type { QueryClient } from '@tanstack/react-query';
import type { CurrentUser } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { identityKey, PROTECTED_QUERY_ROOT } from '../shared/auth/identity';
import { actionQueueKey } from '../shared/cache/action-queue';
import { emptyActionPage } from './fixtures/action-items';
import { server } from './msw-server';

/**
 * A queue `identity` read in the Action Center, still cached though nothing shows it: what a
 * command on a voyage's page must invalidate, and must not fetch. Call it once the session it is
 * for has been published; every request for the queue is counted.
 */
export function cachedActionQueue(queryClient: QueryClient, identity: CurrentUser) {
  const queryKey = [...actionQueueKey([PROTECTED_QUERY_ROOT, identityKey(identity)]), {}];
  queryClient.setQueryData(queryKey, emptyActionPage());
  let requests = 0;
  server.use(
    http.get('*/api/action-items', () => {
      requests += 1;
      return HttpResponse.json(emptyActionPage());
    }),
  );
  return {
    /** Whether it has been marked for reading again; undefined once dropped from the cache. */
    invalidated: () => queryClient.getQueryState(queryKey)?.isInvalidated,
    requests: () => requests,
  };
}
