import type { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client';
import { identityKey, PROTECTED_QUERY_ROOT } from '../../shared/auth/identity';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../test/fixtures/auth';
import { serveSession } from '../../test/msw-server';
import {
  checkSession,
  endSession,
  getSignOutState,
  sessionChangedElsewhere,
  sessionQuery,
  StaleSessionCheckError,
  startSession,
  switchIdentity,
} from './session';

/*
 * The session helpers on their own, without React: correctness must come from the helpers'
 * transition state, not from a component unmounting and aborting its requests. Session checks
 * here are given a signal nothing ever aborts.
 */

const ana = aCurrentUser();
const claire = anotherUser();
const credentialsOf = (identity: typeof ana) => ({
  email: identity.user.email,
  password: TEST_PASSWORD,
});
const voyagesOf = (identity: typeof ana) => [
  PROTECTED_QUERY_ROOT,
  identityKey(identity),
  'voyages',
];
const neverAborted = () => new AbortController().signal;
const sessionOf = (queryClient: QueryClient) => queryClient.getQueryData(sessionQuery.queryKey);

function signedInClient(identity: typeof ana | null) {
  const queryClient = createQueryClient({ retry: false });
  queryClient.setQueryData(sessionQuery.queryKey, identity);
  return queryClient;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('session transitions', () => {
  it('ignores an anonymous session check that completes after sign-in', async () => {
    const session = serveSession(null, [ana]);
    const queryClient = signedInClient(null);
    const held = session.holdNext('me');
    const staleCheck = checkSession(queryClient, neverAborted());
    await held.received;

    await startSession(queryClient, credentialsOf(ana));
    queryClient.setQueryData(voyagesOf(ana), ['TF-ANA-ONLY']);
    held.release();

    await expect(staleCheck).rejects.toBeInstanceOf(StaleSessionCheckError);
    expect(sessionOf(queryClient)).toEqual(ana);
    expect(queryClient.getQueryData(voyagesOf(ana))).toEqual(['TF-ANA-ONLY']);
  });

  it('ignores an authenticated session check that completes after sign-out', async () => {
    const session = serveSession(ana);
    const queryClient = signedInClient(ana);
    const held = session.holdNext('me');
    const staleCheck = checkSession(queryClient, neverAborted());
    await held.received;

    await endSession(queryClient).settled;
    held.release();

    await expect(staleCheck).rejects.toBeInstanceOf(StaleSessionCheckError);
    expect(sessionOf(queryClient)).toBeNull();
  });

  it('cancels the cached session check when the identity is switched explicitly', async () => {
    const session = serveSession(ana);
    const queryClient = signedInClient(ana);
    const held = session.holdNext('me');
    // A check made through the cache, as a window-focus refetch makes it.
    const cachedCheck = queryClient.query({ ...sessionQuery, staleTime: 0 }).catch(() => undefined);
    await held.received;

    await switchIdentity(queryClient, null);
    held.release();
    await cachedCheck;

    expect(sessionOf(queryClient)).toBeNull();
  });

  it('lets the most recent explicit transition win', async () => {
    serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);

    const toNobody = switchIdentity(queryClient, null);
    const toClaire = switchIdentity(queryClient, claire);
    await Promise.all([toNobody, toClaire]);

    expect(sessionOf(queryClient)).toEqual(claire);
  });

  it('does not send a sign-in until an unfinished sign-out has been answered', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    const held = session.holdNext('sign-out');
    const signOut = endSession(queryClient);
    await signOut.signedOutLocally;
    await held.received;
    const fetchSpy = vi.spyOn(globalThis, 'fetch');

    const signIn = startSession(queryClient, credentialsOf(claire));

    expect(getSignOutState(queryClient).status).toBe('pending');
    expect(fetchSpy).not.toHaveBeenCalled();
    held.release();
    await signIn;

    expect(session.log).toEqual([
      'sign-out received',
      'sign-out answered',
      'sign-in received',
      'sign-in answered',
    ]);
    // The sign-out response cleared the old cookie before the new one was set.
    expect(session.current).toEqual(claire);
    expect(sessionOf(queryClient)).toEqual(claire);
    expect(getSignOutState(queryClient).status).toBe('idle');
  });

  it('does not publish a sign-in overtaken by a sign-out', async () => {
    const session = serveSession(null, [ana]);
    const queryClient = signedInClient(null);
    const held = session.holdNext('sign-in');
    const signIn = startSession(queryClient, credentialsOf(ana));
    await held.received;

    const signOut = endSession(queryClient);
    held.release();
    await signIn;
    await signOut.settled;

    expect(sessionOf(queryClient)).toBeNull();
    expect(session.current).toBeNull();
    expect(session.log).toEqual([
      'sign-in received',
      'sign-in answered',
      'sign-out received',
      'sign-out answered',
    ]);
  });

  it('reports a failed sign-out, keeps the identity signed out locally, and can retry', async () => {
    const session = serveSession(ana);
    const queryClient = signedInClient(ana);
    session.failNextSignOut();

    await endSession(queryClient).settled;

    expect(getSignOutState(queryClient).status).toBe('failed');
    expect(sessionOf(queryClient)).toBeNull();
    // The server still knows Ana, but the user asked to leave: checks must not bring her back.
    await expect(checkSession(queryClient, neverAborted())).resolves.toBeNull();
    await expect(queryClient.query({ ...sessionQuery, staleTime: 0 })).resolves.toBeNull();
    expect(session.meRequests).toBe(0);

    await endSession(queryClient).settled;

    expect(getSignOutState(queryClient).status).toBe('idle');
    expect(session.signOutRequests).toBe(2);
    expect(session.current).toBeNull();
  });

  it('a change in another tab aborts protected requests and outdates earlier session checks', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    let anasSignal: AbortSignal | undefined;
    void queryClient
      .query({
        queryKey: voyagesOf(ana),
        queryFn: ({ signal }) => {
          anasSignal = signal;
          return new Promise<never>(() => undefined);
        },
      })
      .catch(() => undefined);
    const held = session.holdNext('me');
    const staleCheck = checkSession(queryClient, neverAborted());
    await held.received;

    session.current = claire;
    await sessionChangedElsewhere(queryClient);

    expect(anasSignal?.aborted).toBe(true);
    expect(queryClient.getQueryCache().findAll({ queryKey: voyagesOf(ana) })).toHaveLength(0);
    expect(sessionOf(queryClient)).toBeUndefined();

    await expect(queryClient.query(sessionQuery)).resolves.toEqual(claire);
    queryClient.setQueryData(voyagesOf(claire), ['TF-CLAIRE-ONLY']);
    held.release();

    await expect(staleCheck).rejects.toBeInstanceOf(StaleSessionCheckError);
    expect(sessionOf(queryClient)).toEqual(claire);
    expect(queryClient.getQueryData(voyagesOf(claire))).toEqual(['TF-CLAIRE-ONLY']);
  });
});
