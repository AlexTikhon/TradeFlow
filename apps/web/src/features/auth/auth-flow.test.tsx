import { QueryObserver } from '@tanstack/react-query';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import type { CurrentUser, VoyageListResponse } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../test/fixtures/auth';
import { aVoyageSummary } from '../../test/fixtures/voyages';
import { type FakeSession, problemResponse, server } from '../../test/msw-server';
import { renderRoute } from '../../test/render-route';
import { endSession, getSignOutState, sessionQuery } from './session';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from './session-sync';

const ana = aCurrentUser();
const claire = anotherUser();

const anasVoyage = aVoyageSummary({ reference: 'TF-ANA-ONLY' });
const clairesVoyage = aVoyageSummary({
  id: '01990000-0000-7000-8006-000000000003',
  reference: 'TF-CLAIRE-ONLY',
});

/**
 * Serves `GET /api/voyages` like the real API: scoped to whoever the session belongs to, 401
 * without one. Responses for a user listed in `held` wait until `release()` (or until aborted).
 */
function serveScopedVoyages(session: FakeSession, { held = [] as CurrentUser[] } = {}) {
  const requests: Request[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });

  server.use(
    http.get('*/api/voyages', async ({ request }) => {
      requests.push(request);
      const identity = session.current;
      if (!identity) {
        return problemResponse(401, 'Authentication is required.');
      }
      if (held.some((user) => user.user.id === identity.user.id)) {
        await gate;
      }
      const body: VoyageListResponse = {
        items: identity.user.id === ana.user.id ? [anasVoyage] : [clairesVoyage],
      };
      return HttpResponse.json(body);
    }),
  );
  return {
    requests,
    release: () => {
      release();
    },
  };
}

/** Records whether `text` is ever present in the document from now on. */
function watchForText(text: string) {
  const result = { seen: false };
  const observer = new MutationObserver(() => {
    if (document.body.textContent.includes(text)) result.seen = true;
  });
  observer.observe(document.body, { childList: true, subtree: true, characterData: true });
  watchers.push(observer);
  return result;
}
const watchers: MutationObserver[] = [];
afterEach(() => {
  watchers.splice(0).forEach((observer) => {
    observer.disconnect();
  });
  sessionObservers.splice(0).forEach((unsubscribe) => {
    unsubscribe();
  });
});

/**
 * Watches the session from outside the route tree, as an always-mounted component would. Without
 * it, the session query briefly has no observer while routes swap, and TanStack Query aborts the
 * check then: that would hide a stale answer instead of proving the client ignores it.
 */
function keepSessionObserved(queryClient: ReturnType<typeof renderRoute>['queryClient']) {
  sessionObservers.push(new QueryObserver(queryClient, sessionQuery).subscribe(() => undefined));
}
const sessionObservers: (() => void)[] = [];

