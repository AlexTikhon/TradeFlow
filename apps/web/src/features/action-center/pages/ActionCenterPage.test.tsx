import { act, screen, waitFor, within } from '@testing-library/react';
import type { ActionItemPage, CurrentUser } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import {
  actionPage,
  aNoticeAction,
  anInstructionsAction,
  aReplacementAction,
  aReviewAction,
  emptyActionPage,
  noticeAction,
  REJECTION_REASON,
} from '../../../test/fixtures/action-items';
import { aCurrentUser, anotherUser } from '../../../test/fixtures/auth';
import { aVoyageDetail } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from '../../auth/session-sync';
import { recordLinkPath } from '../../voyages/navigation/record-link';

const voyage = aVoyageDetail();
/** Claire operates for Lacustra, which buys under contract 1 and sells under contract 2. */
const claire = anotherUser();
const claireAsViewer: CurrentUser = { ...claire, user: { ...claire.user, role: 'VIEWER' } };
const ana = aCurrentUser();

interface QueueRequest {
  type: string | null;
  overdue: string | null;
  cursor: string | null;
  signal: AbortSignal;
}

/**
 * Serves the queue with `respond`, which may wait. Records what each request asked for and its
 * abort signal, so tests can see the filters and cursors sent, and what was cancelled.
 */
function serveQueue(
  respond: (request: QueueRequest) => Response | Promise<Response>,
): QueueRequest[] {
  const requests: QueueRequest[] = [];
  server.use(
    http.get('*/api/action-items', ({ request }) => {
      const params = new URL(request.url).searchParams;
      const sent: QueueRequest = {
        type: params.get('type'),
        overdue: params.get('overdue'),
        cursor: params.get('cursor'),
        signal: request.signal,
      };
      requests.push(sent);
      return respond(sent);
    }),
  );
  return requests;
}

/** A response the test lets through explicitly. */
function aGate() {
  let release: () => void = () => undefined;
  const opened = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrive: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  return {
    received,
    release,
    /** Called by the handler: signals arrival, then waits for `release`. */
    async pass() {
      arrive();
      await opened;
    },
  };
}

const json = (body: ActionItemPage | object) => HttpResponse.json(body);

const queueList = () => screen.findByRole('list', { name: 'Actions' });
const queueItems = async () => within(await queueList()).getAllByRole('listitem');
const headings = async () =>
  (await queueItems()).map((item) => within(item).getByRole('heading').textContent);

type Rendered = ReturnType<typeof renderRoute>;

const watchers: (() => void)[] = [];
afterEach(() => {
  watchers.splice(0).forEach((stop) => {
    stop();
  });
});

/** Starts cross-tab sync and returns the channel another tab would post on. */
function anotherTab(queryClient: Rendered['queryClient']) {
  const stopSync = startSessionSync(queryClient);
  const channel = new BroadcastChannel(SESSION_CHANNEL_NAME);
  watchers.push(() => {
    channel.close();
    stopSync();
  });
  return channel;
}

/** Another tab signs in as `identity`; this tab follows once the server confirms it. */
async function anotherTabSignsInAs(
  tab: BroadcastChannel,
  { session, queryClient }: Pick<Rendered, 'session' | 'queryClient'>,
  identity: CurrentUser,
) {
  session.current = identity;
  tab.postMessage(SESSION_CHANGED);
  await waitFor(() => {
    expect(queryClient.getQueryData(['session'])).toEqual(identity);
  });
}

const scopeOf = (identity: CurrentUser) => `${identity.user.id}:${identity.organization.id}`;

