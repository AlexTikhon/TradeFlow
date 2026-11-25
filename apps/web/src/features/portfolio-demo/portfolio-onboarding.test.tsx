import { screen, waitFor, within } from '@testing-library/react';
import type { CurrentUser } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyActionPage } from '../../test/fixtures/action-items';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../test/fixtures/auth';
import { server } from '../../test/msw-server';
import { renderRoute } from '../../test/render-route';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from '../auth/session-sync';
import { DEMO_PASSWORD } from './demo-accounts';
import { PORTFOLIO_DEMO_MODE, SHOWCASE_METADATA_PATH } from './portfolio-demo';

/*
 * Portfolio-demo onboarding through the real route tree, providers and session code; only the
 * network is faked. Onboarding exists only in the build whose Vite mode is `portfolio-demo`;
 * these tests switch the mode the way that build sets it.
 */

const SHOWCASE_ID = '01990000-0000-7000-8006-00000000a008';
const SHOWCASE_REFERENCE = 'TF-2026-0008';

const ana = aCurrentUser();
const weiLing = aCurrentUser({
  user: {
    id: '01990000-0000-7000-8002-000000000011',
    email: 'wei.ling.tan@meridianagri.example',
    fullName: 'Tan Wei Ling',
    role: 'OPERATOR',
  },
  organization: {
    id: '01990000-0000-7000-8001-000000000011',
    name: 'Meridian Agri Trading Pte. Ltd.',
    countryCode: 'SG',
  },
});
const rafael = aCurrentUser({
  user: {
    id: '01990000-0000-7000-8002-000000000012',
    email: 'rafael.lima@cerrado-graos.example',
    fullName: 'Rafael Lima',
    role: 'VIEWER',
  },
});
const lucia = aCurrentUser({
  user: {
    id: '01990000-0000-7000-8002-000000000013',
    email: 'lucia.ferreyra@pampalitoral.example',
    fullName: 'Lucía Ferreyra',
    role: 'OPERATOR',
  },
  organization: {
    id: '01990000-0000-7000-8001-000000000013',
    name: 'Pampa Litoral Agroexport S.A.',
    countryCode: 'AR',
  },
});
const claire = anotherUser();

const validMetadata = {
  schemaVersion: 1,
  showcase: { voyageId: SHOWCASE_ID, reference: SHOWCASE_REFERENCE },
};

/** Serves the showcase file with `respond`, and counts the requests for it. */
function serveMetadata(respond: () => Response = () => HttpResponse.json(validMetadata)) {
  const requests = { count: 0 };
  server.use(
    http.get(`*${SHOWCASE_METADATA_PATH}`, () => {
      requests.count += 1;
      return respond();
    }),
  );
  return requests;
}

/** The pages a sign-in lands on in these tests, empty. */
function servePages() {
  server.use(
    http.get('*/api/voyages', () => HttpResponse.json({ items: [] })),
    http.get('*/api/action-items', () => HttpResponse.json(emptyActionPage())),
  );
}

const guide = () => screen.findByRole('dialog', { name: 'Demo guide' });

async function chooseAccount(user: ReturnType<typeof renderRoute>['user'], name: string) {
  const accounts = await screen.findByRole('list', { name: 'Demo accounts' });
  await user.click(within(accounts).getByRole('button', { name: new RegExp(name) }));
}

function signInForm() {
  return {
    email: screen.getByLabelText(/Email/),
    password: screen.getByLabelText(/Password/),
    submit: screen.getByRole('button', { name: 'Sign in' }),
  };
}