async function signInWith(user: ReturnType<typeof renderRoute>['user'], email: string) {
  await user.type(await screen.findByLabelText(/Email/), email);
  await user.type(screen.getByLabelText(/Password/), TEST_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

const protectedQueries = (queryClient: ReturnType<typeof renderRoute>['queryClient']) =>
  queryClient.getQueryCache().findAll({ queryKey: ['protected'] });

describe('authentication', () => {
  it('sends a visitor without a session to sign-in, without requesting protected data', async () => {
    const { router, session } = renderRoute('/voyages', { signedInAs: null });
    const { requests } = serveScopedVoyages(session);

    expect(
      await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(requests).toHaveLength(0);
  });

  it('signs in and returns to the page that asked for it', async () => {
    const { router, user, session } = renderRoute('/voyages?status=IN_TRANSIT', {
      signedInAs: null,
      accounts: [ana],
    });
    serveScopedVoyages(session);

    await signInWith(user, 'Ana.Souza@cerrado-graos.example');

    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/voyages');
    expect(router.state.location.search).toBe('?status=IN_TRANSIT');
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
    expect(screen.getByText('Cerrado Grãos Exportadora S.A.')).toBeInTheDocument();
  });

  it('never redirects outside the app after signing in', async () => {
    const { router, user, session } = renderRoute(
      { pathname: '/sign-in', state: { from: { pathname: '//evil.example/phish' } } },
      { signedInAs: null, accounts: [ana] },
    );
    serveScopedVoyages(session);

    await signInWith(user, ana.user.email);

    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/voyages');
  });

  it('shows one message for wrong credentials and stays on the sign-in page', async () => {
    const { router, user } = renderRoute('/sign-in', { signedInAs: null, accounts: [ana] });

    await user.type(await screen.findByLabelText(/Email/), ana.user.email);
    await user.type(screen.getByLabelText(/Password/), 'wrong password');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Email or password is incorrect.');
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  it('validates the form before sending anything', async () => {
    const { user, session } = renderRoute('/sign-in', { signedInAs: null });

    await user.type(await screen.findByLabelText(/Email/), 'not-an-email');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByText('Enter a valid email address.')).toBeInTheDocument();
    expect(screen.getByText('Enter your password.')).toBeInTheDocument();
    expect(session.signInRequests).toBe(0);
  });

  it('signing out cancels in-flight protected requests and clears protected data', async () => {
    const { router, user, session, queryClient } = renderRoute('/voyages');
    const { requests } = serveScopedVoyages(session, { held: [ana] });
    await waitFor(() => {
      expect(requests).toHaveLength(1);
    });

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(
      await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(protectedQueries(queryClient)).toHaveLength(0);
    await waitFor(() => {
      expect(session.signOutRequests).toBe(1);
    });
  });

  it("never shows the previous user's data to the next user", async () => {
    const { user, session, queryClient } = renderRoute('/voyages', { accounts: [ana, claire] });
    const { release } = serveScopedVoyages(session, { held: [claire] });
    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    const anasDataShown = watchForText('TF-ANA-ONLY');
    await signInWith(user, claire.user.email);

    // Claire's list is still loading: the page must show a loading state, not Ana's cached list.
    expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
    expect(screen.getByText('Loading voyages…')).toBeInTheDocument();
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ['protected', `${ana.user.id}:${ana.organization.id}`] }),
    ).toHaveLength(0);

    release();
    expect(await screen.findByRole('link', { name: 'TF-CLAIRE-ONLY' })).toBeInTheDocument();
    expect(anasDataShown.seen).toBe(false);
  });

  it('drops protected data when another tab changes who is signed in', async () => {
    const { session, queryClient } = renderRoute('/voyages', { accounts: [ana, claire] });
    const stopSync = startSessionSync(queryClient);
    const otherTab = new BroadcastChannel(SESSION_CHANNEL_NAME);
    try {
      const { release } = serveScopedVoyages(session, { held: [claire] });
      expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();

      // The other tab signed out and signed in as Claire: the shared cookie is now hers.
      session.current = claire;
      otherTab.postMessage(SESSION_CHANGED);

      await waitFor(() => {
        expect(screen.queryByRole('link', { name: 'TF-ANA-ONLY' })).not.toBeInTheDocument();
      });
      const anasDataShown = watchForText('TF-ANA-ONLY');
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      release();
      expect(await screen.findByRole('link', { name: 'TF-CLAIRE-ONLY' })).toBeInTheDocument();
      expect(anasDataShown.seen).toBe(false);
    } finally {
      otherTab.close();
      stopSync();
    }
  });

  it('waits for an unfinished sign-out before signing in again', async () => {
    const { router, user, session } = renderRoute('/voyages', { accounts: [ana, claire] });
    serveScopedVoyages(session);
    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    const signOut = session.holdNext('sign-out');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await signOut.received;

    expect(await screen.findByText('Finishing sign-out…')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(screen.queryByText('TF-ANA-ONLY')).not.toBeInTheDocument();
    expect(screen.queryByText('Ana Souza')).not.toBeInTheDocument();
    await user.type(screen.getByLabelText(/Email/), claire.user.email);
    await user.type(screen.getByLabelText(/Password/), `${TEST_PASSWORD}{Enter}`);
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(session.signInRequests).toBe(0);

    signOut.release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    });
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('link', { name: 'TF-CLAIRE-ONLY' })).toBeInTheDocument();
    // The sign-out response arrived first, so it cleared Ana's cookie, not Claire's.
    expect(session.current).toEqual(claire);
  });

  it('ignores a session check that answers "Ana" after Ana signed out', async () => {
    const { router, user, session, queryClient } = renderRoute('/voyages');
    serveScopedVoyages(session);
    keepSessionObserved(queryClient);
    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    // The tab regained focus: the session is being re-checked while Ana is still signed in.
    const check = session.holdNext('me');
    const staleCheck = queryClient.refetchQueries({ queryKey: ['session'] });
    await check.received;

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(session.log).toContain('sign-out answered');
    });
    check.release();
    await staleCheck;

    expect(router.state.location.pathname).toBe('/sign-in');
    expect(queryClient.getQueryData(['session'])).toBeNull();
    expect(screen.queryByText('Ana Souza')).not.toBeInTheDocument();
  });

  it('ignores a session check that answers "nobody" after a successful sign-in', async () => {
    const { router, user, session, queryClient } = renderRoute('/sign-in', {
      signedInAs: null,
      accounts: [ana],
    });
    serveScopedVoyages(session);
    keepSessionObserved(queryClient);
    await waitFor(() => {
      expect(queryClient.getQueryData(['session'])).toBeNull();
    });
    // A re-check starts while nobody is signed in, and answers only after Ana signed in.
    const check = session.holdNext('me');
    const staleCheck = queryClient.refetchQueries({ queryKey: ['session'] });
    await check.received;

    await signInWith(user, ana.user.email);
    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    check.release();
    await staleCheck;

    expect(queryClient.getQueryData(['session'])).toEqual(ana);
    expect(router.state.location.pathname).toBe('/voyages');
    expect(screen.getByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    expect(
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ['protected', `${ana.user.id}:${ana.organization.id}`] }),
    ).not.toHaveLength(0);
  });

  it('never shows the previous identity when its session check answers during a sign-in', async () => {
    const { router, user, session, queryClient } = renderRoute('/sign-in', {
      signedInAs: null,
      accounts: [ana, claire],
    });
    serveScopedVoyages(session);
    keepSessionObserved(queryClient);
    await waitFor(() => {
      expect(queryClient.getQueryData(['session'])).toBeNull();
    });
    // The cookie now belongs to Ana (another tab), and a re-check is on its way back with her.
    session.current = ana;
    const check = session.holdNext('me');
    const staleCheck = queryClient.refetchQueries({ queryKey: ['session'] });
    await check.received;
    const signIn = session.holdNext('sign-in');
    await signInWith(user, claire.user.email);
    await signIn.received;
    const anaShown = watchForText('Ana Souza');

    check.release();
    await staleCheck;

    expect(router.state.location.pathname).toBe('/sign-in');
    expect(queryClient.getQueryData(['session'])).toBeNull();
    signIn.release();
    expect(await screen.findByRole('link', { name: 'TF-CLAIRE-ONLY' })).toBeInTheDocument();
    expect(screen.getByText('Claire Morel')).toBeInTheDocument();
    expect(anaShown.seen).toBe(false);
  });

  it('reports a failed sign-out instead of restoring the session, and retries it', async () => {
    const { router, user, session, queryClient } = renderRoute('/voyages');
    serveScopedVoyages(session);
    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    session.failNextSignOut();

    await user.click(screen.getByRole('button', { name: 'Sign out' }));

    expect(await screen.findByText('Sign-out was not confirmed')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    // The server still knows Ana. Re-checking (as on window focus) must not sign her back in.
    await queryClient.refetchQueries({ queryKey: ['session'] });
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(screen.queryByText('Ana Souza')).not.toBeInTheDocument();
    expect(screen.queryByText('TF-ANA-ONLY')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Retry sign-out' }));

    await waitFor(() => {
      expect(screen.queryByText('Sign-out was not confirmed')).not.toBeInTheDocument();
    });
    expect(session.signOutRequests).toBe(2);
    expect(session.current).toBeNull();
    expect(router.state.location.pathname).toBe('/sign-in');
  });

  it('aborts pending protected requests when another tab changes who is signed in', async () => {
    const { session, queryClient } = renderRoute('/voyages', { accounts: [ana, claire] });
    const stopSync = startSessionSync(queryClient);
    const otherTab = new BroadcastChannel(SESSION_CHANNEL_NAME);
    try {
      const { requests, release } = serveScopedVoyages(session, { held: [ana] });
      await waitFor(() => {
        expect(requests).toHaveLength(1);
      });
      // A session check made before the change is still on its way back, answering "Ana".
      const check = session.holdNext('me');
      const staleCheck = queryClient.refetchQueries({ queryKey: ['session'] });
      await check.received;
      const anasDataShown = watchForText('TF-ANA-ONLY');

      session.current = claire;
      otherTab.postMessage(SESSION_CHANGED);

      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      expect(requests[0]?.signal.aborted).toBe(true);
      expect(
        queryClient
          .getQueryCache()
          .findAll({ queryKey: ['protected', `${ana.user.id}:${ana.organization.id}`] }),
      ).toHaveLength(0);

      release();
      check.release();
      await staleCheck;
      expect(await screen.findByRole('link', { name: 'TF-CLAIRE-ONLY' })).toBeInTheDocument();
      expect(screen.getByText('Claire Morel')).toBeInTheDocument();
      expect(anasDataShown.seen).toBe(false);
    } finally {
      otherTab.close();
      stopSync();
    }
  });

  it('treats a 401 on protected data as the end of the session', async () => {
    const { router, queryClient } = renderRoute('/voyages');
    // The session was valid when checked, then expired: the next protected request is refused.
    server.use(
      http.get('*/api/voyages', () => problemResponse(401, 'Authentication is required.')),
    );

    expect(
      await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(protectedQueries(queryClient)).toHaveLength(0);
  });
});

/** A page other than the default target, so that returning to it can be told apart. */
const IN_TRANSIT = '/voyages?status=IN_TRANSIT';
const pageOf = (router: ReturnType<typeof renderRoute>['router']) =>
  `${router.state.location.pathname}${router.state.location.search}`;

describe('where the next sign-in leads after the session ends', () => {
  it('opens the voyage list after signing out here, when the boundary redirects before the server confirms', async () => {
    const { router, user, session } = renderRoute(IN_TRANSIT);
    serveScopedVoyages(session);
    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    const signOut = session.holdNext('sign-out');

    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await signOut.received;
    expect(await screen.findByText('Finishing sign-out…')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    signOut.release();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
    });
    await signInWith(user, ana.user.email);

    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    expect(pageOf(router)).toBe('/voyages');
  });

  it('opens the voyage list after signing out here, when the boundary redirects after the server confirms', async () => {
    const { router, user, session, queryClient } = renderRoute(IN_TRANSIT);
    serveScopedVoyages(session);
    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();

    // act() holds React's rendering until its callback resolves, so the local sign-out and the
    // server's confirmation both finish before the boundary sees that nobody is signed in.
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(getSignOutState(queryClient).status).toBe('pending');
      await endSession(queryClient).settled; // The sign-out the click started.
      expect(session.log).toContain('sign-out answered');
      expect(screen.getByRole('button', { name: 'Sign out' })).toBeInTheDocument();
    });

    expect(
      await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
    ).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    await signInWith(user, ana.user.email);

    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    expect(pageOf(router)).toBe('/voyages');
  });

  it('opens the voyage list after signing out here, even when it next asks for a protected page', async () => {
    const { router, user, session } = renderRoute(IN_TRANSIT);
    serveScopedVoyages(session);
    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    expect(
      await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
    ).toBeInTheDocument();

    // The boundary redirects from the page the tab showed after the sign-out's own navigation.
    await act(() => router.navigate(IN_TRANSIT));
    expect(await screen.findByLabelText(/Email/)).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    await signInWith(user, ana.user.email);

    expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
    expect(pageOf(router)).toBe('/voyages');
  });

  it('returns to the page it showed when another tab ends the session, even after signing out here before', async () => {
    const { router, user, session, queryClient } = renderRoute('/voyages');
    serveScopedVoyages(session);
    const stopSync = startSessionSync(queryClient);
    const otherTab = new BroadcastChannel(SESSION_CHANNEL_NAME);
    try {
      expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
      // Signed out here and back in: that sign-out decides nothing about the next session.
      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      await waitFor(() => {
        expect(screen.getByRole('button', { name: 'Sign in' })).toBeEnabled();
      });
      await signInWith(user, ana.user.email);
      expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
      await act(() => router.navigate(IN_TRANSIT));

      // Another tab signs out: this tab leaves its page, and keeps it as the one to return to.
      session.current = null;
      otherTab.postMessage(SESSION_CHANGED);
      expect(
        await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
      ).toBeInTheDocument();
      expect(screen.queryByText('TF-ANA-ONLY')).not.toBeInTheDocument();

      // That tab signs back in: this one follows, back to the page it showed.
      session.current = ana;
      otherTab.postMessage(SESSION_CHANGED);
      expect(await screen.findByRole('link', { name: 'TF-ANA-ONLY' })).toBeInTheDocument();
      expect(pageOf(router)).toBe(IN_TRANSIT);
    } finally {
      otherTab.close();
      stopSync();
    }
  });
});
