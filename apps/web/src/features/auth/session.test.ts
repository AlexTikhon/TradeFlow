import type { QueryClient } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createQueryClient } from '../../app/query-client';
import { ApiError } from '../../shared/api/http-client';
import { identityKey, PROTECTED_QUERY_ROOT } from '../../shared/auth/identity';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../test/fixtures/auth';
import { type FakeSession, serveSession } from '../../test/msw-server';
import {
  checkSession,
  currentSessionEpoch,
  endSession,
  getSignOutState,
  isCurrentSession,
  sendForCurrentSession,
  sessionChangedElsewhere,
  sessionExpired,
  sessionQuery,
  StaleSessionCheckError,
  StaleSessionCommandError,
  subscribeToSessionTransitions,
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

  it('ignores a session check answering for another identity while a sign-in is pending', async () => {
    // The cookie belongs to Ana (another tab signed in), and this tab is signing in as Claire.
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(null);
    const check = session.holdNext('me');
    const staleCheck = checkSession(queryClient, neverAborted());
    await check.received;
    const signIn = session.holdNext('sign-in');
    const signingIn = startSession(queryClient, credentialsOf(claire));
    await signIn.received;

    check.release();
    await expect(staleCheck).rejects.toBeInstanceOf(StaleSessionCheckError);
    // A check made while the sign-in is pending does not ask the server for someone else.
    await expect(queryClient.query({ ...sessionQuery, staleTime: 0 })).resolves.toBeNull();
    expect(session.meRequests).toBe(1);
    expect(sessionOf(queryClient)).toBeNull();

    signIn.release();
    await signingIn;
    expect(sessionOf(queryClient)).toEqual(claire);
  });

  it('hides the current identity as soon as a sign-in starts', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    queryClient.setQueryData(voyagesOf(ana), ['TF-ANA-ONLY']);
    const signIn = session.holdNext('sign-in');

    const signingIn = startSession(queryClient, credentialsOf(claire));
    await signIn.received;

    expect(sessionOf(queryClient)).toBeNull();
    expect(queryClient.getQueryData(voyagesOf(ana))).toBeUndefined();
    signIn.release();
    await signingIn;
    expect(sessionOf(queryClient)).toEqual(claire);
  });

  it('publishes the latest of two queued sign-ins, with nothing observing the session', async () => {
    const session = serveSession(null, [ana, claire]);
    const queryClient = signedInClient(null);
    const first = session.holdNext('sign-in');
    const second = session.holdNext('sign-in');

    const asAna = startSession(queryClient, credentialsOf(ana));
    const asClaire = startSession(queryClient, credentialsOf(claire));
    await first.received;
    first.release();
    await asAna;

    // Ana's sign-in completed, but a later sign-in owns the session: Ana is not published.
    expect(sessionOf(queryClient)).toBeNull();
    await second.received;
    second.release();
    await asClaire;

    expect(session.log).toEqual([
      'sign-in received',
      'sign-in answered',
      'sign-in received',
      'sign-in answered',
    ]);
    expect(session.current).toEqual(claire);
    expect(sessionOf(queryClient)).toEqual(claire);
    expect(
      queryClient.getQueryCache().find({ queryKey: sessionQuery.queryKey })?.getObserversCount(),
    ).toBe(0);
  });

  it('settles on the server session when the latest sign-in fails after an earlier one succeeded', async () => {
    const session = serveSession(null, [ana]);
    const queryClient = signedInClient(null);
    const first = session.holdNext('sign-in');
    const second = session.holdNext('sign-in');

    const asAna = startSession(queryClient, credentialsOf(ana));
    const refused = startSession(queryClient, { ...credentialsOf(claire), password: 'wrong' });
    await first.received;
    first.release();
    await asAna;
    expect(sessionOf(queryClient)).toBeNull();
    await second.received;
    second.release();

    // The refused sign-in rejects; the client then adopts what the server holds (Ana's cookie).
    await expect(refused).rejects.toMatchObject({ status: 401 });
    expect(session.current).toEqual(ana);
    expect(sessionOf(queryClient)).toEqual(ana);
    expect(getSignOutState(queryClient).status).toBe('idle');
  });

  it('keeps an unconfirmed sign-out in force when the next sign-in is refused', async () => {
    const session = serveSession(ana, [ana]);
    const queryClient = signedInClient(ana);
    session.failNextSignOut();
    await endSession(queryClient).settled;

    await expect(
      startSession(queryClient, { ...credentialsOf(ana), password: 'wrong' }),
    ).rejects.toMatchObject({ status: 401 });

    // A refused sign-in revokes nothing, so the server still knows Ana; she must not come back.
    expect(getSignOutState(queryClient).status).toBe('failed');
    expect(sessionOf(queryClient)).toBeNull();
    expect(session.meRequests).toBe(0);
  });

  it('re-asks the server when another tab changes the session during a sign-in, unobserved', async () => {
    const session = serveSession(null, [ana, claire]);
    const queryClient = signedInClient(null);
    const signIn = session.holdNext('sign-in');
    const signingIn = startSession(queryClient, credentialsOf(ana));
    await signIn.received;

    // Another tab signed in as Claire; this tab's sign-in response arrives afterwards.
    session.current = claire;
    await sessionChangedElsewhere(queryClient);
    signIn.release();
    await signingIn;

    expect(session.current).toEqual(ana);
    expect(sessionOf(queryClient)).toEqual(ana);
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

  it('outdates checks already on their way once a check adopts another identity', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    // Sent while the cookie was still Ana's: it will answer Ana.
    const held = session.holdNext('me');
    const olderCheck = checkSession(queryClient, neverAborted());
    await held.received;

    // The cookie changed behind this tab's back; a check through the cache adopts Claire.
    session.current = claire;
    await expect(queryClient.query({ ...sessionQuery, staleTime: 0 })).resolves.toEqual(claire);
    expect(sessionOf(queryClient)).toEqual(claire);
    queryClient.setQueryData(voyagesOf(claire), ['TF-CLAIRE-ONLY']);
    held.release();

    await expect(olderCheck).rejects.toBeInstanceOf(StaleSessionCheckError);
    expect(sessionOf(queryClient)).toEqual(claire);
    expect(queryClient.getQueryData(voyagesOf(claire))).toEqual(['TF-CLAIRE-ONLY']);
  });

  it('outdates no check already on its way when a check only confirms the identity', async () => {
    const session = serveSession(ana);
    const queryClient = signedInClient(ana);
    const held = session.holdNext('me');
    const earlierCheck = checkSession(queryClient, neverAborted());
    await held.received;

    await expect(queryClient.query({ ...sessionQuery, staleTime: 0 })).resolves.toEqual(ana);
    held.release();

    await expect(earlierCheck).resolves.toEqual(ana);
  });
});