describe('The Action Center', () => {
  describe('routing', () => {
    it('is a protected page: signing in from it comes back to it', async () => {
      serveQueue(() => json(actionPage([aReviewAction()])));
      const { user, router } = renderRoute('/actions', { signedInAs: null, accounts: [claire] });

      await user.type(await screen.findByLabelText(/Email/), claire.user.email);
      await user.type(screen.getByLabelText(/Password/), 'tradeflow-demo');
      await user.click(screen.getByRole('button', { name: 'Sign in' }));

      expect(await screen.findByRole('heading', { name: 'Action Center' })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/actions');
      expect(await headings()).toEqual(['Review document']);
    });

    it('is in the main navigation, next to the voyages', async () => {
      server.use(http.get('*/api/voyages', () => HttpResponse.json({ items: [] })));
      serveQueue(() => json(emptyActionPage()));
      const { user, router } = renderRoute('/voyages', { signedInAs: claire });

      const nav = within(await screen.findByRole('navigation', { name: 'Main' }));
      await user.click(nav.getByRole('link', { name: 'Action Center' }));

      expect(await screen.findByRole('heading', { name: 'Action Center' })).toBeInTheDocument();
      expect(router.state.location.pathname).toBe('/actions');
      expect(nav.getByRole('link', { name: 'Action Center' })).toHaveAttribute(
        'aria-current',
        'page',
      );
      expect(nav.getByRole('link', { name: 'Voyages' })).not.toHaveAttribute('aria-current');
    });

    it('signs out when the queue answers 401', async () => {
      serveQueue(() => problemResponse(401, 'Authentication is required.'));
      const { router } = renderRoute('/actions', { signedInAs: claire });

      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
    });
  });

  describe('items', () => {
    it('shows each kind of action with what it concerns, and a link to its exact record', async () => {
      const notice = aNoticeAction({ overdue: true });
      const instructions = anInstructionsAction();
      const review = aReviewAction();
      const replacement = aReplacementAction();
      serveQueue(() => json(actionPage([notice, instructions, review, replacement])));
      renderRoute('/actions', { signedInAs: claire });

      expect(await headings()).toEqual([
        'Acknowledge ETA notice',
        'Acknowledge instructions',
        'Review document',
        'Replace rejected document',
      ]);
      const [noticeItem, instructionsItem, reviewItem, replacementItem] = (await queueItems()).map(
        (item) => within(item),
      );
      if (!noticeItem || !instructionsItem || !reviewItem || !replacementItem) throw new Error();

      // A notice: its deadline and whether it has passed; no revision or file.
      expect(noticeItem.getByText('Overdue')).toBeInTheDocument();
      expect(
        noticeItem.getByText(
          'Acknowledge receipt of the ETA notice Cerrado Grãos Exportadora S.A. issued.',
        ),
      ).toBeInTheDocument();
      expect(noticeItem.getByText('TF-2026-0001')).toBeInTheDocument();
      expect(
        noticeItem.getByText('Cerrado Grãos Exportadora S.A. · Contract 1'),
      ).toBeInTheDocument();
      expect(noticeItem.getByText('20 Oct 2030, 12:00 GMT-3 (overdue)')).toBeInTheDocument();
      expect(noticeItem.getByText('15 Oct 2030, 09:00 GMT-3')).toBeInTheDocument();
      expect(noticeItem.queryByText('Record')).not.toBeInTheDocument();
      expect(noticeItem.queryByText('Reason for rejection')).not.toBeInTheDocument();
      expect(
        noticeItem.getByRole('link', { name: 'Open ETA notice on TF-2026-0001, contract 1' }),
      ).toHaveAttribute('href', recordLinkPath(notice.target));

      // Instructions: the exact revision; no deadline, never overdue.
      expect(instructionsItem.getByText('Revision 2')).toBeInTheDocument();
      expect(instructionsItem.getByText('Nordlys Trading B.V. · Contract 2')).toBeInTheDocument();
      expect(instructionsItem.queryByText('Acknowledge by')).not.toBeInTheDocument();
      expect(instructionsItem.queryByText('Overdue')).not.toBeInTheDocument();
      expect(instructionsItem.queryByText('Reason for rejection')).not.toBeInTheDocument();
      expect(
        instructionsItem.getByRole('link', { name: 'Open revision 2 on TF-2026-0001, contract 2' }),
      ).toHaveAttribute('href', recordLinkPath(instructions.target));

      // A review: the exact file version and the revision it answers.
      expect(
        reviewItem.getByText('Bill of lading, version 2 (instructions revision 1)'),
      ).toBeInTheDocument();
      expect(
        reviewItem.getByText(
          'Approve or reject version 2 of the bill of lading Cerrado Grãos Exportadora S.A. presented.',
        ),
      ).toBeInTheDocument();
      expect(reviewItem.queryByText('Acknowledge by')).not.toBeInTheDocument();
      expect(reviewItem.queryByText('Reason for rejection')).not.toBeInTheDocument();
      expect(
        reviewItem.getByRole('link', { name: 'Open version 2 on TF-2026-0001, contract 1' }),
      ).toHaveAttribute('href', recordLinkPath(review.target));

      // A replacement: the rejected file and the buyer's reason.
      expect(
        replacementItem.getByText('Commercial invoice, version 1 (instructions revision 1)'),
      ).toBeInTheDocument();
      expect(replacementItem.getByText('Reason for rejection')).toBeInTheDocument();
      expect(replacementItem.getByText(REJECTION_REASON)).toBeInTheDocument();
      expect(replacementItem.queryByText('Acknowledge by')).not.toBeInTheDocument();
      expect(
        replacementItem.getByRole('link', { name: 'Open version 1 on TF-2026-0001, contract 2' }),
      ).toHaveAttribute('href', recordLinkPath(replacement.target));

      // Links are reachable from the keyboard, in the queue's order.
      const links = (await queueItems()).map((item) => within(item).getByRole('link'));
      expect(links.every((link) => link.tagName === 'A')).toBe(true);
    });

    it('marks only overdue notices as overdue', async () => {
      serveQueue(() => json(actionPage([aNoticeAction({ overdue: false })])));
      renderRoute('/actions', { signedInAs: claire });

      const [item] = await queueItems();
      if (!item) throw new Error();
      expect(within(item).queryByText('Overdue')).not.toBeInTheDocument();
      expect(within(item).getByText('20 Oct 2030, 12:00 GMT-3')).toBeInTheDocument();
    });

    it('says when it was loaded and never counts the items as the whole queue', async () => {
      serveQueue(({ cursor }) =>
        json(cursor ? actionPage([noticeAction(3)]) : actionPage([noticeAction(1)], 'next')),
      );
      const { user } = renderRoute('/actions', { signedInAs: claire });

      expect(
        await screen.findByText(/Loaded 18 Oct 2030, 09:00 GMT-3; it does not update on its own\./),
      ).toBeInTheDocument();
      expect(screen.queryByText(/\d+ actions?\b/)).not.toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Load more' }));
      expect(
        await screen.findByText(
          'End of the list as loaded. Refresh to see what has changed since.',
        ),
      ).toBeInTheDocument();
      expect(screen.queryByText(/\d+ actions?\b/)).not.toBeInTheDocument();
    });

    it('shows viewers the same queue and links, with no command anywhere', async () => {
      serveQueue(() => json(actionPage([aNoticeAction(), aReviewAction()])));
      renderRoute('/actions', { signedInAs: claireAsViewer });

      expect(await headings()).toEqual(['Acknowledge ETA notice', 'Review document']);
      expect(
        screen.getByText(
          'You can open every record listed here. Acting on them is for an operator in your organization.',
        ),
      ).toBeInTheDocument();
      expect(screen.getAllByRole('link', { name: /^Open / })).toHaveLength(2);
      expect(
        screen.queryByRole('button', { name: /acknowledge|approve|reject|upload/i }),
      ).not.toBeInTheDocument();
    });

    it('says nothing to viewers that operators need not hear', async () => {
      serveQueue(() => json(actionPage([aNoticeAction()])));
      renderRoute('/actions', { signedInAs: claire });

      await queueList();
      expect(screen.queryByText(/Acting on them is for an operator/)).not.toBeInTheDocument();
    });
  });

  describe('filters', () => {
    it('keeps them in the URL, sends them to the API, and follows back and forward', async () => {
      const requests = serveQueue(() => json(emptyActionPage()));
      const { user, router } = renderRoute('/actions', { signedInAs: claire });
      await screen.findByText('Nothing is waiting for your organization');
      expect(requests[0]).toMatchObject({ type: null, overdue: null, cursor: null });

      await user.selectOptions(screen.getByLabelText('Action'), 'Acknowledge ETA notice');
      expect(router.state.location.search).toBe('?type=ACKNOWLEDGE_NOTICE');
      await waitFor(() => {
        expect(requests.at(-1)).toMatchObject({ type: 'ACKNOWLEDGE_NOTICE', overdue: null });
      });

      await user.click(screen.getByRole('checkbox', { name: 'Overdue only' }));
      expect(router.state.location.search).toBe('?type=ACKNOWLEDGE_NOTICE&overdue=true');
      await waitFor(() => {
        expect(requests.at(-1)).toMatchObject({ type: 'ACKNOWLEDGE_NOTICE', overdue: 'true' });
      });

      await act(() => router.navigate(-1));
      expect(router.state.location.search).toBe('?type=ACKNOWLEDGE_NOTICE');
      expect(screen.getByRole('checkbox', { name: 'Overdue only' })).not.toBeChecked();
      expect(screen.getByLabelText('Action')).toHaveValue('ACKNOWLEDGE_NOTICE');
      await waitFor(() => {
        expect(requests.at(-1)).toMatchObject({ type: 'ACKNOWLEDGE_NOTICE', overdue: null });
      });

      await act(() => router.navigate(-1));
      expect(router.state.location.search).toBe('');
      expect(screen.getByLabelText('Action')).toHaveValue('');
      await waitFor(() => {
        expect(requests.at(-1)).toMatchObject({ type: null, overdue: null });
      });

      await act(() => router.navigate(2));
      expect(router.state.location.search).toBe('?type=ACKNOWLEDGE_NOTICE&overdue=true');
      expect(screen.getByRole('checkbox', { name: 'Overdue only' })).toBeChecked();
      await waitFor(() => {
        expect(requests.at(-1)).toMatchObject({ type: 'ACKNOWLEDGE_NOTICE', overdue: 'true' });
      });
      // Every request started from the first page.
      expect(requests.every(({ cursor }) => cursor === null)).toBe(true);
    });

    it('restores them from the URL on load', async () => {
      const requests = serveQueue(() => json(actionPage([aNoticeAction({ overdue: true })])));
      renderRoute('/actions?type=ACKNOWLEDGE_NOTICE&overdue=true', { signedInAs: claire });

      expect(await headings()).toEqual(['Acknowledge ETA notice']);
      expect(screen.getByLabelText('Action')).toHaveValue('ACKNOWLEDGE_NOTICE');
      expect(screen.getByRole('checkbox', { name: 'Overdue only' })).toBeChecked();
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ type: 'ACKNOWLEDGE_NOTICE', overdue: 'true' });
    });

    it('ignores values it does not know, says so, and can remove them from the address', async () => {
      const requests = serveQueue(() => json(actionPage([aReviewAction()])));
      const { user, router } = renderRoute('/actions?type=BOGUS&overdue=yes', {
        signedInAs: claire,
      });

      expect(await headings()).toEqual(['Review document']);
      expect(
        screen.getByText(
          'The address has filters the Action Center does not recognise (type, overdue), so they are ignored.',
        ),
      ).toBeInTheDocument();
      expect(screen.getByLabelText('Action')).toHaveValue('');
      expect(screen.getByRole('checkbox', { name: 'Overdue only' })).not.toBeChecked();
      expect(requests[0]).toMatchObject({ type: null, overdue: null });

      await user.click(screen.getByRole('button', { name: 'Remove from address' }));
      expect(router.state.location.search).toBe('');
      expect(router.state.historyAction).toBe('REPLACE');
      expect(screen.queryByText(/does not recognise/)).not.toBeInTheDocument();
      // The same queue: nothing is asked again.
      expect(requests).toHaveLength(1);
    });

    it('treats a filter given twice as unknown', async () => {
      const requests = serveQueue(() => json(emptyActionPage()));
      renderRoute('/actions?type=REVIEW_DOCUMENT&type=ACKNOWLEDGE_NOTICE', {
        signedInAs: claire,
      });

      expect(
        await screen.findByText(
          'The address has a filter the Action Center does not recognise (type), so it is ignored.',
        ),
      ).toBeInTheDocument();
      expect(requests[0]).toMatchObject({ type: null });
    });

    it('starts a new filter from its first page, never showing the previous filter’s items', async () => {
      const filtered = aGate();
      const requests = serveQueue(async ({ type, cursor }) => {
        if (type === 'REVIEW_DOCUMENT') {
          await filtered.pass();
          return json(actionPage([aReviewAction()]));
        }
        return json(
          cursor === 'after-2'
            ? actionPage([noticeAction(3)])
            : actionPage([noticeAction(1), noticeAction(2)], 'after-2'),
        );
      });
      const { user } = renderRoute('/actions', { signedInAs: claire });

      expect(await queueItems()).toHaveLength(2);
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(async () => {
        expect(await queueItems()).toHaveLength(3);
      });

      await user.selectOptions(screen.getByLabelText('Action'), 'Review document');
      await filtered.received;
      expect(screen.getByLabelText('Loading actions')).toBeInTheDocument();
      expect(screen.queryByRole('list', { name: 'Actions' })).not.toBeInTheDocument();
      expect(
        screen.queryByRole('heading', { name: 'Acknowledge ETA notice' }),
      ).not.toBeInTheDocument();
      filtered.release();

      expect(await headings()).toEqual(['Review document']);
      expect(requests.map(({ type, cursor }) => [type, cursor])).toEqual([
        [null, null],
        [null, 'after-2'],
        ['REVIEW_DOCUMENT', null],
      ]);
    });

    it('sends the filters with every cursor', async () => {
      const requests = serveQueue(({ cursor }) =>
        json(
          cursor
            ? actionPage([noticeAction(2)])
            : actionPage([aNoticeAction({ overdue: true })], 'next'),
        ),
      );
      const { user } = renderRoute('/actions?type=ACKNOWLEDGE_NOTICE&overdue=true', {
        signedInAs: claire,
      });

      await queueList();
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(async () => {
        expect(await queueItems()).toHaveLength(2);
      });
      expect(requests.map(({ type, overdue, cursor }) => [type, overdue, cursor])).toEqual([
        ['ACKNOWLEDGE_NOTICE', 'true', null],
        ['ACKNOWLEDGE_NOTICE', 'true', 'next'],
      ]);
    });
  });

  describe('loading, pages and refreshing', () => {
    it('shows a placeholder while the first page is on its way', async () => {
      const gate = aGate();
      serveQueue(async () => {
        await gate.pass();
        return json(actionPage([aReviewAction()]));
      });
      renderRoute('/actions', { signedInAs: claire });

      await gate.received;
      expect(await screen.findByLabelText('Loading actions')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled();
      gate.release();

      expect(await headings()).toEqual(['Review document']);
      expect(screen.queryByLabelText('Loading actions')).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Refresh' })).toBeEnabled();
    });

    it('says when nothing is waiting', async () => {
      serveQueue(() => json(emptyActionPage()));
      renderRoute('/actions', { signedInAs: claire });

      expect(await screen.findByText('Nothing is waiting for your organization')).toBeVisible();
      expect(screen.queryByRole('list', { name: 'Actions' })).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    });

    it('says when nothing matches the filters, and can clear them', async () => {
      const requests = serveQueue(({ type }) =>
        json(type ? emptyActionPage() : actionPage([aNoticeAction()])),
      );
      const { user, router } = renderRoute('/actions?type=REVIEW_DOCUMENT', {
        signedInAs: claire,
      });

      expect(await screen.findByText('No actions match these filters')).toBeVisible();
      expect(
        screen.getByText('Other actions may be waiting for your organization.'),
      ).toBeInTheDocument();

      await user.click(screen.getByRole('button', { name: 'Show all actions' }));
      expect(router.state.location.search).toBe('');
      expect(await headings()).toEqual(['Acknowledge ETA notice']);
      expect(requests.at(-1)).toMatchObject({ type: null, overdue: null });
    });

    it('explains that only notices can be overdue', async () => {
      serveQueue(() => json(emptyActionPage()));
      renderRoute('/actions?type=REVIEW_DOCUMENT&overdue=true', { signedInAs: claire });

      expect(
        await screen.findByText(
          'Only ETA notices have a deadline, so a “Review document” action is never overdue.',
        ),
      ).toBeInTheDocument();
    });

    it('loads further pages with the cursor of the page before, until there are none', async () => {
      const last = aGate();
      const requests = serveQueue(async ({ cursor }) => {
        if (cursor === 'after-4') await last.pass();
        const pages: Record<string, ActionItemPage> = {
          first: actionPage([noticeAction(1), noticeAction(2)], 'after-2'),
          'after-2': actionPage([noticeAction(3), noticeAction(4)], 'after-4'),
          'after-4': actionPage([aReviewAction()]),
        };
        return json(pages[cursor ?? 'first'] ?? emptyActionPage());
      });
      const { user } = renderRoute('/actions', { signedInAs: claire });

      expect(await queueItems()).toHaveLength(2);
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(async () => {
        expect(await queueItems()).toHaveLength(4);
      });

      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await last.received;
      // While a page is on its way, it cannot be asked for twice; what is shown stays.
      expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
      expect(await queueList()).toHaveAttribute('aria-busy', 'true');
      expect(await queueItems()).toHaveLength(4);
      last.release();

      await waitFor(async () => {
        expect(await queueItems()).toHaveLength(5);
      });
      expect((await headings()).at(-1)).toBe('Review document');
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
      expect(requests.map(({ cursor }) => cursor)).toEqual([null, 'after-2', 'after-4']);
    });

    it('reports a failed first page, and retries it on request', async () => {
      let fail = true;
      serveQueue(() => (fail ? problemResponse(500, 'Boom') : json(actionPage([aReviewAction()]))));
      const { user } = renderRoute('/actions', { signedInAs: claire });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Actions could not be loaded');
      expect(alert).not.toHaveTextContent('Boom');

      fail = false;
      await user.click(within(alert).getByRole('button', { name: 'Retry' }));

      expect(await headings()).toEqual(['Review document']);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    });

    it('keeps what it has when a further page fails, and retries that page', async () => {
      let failNext = true;
      const requests = serveQueue(({ cursor }) => {
        if (cursor === null) return json(actionPage([noticeAction(1)], 'after-1'));
        return failNext ? problemResponse(500, 'Boom') : json(actionPage([aReviewAction()]));
      });
      const { user } = renderRoute('/actions', { signedInAs: claire });

      expect(await queueItems()).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Load more' }));

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('More actions could not be loaded. Please try again.');
      expect(await queueItems()).toHaveLength(1);
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

      failNext = false;
      await user.click(within(alert).getByRole('button', { name: 'Retry' }));

      expect(await headings()).toEqual(['Acknowledge ETA notice', 'Review document']);
      expect(screen.queryByRole('alert')).not.toBeInTheDocument();
      expect(requests.map(({ cursor }) => cursor)).toEqual([null, 'after-1', 'after-1']);
    });

    it('refreshes from the first page, dropping every page loaded before', async () => {
      let refreshed = false;
      const requests = serveQueue(({ cursor }) => {
        if (refreshed) return json(actionPage([aReviewAction()], 'fresh-cursor'));
        return json(
          cursor ? actionPage([noticeAction(2)]) : actionPage([noticeAction(1)], 'after-1'),
        );
      });
      const { user } = renderRoute('/actions', { signedInAs: claire });

      expect(await queueItems()).toHaveLength(1);
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(async () => {
        expect(await queueItems()).toHaveLength(2);
      });

      refreshed = true;
      await user.click(screen.getByRole('button', { name: 'Refresh' }));

      await waitFor(async () => {
        expect(await headings()).toEqual(['Review document']);
      });
      expect(screen.getByRole('button', { name: 'Load more' })).toBeEnabled();
      expect(requests.map(({ cursor }) => cursor)).toEqual([null, 'after-1', null]);
    });

    it('starts again from the first page when the user comes back to it', async () => {
      server.use(http.get('*/api/voyages', () => HttpResponse.json({ items: [] })));
      const requests = serveQueue(({ cursor }) =>
        json(cursor ? actionPage([noticeAction(2)]) : actionPage([noticeAction(1)], 'after-1')),
      );
      const { user, router, queryClient } = renderRoute('/actions', { signedInAs: claire });

      await queueList();
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await waitFor(async () => {
        expect(await queueItems()).toHaveLength(2);
      });

      await act(() => router.navigate('/voyages'));
      // Once nothing shows it, the walk through the pages is dropped.
      await waitFor(() => {
        expect(
          queryClient
            .getQueryCache()
            .findAll({ queryKey: ['protected', scopeOf(claire), 'action-items'] }),
        ).toHaveLength(0);
      });
      await act(() => router.navigate(-1));

      await waitFor(async () => {
        expect(await queueItems()).toHaveLength(1);
      });
      expect(requests.map(({ cursor }) => cursor)).toEqual([null, 'after-1', null]);
    });
  });

  describe('responses that break the contract', () => {
    it('reports a malformed first page as a failure, showing nothing of it', async () => {
      const broken = {
        ...actionPage([aReviewAction()]),
        // The target must be on the item's own voyage.
        items: [
          { ...aReviewAction(), voyage: { id: voyage.id.replace(/1$/, '2'), reference: 'X' } },
        ],
      };
      serveQueue(() => json(broken));
      renderRoute('/actions', { signedInAs: claire });

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Actions could not be loaded');
      expect(screen.queryByRole('list', { name: 'Actions' })).not.toBeInTheDocument();
    });

    it('reports a malformed further page as a failure, keeping the pages before', async () => {
      serveQueue(({ cursor }) =>
        cursor
          ? json({ ...actionPage([]), items: [{ ...noticeAction(2), type: 'ESCALATE' }] })
          : json(actionPage([noticeAction(1)], 'after-1')),
      );
      const { user } = renderRoute('/actions', { signedInAs: claire });

      await queueList();
      await user.click(screen.getByRole('button', { name: 'Load more' }));

      expect(await screen.findByRole('alert')).toHaveTextContent(
        'More actions could not be loaded. Please try again.',
      );
      expect(await headings()).toEqual(['Acknowledge ETA notice']);
    });
  });

  describe('when the identity changes while a page is on its way', () => {
    it("cancels Ana's first page and shows Claire only her own queue", async () => {
      const rendered = renderRoute('/actions', { signedInAs: ana, accounts: [ana, claire] });
      const { session, queryClient } = rendered;
      const otherTab = anotherTab(queryClient);
      const anasPage = aGate();
      const requests = serveQueue(async () => {
        // Who the cookie belongs to when the request arrives decides the answer.
        if (session.current === claire) return json(actionPage([aReviewAction()]));
        await anasPage.pass();
        return json(actionPage([noticeAction(9)], 'anas-cursor'));
      });
      await anasPage.received;

      await anotherTabSignsInAs(otherTab, rendered, claire);
      expect(await headings()).toEqual(['Review document']);
      expect(requests[0]?.signal.aborted).toBe(true);

      anasPage.release();
      // Let Ana's late answer arrive, if anything were still listening for it.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await headings()).toEqual(['Review document']);
      expect(
        screen.queryByRole('heading', { name: 'Acknowledge ETA notice' }),
      ).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ['protected'] })) {
        expect(query.queryKey[1]).toBe(scopeOf(claire));
      }
    });

    it("cancels Ana's further page and never sends her cursor for Claire", async () => {
      const rendered = renderRoute('/actions', { signedInAs: ana, accounts: [ana, claire] });
      const { user, session, queryClient } = rendered;
      const otherTab = anotherTab(queryClient);
      const anasNextPage = aGate();
      const requests = serveQueue(async ({ cursor }) => {
        if (session.current === claire) return json(actionPage([aReviewAction()]));
        if (cursor === null) return json(actionPage([noticeAction(9)], 'anas-cursor'));
        await anasNextPage.pass();
        return json(actionPage([noticeAction(10)]));
      });

      expect(await headings()).toEqual(['Acknowledge ETA notice']);
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await anasNextPage.received;

      await anotherTabSignsInAs(otherTab, rendered, claire);
      expect(await headings()).toEqual(['Review document']);
      expect(requests[1]?.signal.aborted).toBe(true);

      anasNextPage.release();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await headings()).toEqual(['Review document']);
      expect(requests.map(({ cursor }) => cursor)).toEqual([null, 'anas-cursor', null]);
      for (const query of queryClient.getQueryCache().findAll({ queryKey: ['protected'] })) {
        expect(query.queryKey[1]).toBe(scopeOf(claire));
      }
    });
  });
});