describe('portfolio-demo onboarding, when the build is not the portfolio demo', () => {
  it('shows the plain sign-in, no guide after signing in, and never asks for the showcase', async () => {
    const metadata = serveMetadata();
    servePages();
    const { user, session, router } = renderRoute('/sign-in', {
      signedInAs: null,
      accounts: [ana],
    });

    expect(
      await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Demo accounts' })).not.toBeInTheDocument();
    expect(screen.queryByText(/demo password/)).not.toBeInTheDocument();
    expect(screen.queryByText(/shared record/)).not.toBeInTheDocument();
    expect(signInForm().email).toHaveFocus();

    await user.type(signInForm().email, ana.user.email);
    await user.type(signInForm().password, TEST_PASSWORD);
    await user.click(signInForm().submit);

    expect(await screen.findByRole('heading', { name: 'Voyages' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/voyages');
    expect(router.state.location.state).toBeNull();
    expect(session.signInRequests).toBe(1);
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Demo guide' })).not.toBeInTheDocument();
    expect(screen.queryByText(/Portfolio demo/)).not.toBeInTheDocument();
    expect(metadata.count).toBe(0);
  });
});

describe('portfolio-demo onboarding', () => {
  beforeEach(() => {
    vi.stubEnv('MODE', PORTFOLIO_DEMO_MODE);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('explains TradeFlow and offers the four fictional accounts with the published password', async () => {
    renderRoute('/sign-in', { signedInAs: null });

    expect(await screen.findByText(/one shared record of its execution/)).toBeInTheDocument();
    expect(screen.getByText(/stay confidential to its seller and buyer/)).toBeInTheDocument();
    const region = screen.getByRole('region', { name: 'Demo accounts' });
    expect(within(region).getByText(/Fictional people and companies/)).toHaveTextContent(
      `published demo password ${DEMO_PASSWORD}`,
    );
    const accounts = within(region).getAllByRole('button');
    expect(accounts.map((button) => button.textContent)).toEqual([
      expect.stringMatching(/^Seller · Cerrado Grãos.*Ana Souza/),
      expect.stringMatching(/^Buyer · Meridian Agri Trading.*Tan Wei Ling/),
      expect.stringMatching(/^Viewer · Cerrado Grãos.*Rafael Lima/),
      expect.stringMatching(/^Outsider · Pampa Litoral.*Lucía Ferreyra/),
    ]);
    accounts.forEach((button) => {
      expect(button).toHaveAttribute('aria-pressed', 'false');
    });
  });

  it('fills the form when an account is chosen, and sends nothing', async () => {
    const { user, session } = renderRoute('/sign-in', { signedInAs: null, accounts: [ana] });

    await chooseAccount(user, 'Ana Souza');

    const form = signInForm();
    expect(form.email).toHaveValue(ana.user.email);
    expect(form.password).toHaveValue(DEMO_PASSWORD);
    expect(form.submit).toHaveFocus();
    expect(screen.getByRole('button', { name: /Ana Souza/ })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByRole('status')).toHaveTextContent(
      'Ana Souza’s email and the demo password are filled in. Select Sign in to continue.',
    );
    // Give a stray submission every chance to show up.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(session.signInRequests).toBe(0);
    expect(session.log).not.toContain('sign-in received');

    // Choosing another account only changes what is filled in.
    await chooseAccount(user, 'Rafael Lima');
    expect(signInForm().email).toHaveValue(rafael.user.email);
    expect(session.signInRequests).toBe(0);
  });

  it('signs in only when the visitor submits, through the normal sign-in, then opens the guide', async () => {
    serveMetadata();
    servePages();
    const { user, session, router } = renderRoute('/sign-in', {
      signedInAs: null,
      accounts: [ana],
    });

    await chooseAccount(user, 'Ana Souza');
    await user.keyboard('{Enter}'); // Focus is on Sign in: the visitor's explicit submission.

    const dialog = await guide();
    expect(session.signInRequests).toBe(1);
    expect(session.current).toEqual(ana);
    expect(router.state.location.pathname).toBe('/voyages');
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
    expect(dialog).toHaveTextContent('You are Ana, the seller');
    expect(dialog).toHaveTextContent('upload the commercial invoice');
    expect(dialog).toHaveTextContent('replace the rejected weight certificate');
    // Opened once: the request has left the history entry, so a reload would not reopen it.
    await waitFor(() => {
      expect(router.state.location.state).toBeNull();
    });
    expect(screen.getByRole('dialog', { name: 'Demo guide' })).toBeInTheDocument();
  });

  it('shows the error of a refused sign-in as before, and no guide', async () => {
    const { user, router } = renderRoute('/sign-in', { signedInAs: null, accounts: [] });

    await chooseAccount(user, 'Ana Souza');
    await user.click(signInForm().submit);

    expect(await screen.findByText('Email or password is incorrect.')).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/sign-in');
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('returns to the protected page that asked for sign-in, with the guide over it', async () => {
    serveMetadata();
    servePages();
    const { user, router } = renderRoute('/actions?type=REVIEW_DOCUMENT', {
      signedInAs: null,
      accounts: [weiLing],
    });

    await chooseAccount(user, 'Tan Wei Ling');
    await user.click(signInForm().submit);

    const dialog = await guide();
    expect(router.state.location.pathname).toBe('/actions');
    expect(router.state.location.search).toBe('?type=REVIEW_DOCUMENT');
    expect(dialog).toHaveTextContent('You are Wei Ling, the buyer');
    expect(dialog).toHaveTextContent('approve or reject the certificate of origin');
  });

  it('never redirects outside the app after signing in', async () => {
    serveMetadata();
    servePages();
    const { user, router } = renderRoute(
      { pathname: '/sign-in', state: { from: { pathname: '//evil.example/phish' } } },
      { signedInAs: null, accounts: [ana] },
    );

    await chooseAccount(user, 'Ana Souza');
    await user.click(signInForm().submit);

    await guide();
    expect(router.state.location.pathname).toBe('/voyages');
  });

  it("links the guide to the prepared voyage's own id and to the Action Center", async () => {
    const metadata = serveMetadata();
    servePages();
    const { user, router } = renderRoute('/voyages', { signedInAs: ana });

    // Arriving already signed in, nobody asked for the guide: it waits behind its button.
    expect(await screen.findByText('Portfolio demo · fictional data')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    expect(metadata.count).toBe(0);

    await user.click(screen.getByRole('button', { name: 'Demo guide' }));
    const dialog = await guide();
    const showcase = await within(dialog).findByRole('link', {
      name: `Open showcase voyage ${SHOWCASE_REFERENCE}`,
    });
    expect(showcase).toHaveAttribute('href', `/voyages/${SHOWCASE_ID}`);
    expect(metadata.count).toBe(1);

    await user.click(within(dialog).getByRole('link', { name: 'Open Action Center' }));

    expect(await screen.findByRole('heading', { name: 'Action Center' })).toBeInTheDocument();
    expect(router.state.location.pathname).toBe('/actions');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('closes with Escape or Close, returns focus, and reopens from the demo bar', async () => {
    serveMetadata();
    servePages();
    const { user } = renderRoute('/voyages', { signedInAs: ana });

    const reopen = await screen.findByRole('button', { name: 'Demo guide' });
    await user.click(reopen);
    await guide();
    await user.keyboard('{Escape}');
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
    expect(reopen).toHaveFocus();

    await user.click(reopen);
    const dialog = await guide();
    await user.click(within(dialog).getByRole('button', { name: 'Close' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });

    await user.click(reopen);
    await user.click(within(await guide()).getByRole('button', { name: 'Close the demo guide' }));
    await waitFor(() => {
      expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    });
  });

  it('explains the documents, separate browser profiles and that changes do not last', async () => {
    serveMetadata();
    servePages();
    const { user } = renderRoute('/voyages', { signedInAs: ana });

    await user.click(await screen.findByRole('button', { name: 'Demo guide' }));
    const dialog = await guide();
    const documents = within(dialog).getByRole('region', { name: 'The showcase documents' });
    expect(
      within(documents)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      'Commercial invoice: not uploaded yet.',
      'Certificate of origin: version 1 is waiting for the buyer’s review.',
      'Weight certificate: version 1 was rejected; the seller must replace it.',
      'Bill of lading: version 2 is approved; rejected version 1 is kept under Earlier versions.',
    ]);
    const notes = within(dialog).getByRole('region', { name: 'Good to know' });
    expect(notes).toHaveTextContent('two browser profiles, or a normal and a private window');
    expect(notes).toHaveTextContent('tabs of one browser share one sign-in');
    expect(notes).toHaveTextContent('whatever you change disappears when the demo stops');
  });

  it.each<[string, CurrentUser, RegExp[], RegExp[]]>([
    [
      'the viewer: read and download, no writes',
      rafael,
      [/You are Rafael, a viewer at the seller/, /cannot upload, review or acknowledge/],
      [/you can upload/, /approve or reject/],
    ],
    [
      'the outsider: cannot open the showcase, on purpose',
      lucia,
      [/You are Lucía/, /takes no part in the showcase voyage/, /Voyage not found/, /intended/],
      [/you can upload/, /approve or reject/, /download/],
    ],
    [
      'any other account: no prepared part',
      claire,
      [/no prepared part in the showcase/],
      [/You are/],
    ],
  ])('tells %s', async (_name, identity, expected, absent) => {
    serveMetadata();
    servePages();
    const { user } = renderRoute('/voyages', { signedInAs: identity });

    await user.click(await screen.findByRole('button', { name: 'Demo guide' }));
    const dialog = await guide();
    for (const text of expected) expect(dialog).toHaveTextContent(text);
    for (const text of absent) expect(dialog).not.toHaveTextContent(text);
    // The link is only a way there: the API decides what this account can open.
    expect(
      await within(dialog).findByRole('link', { name: /Open showcase voyage/ }),
    ).toHaveAttribute('href', `/voyages/${SHOWCASE_ID}`);
  });

  it.each<[string, () => Response]>([
    ['missing', () => new HttpResponse(null, { status: 404 })],
    [
      'answered by the page instead (a single-page fallback)',
      () => HttpResponse.html('<!doctype html><title>TradeFlow</title>'),
    ],
    ['not JSON', () => new HttpResponse('{', { headers: { 'Content-Type': 'application/json' } })],
    ['of another version', () => HttpResponse.json({ ...validMetadata, schemaVersion: 2 })],
    [
      'with an id that is not one',
      () =>
        HttpResponse.json({
          schemaVersion: 1,
          showcase: { voyageId: '../../sign-in', reference: SHOWCASE_REFERENCE },
        }),
    ],
    [
      'with an unexpected reference',
      () =>
        HttpResponse.json({
          schemaVersion: 1,
          showcase: { voyageId: SHOWCASE_ID, reference: '<b>latest</b>' },
        }),
    ],
    [
      'with anything more',
      () =>
        HttpResponse.json({
          ...validMetadata,
          showcase: { ...validMetadata.showcase, href: 'https://evil.example' },
        }),
    ],
    ['far too large', () => HttpResponse.json({ ...validMetadata, padding: 'x'.repeat(2_000) })],
    ['unreachable', () => HttpResponse.error()],
  ])('offers no showcase link when its metadata is %s', async (_name, respond) => {
    serveMetadata(respond);
    servePages();
    const { user } = renderRoute('/voyages', { signedInAs: ana });

    await user.click(await screen.findByRole('button', { name: 'Demo guide' }));
    const dialog = await guide();

    expect(
      await within(dialog).findByText('The showcase voyage is not available in this run.'),
    ).toBeInTheDocument();
    expect(within(dialog).queryByRole('link', { name: /showcase/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: 'Open Action Center' })).toHaveAttribute(
      'href',
      '/actions',
    );
    expect(dialog).toHaveTextContent('You are Ana, the seller');
  });

  it('leaves sign-in usable without any metadata', async () => {
    serveMetadata(() => new HttpResponse(null, { status: 404 }));
    servePages();
    const { user, session } = renderRoute('/sign-in', { signedInAs: null, accounts: [ana] });

    await chooseAccount(user, 'Ana Souza');
    await user.click(signInForm().submit);

    expect(
      await within(await guide()).findByText('The showcase voyage is not available in this run.'),
    ).toBeInTheDocument();
    expect(session.signInRequests).toBe(1);
    expect(screen.getByText('Ana Souza')).toBeInTheDocument();
  });

  describe('keeps the session protections', () => {
    it('waits for an unfinished sign-out before a chosen account can sign in', async () => {
      serveMetadata();
      servePages();
      const { user, session } = renderRoute('/voyages', { accounts: [ana, weiLing] });
      const signOut = session.holdNext('sign-out');

      await user.click(await screen.findByRole('button', { name: 'Sign out' }));
      await signOut.received;
      expect(await screen.findByText('Finishing sign-out…')).toBeInTheDocument();

      await chooseAccount(user, 'Tan Wei Ling');
      expect(signInForm().submit).toBeDisabled();
      await user.keyboard('{Enter}');
      expect(session.signInRequests).toBe(0);

      signOut.release();
      await waitFor(() => {
        expect(signInForm().submit).toBeEnabled();
      });
      await user.click(signInForm().submit);

      const dialog = await guide();
      expect(dialog).toHaveTextContent('You are Wei Ling, the buyer');
      // The sign-out was answered first, so it cleared Ana's cookie, not Wei Ling's.
      expect(session.log.indexOf('sign-out answered')).toBeLessThan(
        session.log.indexOf('sign-in received'),
      );
      expect(session.current).toEqual(weiLing);
    });

    it('opens no guide when another tab signed in, and fills nothing on its behalf', async () => {
      serveMetadata();
      servePages();
      const { user, session, router, queryClient } = renderRoute('/sign-in', {
        signedInAs: null,
        accounts: [ana, weiLing],
      });
      const stopSync = startSessionSync(queryClient);
      const otherTab = new BroadcastChannel(SESSION_CHANNEL_NAME);
      try {
        await chooseAccount(user, 'Ana Souza');

        // Another tab of this browser signed in as Wei Ling: the shared cookie is now hers.
        session.current = weiLing;
        otherTab.postMessage(SESSION_CHANGED);

        await waitFor(() => {
          expect(router.state.location.pathname).toBe('/voyages');
        });
        expect(await screen.findByText('Tan Wei Ling', { selector: 'p' })).toBeInTheDocument();
        expect(session.signInRequests).toBe(0);
        expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
      } finally {
        otherTab.close();
        stopSync();
      }
    });

    it('starts afresh for a chosen account after signing out here', async () => {
      serveMetadata();
      servePages();
      const { user, session, router } = renderRoute('/voyages', { accounts: [ana, rafael] });
      expect(await screen.findByText('Ana Souza')).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByRole('list', { name: 'Demo accounts' })).toBeInTheDocument();
      expect(screen.queryByText('Ana Souza', { selector: 'p' })).not.toBeInTheDocument();

      await chooseAccount(user, 'Rafael Lima');
      await user.click(signInForm().submit);

      const dialog = await guide();
      expect(dialog).toHaveTextContent('You are Rafael');
      expect(screen.getByText('Rafael Lima', { selector: 'p' })).toBeInTheDocument();
      // Signed out here first: the next sign-in starts afresh, on the default page.
      expect(router.state.location.pathname).toBe('/voyages');
      expect(session.current).toEqual(rafael);
    });
  });
});