describe('a 401 attributed to the session it was sent under', () => {
  const revalidate = (queryClient: QueryClient) =>
    queryClient.query({ ...sessionQuery, staleTime: 0 });

  it('ends that session while it is still the current one', async () => {
    serveSession(null);
    const queryClient = signedInClient(ana);
    queryClient.setQueryData(voyagesOf(ana), ['TF-ANA-ONLY']);
    const epoch = currentSessionEpoch(queryClient);

    await sessionExpired(queryClient, epoch);

    expect(sessionOf(queryClient)).toBeNull();
    expect(queryClient.getQueryData(voyagesOf(ana))).toBeUndefined();
  });

  it('still ends it after a session check confirmed the same identity', async () => {
    const session = serveSession(ana);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    await expect(revalidate(queryClient)).resolves.toEqual(ana);
    session.current = null;
    await sessionExpired(queryClient, epoch);

    expect(sessionOf(queryClient)).toBeNull();
  });

  it('leaves alone another identity a session check adopted since, without a transition', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    // The cookie changed behind this tab's back, and nothing announced it.
    session.current = claire;
    await expect(revalidate(queryClient)).resolves.toEqual(claire);
    queryClient.setQueryData(voyagesOf(claire), ['TF-CLAIRE-ONLY']);
    await sessionExpired(queryClient, epoch);

    expect(sessionOf(queryClient)).toEqual(claire);
    expect(queryClient.getQueryData(voyagesOf(claire))).toEqual(['TF-CLAIRE-ONLY']);
  });

  it('leaves alone the same user after session checks went to someone else and back', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    session.current = claire;
    await expect(revalidate(queryClient)).resolves.toEqual(claire);
    session.current = ana;
    await expect(revalidate(queryClient)).resolves.toEqual(ana);
    queryClient.setQueryData(voyagesOf(ana), ['TF-ANA-ONLY']);
    await sessionExpired(queryClient, epoch);

    expect(sessionOf(queryClient)).toEqual(ana);
    expect(queryClient.getQueryData(voyagesOf(ana))).toEqual(['TF-ANA-ONLY']);
  });

  it('leaves alone the same user after they signed out and back in', async () => {
    serveSession(ana);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    await endSession(queryClient).settled;
    await startSession(queryClient, credentialsOf(ana));
    queryClient.setQueryData(voyagesOf(ana), ['TF-ANA-ONLY']);
    await sessionExpired(queryClient, epoch);

    expect(sessionOf(queryClient)).toEqual(ana);
    expect(queryClient.getQueryData(voyagesOf(ana))).toEqual(['TF-ANA-ONLY']);
  });
});

