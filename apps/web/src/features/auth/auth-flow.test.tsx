import { screen, waitFor } from '@testing-library/react';
import type { CurrentUser, VoyageListResponse } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../test/fixtures/auth';
import { aVoyageSummary } from '../../test/fixtures/voyages';
import { type FakeSession, problemResponse, server } from '../../test/msw-server';
import { renderRoute } from '../../test/render-route';
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
});

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