describe('a write sent for the session it was issued in', () => {
  const revalidate = (queryClient: QueryClient) =>
    queryClient.query({ ...sessionQuery, staleTime: 0 });
  const unauthenticated = () => new ApiError(401, null);

  it('is sent while that session is current, and after a session check confirmed it', async () => {
    serveSession(ana);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);
    await expect(revalidate(queryClient)).resolves.toEqual(ana);
    const send = vi.fn(() => Promise.resolve('sent'));

    await expect(sendForCurrentSession(queryClient, epoch, send)).resolves.toBe('sent');

    expect(send).toHaveBeenCalledTimes(1);
  });

  it.each<[string, (queryClient: QueryClient, session: FakeSession) => Promise<unknown>]>([
    [
      'the same user signed out and back in',
      async (queryClient) => {
        await endSession(queryClient).settled;
        await startSession(queryClient, credentialsOf(ana));
      },
    ],
    [
      'another tab signed in as someone else',
      async (queryClient, session) => {
        session.current = claire;
        await sessionChangedElsewhere(queryClient);
        await revalidate(queryClient);
      },
    ],
    [
      'session checks went to someone else and back',
      async (queryClient, session) => {
        session.current = claire;
        await revalidate(queryClient);
        session.current = ana;
        await revalidate(queryClient);
      },
    ],
  ])(
    'is not sent once %s, and leaves the session that replaced it alone',
    async (_case, replace) => {
      const session = serveSession(ana, [ana, claire]);
      const queryClient = signedInClient(ana);
      const epoch = currentSessionEpoch(queryClient);
      await replace(queryClient, session);
      const current = sessionOf(queryClient);
      expect(current).toEqual(session.current);
      const replacement = currentSessionEpoch(queryClient);
      queryClient.setQueryData(voyagesOf(session.current ?? ana), ['TF-KEPT']);
      const signOuts = session.signOutRequests;
      const send = vi.fn(() => Promise.resolve('sent'));

      await expect(sendForCurrentSession(queryClient, epoch, send)).rejects.toBeInstanceOf(
        StaleSessionCommandError,
      );

      expect(send).not.toHaveBeenCalled();
      expect(sessionOf(queryClient)).toEqual(current);
      expect(isCurrentSession(queryClient, replacement)).toBe(true);
      expect(queryClient.getQueryData(voyagesOf(session.current ?? ana))).toEqual(['TF-KEPT']);
      expect(session.signOutRequests).toBe(signOuts);
    },
  );

  it('ends the session it was issued in when the server answers 401', async () => {
    serveSession(null);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    await expect(
      sendForCurrentSession(queryClient, epoch, () => Promise.reject(unauthenticated())),
    ).rejects.toBeInstanceOf(ApiError);

    expect(sessionOf(queryClient)).toBeNull();
  });

  it('leaves alone the session that replaced it while it was on its way, on a 401', async () => {
    serveSession(ana);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);
    let answer: (error: ApiError) => void = () => undefined;
    const sent = sendForCurrentSession(
      queryClient,
      epoch,
      () =>
        new Promise<never>((_, reject) => {
          answer = reject;
        }),
    );

    await endSession(queryClient).settled;
    await startSession(queryClient, credentialsOf(ana));
    queryClient.setQueryData(voyagesOf(ana), ['TF-ANA-ONLY']);
    answer(unauthenticated());

    await expect(sent).rejects.toBeInstanceOf(ApiError);
    expect(sessionOf(queryClient)).toEqual(ana);
    expect(queryClient.getQueryData(voyagesOf(ana))).toEqual(['TF-ANA-ONLY']);
  });
});

describe('whether the session an operation started in is still the current one', () => {
  const revalidate = (queryClient: QueryClient) =>
    queryClient.query({ ...sessionQuery, staleTime: 0 });

  it('holds while nothing changed, and after a session check confirmed the same identity', async () => {
    serveSession(ana);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    expect(isCurrentSession(queryClient, epoch)).toBe(true);
    await expect(revalidate(queryClient)).resolves.toEqual(ana);
    expect(isCurrentSession(queryClient, epoch)).toBe(true);
  });

  it('no longer holds once the same user has signed out and back in', async () => {
    serveSession(ana);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    await endSession(queryClient).settled;
    expect(isCurrentSession(queryClient, epoch)).toBe(false);
    await startSession(queryClient, credentialsOf(ana));

    expect(sessionOf(queryClient)).toEqual(ana);
    expect(isCurrentSession(queryClient, epoch)).toBe(false);
  });

  it('no longer holds after another tab went to someone else and back', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    session.current = claire;
    await sessionChangedElsewhere(queryClient);
    await expect(revalidate(queryClient)).resolves.toEqual(claire);
    session.current = ana;
    await sessionChangedElsewhere(queryClient);
    await expect(revalidate(queryClient)).resolves.toEqual(ana);

    expect(isCurrentSession(queryClient, epoch)).toBe(false);
  });

  it('no longer holds once a session check adopted another identity, without a transition', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    session.current = claire;
    await expect(revalidate(queryClient)).resolves.toEqual(claire);

    expect(isCurrentSession(queryClient, epoch)).toBe(false);
  });

  it('no longer holds after session checks went to someone else and back, without a transition', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    const epoch = currentSessionEpoch(queryClient);

    session.current = claire;
    await expect(revalidate(queryClient)).resolves.toEqual(claire);
    session.current = ana;
    await expect(revalidate(queryClient)).resolves.toEqual(ana);

    expect(sessionOf(queryClient)).toEqual(ana);
    expect(isCurrentSession(queryClient, epoch)).toBe(false);
  });

  it('holds for the session a check adopted, while later checks only confirm it', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);

    session.current = claire;
    await expect(revalidate(queryClient)).resolves.toEqual(claire);
    const epoch = currentSessionEpoch(queryClient);
    await expect(revalidate(queryClient)).resolves.toEqual(claire);

    expect(isCurrentSession(queryClient, epoch)).toBe(true);
  });

  it('keeps each epoch to itself: an older one stays stale beside a newer, current one', async () => {
    serveSession(ana);
    const queryClient = signedInClient(ana);
    const before = currentSessionEpoch(queryClient);
    await switchIdentity(queryClient, null);
    await switchIdentity(queryClient, ana);
    const after = currentSessionEpoch(queryClient);

    expect(isCurrentSession(queryClient, before)).toBe(false);
    expect(isCurrentSession(queryClient, after)).toBe(true);
  });
});

describe('being told when a session epoch ends', () => {
  const revalidate = (queryClient: QueryClient) =>
    queryClient.query({ ...sessionQuery, staleTime: 0 });

  /** Records, at each call, whether `epoch` was still current and who was signed in. */
  function watch(queryClient: QueryClient) {
    const epoch = currentSessionEpoch(queryClient);
    const calls: { current: boolean; signedIn: unknown }[] = [];
    const stop = subscribeToSessionTransitions(queryClient, () => {
      calls.push({
        current: isCurrentSession(queryClient, epoch),
        signedIn: sessionOf(queryClient),
      });
    });
    return { calls, stop };
  }

  it('tells at once when a sign-out starts, before anything else changes', async () => {
    serveSession(ana);
    const queryClient = signedInClient(ana);
    const { calls } = watch(queryClient);

    const signOut = endSession(queryClient);

    expect(calls).toEqual([{ current: false, signedIn: ana }]);
    await signOut.settled;
  });

  it('tells on signing back in as the same user, and when another tab changes the session', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    await endSession(queryClient).settled;
    const { calls } = watch(queryClient);

    await startSession(queryClient, credentialsOf(ana));
    expect(calls.length).toBeGreaterThan(0);
    const afterSignIn = calls.length;

    session.current = claire;
    await sessionChangedElsewhere(queryClient);
    expect(calls.length).toBeGreaterThan(afterSignIn);
    expect(calls.every(({ current }) => !current)).toBe(true);
  });

  it('tells when a session check adopts another identity, and not when it confirms one', async () => {
    const session = serveSession(ana, [ana, claire]);
    const queryClient = signedInClient(ana);
    const { calls } = watch(queryClient);

    await expect(revalidate(queryClient)).resolves.toEqual(ana);
    expect(calls).toEqual([]);

    session.current = claire;
    await expect(revalidate(queryClient)).resolves.toEqual(claire);
    expect(calls).toEqual([{ current: false, signedIn: ana }]);
  });

  it('stops telling once unsubscribed', async () => {
    serveSession(ana);
    const queryClient = signedInClient(ana);
    const { calls, stop } = watch(queryClient);

    stop();
    await endSession(queryClient).settled;

    expect(calls).toEqual([]);
  });
});
