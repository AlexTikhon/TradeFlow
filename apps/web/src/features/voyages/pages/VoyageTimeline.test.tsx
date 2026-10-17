import { screen, waitFor, within } from '@testing-library/react';
import type { CurrentUser, TimelineEvent, VoyageTimelinePage } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser } from '../../../test/fixtures/auth';
import { claire as claireActor } from '../../../test/fixtures/notices';
import {
  emptyTimeline,
  eventBase,
  noticeIssued,
  timelineContract1,
  timelinePage,
  voyageCreated,
} from '../../../test/fixtures/timeline';
import { aTradeString, aVoyageDetail } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from '../../auth/session-sync';

const voyage = aVoyageDetail();
const page = `/voyages/${voyage.id}`;

const ana = aCurrentUser();
const claire = anotherUser();

/** Serves everything on the details page but the timeline, which each test states. */
function servePage() {
  server.use(
    http.get(`*/api/voyages/${voyage.id}`, () => HttpResponse.json(voyage)),
    http.get(`*/api/voyages/${voyage.id}/trade-string`, () => HttpResponse.json(aTradeString())),
    http.get(`*/api/voyages/${voyage.id}/my-contracts`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${voyage.id}/notices`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${voyage.id}/documentary-instructions`, () =>
      HttpResponse.json({ items: [] }),
    ),
    http.get(`*/api/voyages/${voyage.id}/documents`, () => HttpResponse.json({ items: [] })),
  );
}

interface TimelineRequest {
  cursor: string | null;
  signal: AbortSignal;
}

/**
 * Serves the timeline with `respond`, which may wait. Records each request's cursor and abort
 * signal, so tests can see what was asked and what was cancelled.
 */
function serveTimeline(
  respond: (cursor: string | null) => Response | Promise<Response>,
): TimelineRequest[] {
  const requests: TimelineRequest[] = [];
  server.use(
    http.get(`*/api/voyages/${voyage.id}/timeline`, ({ request }) => {
      const cursor = new URL(request.url).searchParams.get('cursor');
      requests.push({ cursor, signal: request.signal });
      return respond(cursor);
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

const json = (body: VoyageTimelinePage) => HttpResponse.json(body);

const timelineList = () => screen.findByRole('list', { name: 'Timeline' });
const timelineItems = async () => within(await timelineList()).getAllByRole('listitem');
const timelineText = async () => (await timelineItems()).map((item) => item.textContent);

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

const protectedQueries = (queryClient: Rendered['queryClient']) =>
  queryClient.getQueryCache().findAll({ queryKey: ['protected'] });

const scopeOf = (identity: CurrentUser) => `${identity.user.id}:${identity.organization.id}`;

describe('The timeline on the voyage page', () => {
  it('shows a placeholder while loading, then every kind of event, newest first', async () => {
    servePage();
    const gate = aGate();
    const byClaire = (n: number, occurredAt?: string) => eventBase(n, occurredAt, claireActor);
    const document = (documentId: number) => ({
      contract: timelineContract1,
      documentId: `01990000-0000-7000-8011-00000000000${documentId}`,
      revisionNumber: 1,
    });
    const instruction = {
      contract: timelineContract1,
      instructionId: '01990000-0000-7000-8012-000000000001',
    };
    const events: TimelineEvent[] = [
      {
        ...byClaire(9, '2030-10-16T13:30:00.000Z'),
        ...document(1),
        action: 'DOCUMENT_VERSION_REVIEWED',
        documentType: 'BILL_OF_LADING',
        versionNumber: 2,
        decision: 'REJECTED',
        version: 4,
      },
      {
        ...eventBase(8),
        ...document(1),
        action: 'DOCUMENT_VERSION_UPLOADED',
        documentType: 'BILL_OF_LADING',
        versionNumber: 2,
        version: 3,
      },
      {
        ...eventBase(7),
        ...document(2),
        action: 'DOCUMENT_VERSION_UPLOADED',
        documentType: 'PHYTOSANITARY_CERTIFICATE',
        versionNumber: 1,
        // Recorded before document versions existed.
        version: null,
      },
      {
        ...eventBase(6),
        ...instruction,
        action: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
        revisionNumber: 2,
        version: 3,
      },
      {
        ...byClaire(5),
        ...instruction,
        action: 'DOCUMENTARY_INSTRUCTION_REVISED',
        revisionNumber: 2,
        version: 2,
      },
      {
        ...byClaire(4),
        ...instruction,
        action: 'DOCUMENTARY_INSTRUCTION_REVISED',
        revisionNumber: 1,
        version: 1,
      },
      {
        ...byClaire(3),
        action: 'NOTICE_ACKNOWLEDGED',
        contract: timelineContract1,
        noticeId: '01990000-0000-7000-8009-000000000002',
      },
      noticeIssued(2),
      voyageCreated(1),
    ];
    serveTimeline(async () => {
      await gate.pass();
      return json(timelinePage(events));
    });
    renderRoute(page);

    await gate.received;
    expect(await screen.findByLabelText('Loading timeline')).toBeInTheDocument();
    gate.release();

    expect(await timelineText()).toEqual([
      'Rejected version 2 of the bill of lading (instructions revision 1)' +
        '16 Oct 2030, 10:30 GMT-3 · Claire Morel (Lacustra Commodities SA) · Contract 1',
      'Uploaded version 2 of the bill of lading (instructions revision 1)' +
        '15 Oct 2030, 09:00 GMT-3 · Ana Souza (Cerrado Grãos Exportadora S.A.) · Contract 1',
      'Uploaded version 1 of the phytosanitary certificate (instructions revision 1)' +
        '15 Oct 2030, 09:00 GMT-3 · Ana Souza (Cerrado Grãos Exportadora S.A.) · Contract 1',
      'Acknowledged revision 2 of the documentary instructions' +
        '15 Oct 2030, 09:00 GMT-3 · Ana Souza (Cerrado Grãos Exportadora S.A.) · Contract 1',
      'Revised the documentary instructions (revision 2)' +
        '15 Oct 2030, 09:00 GMT-3 · Claire Morel (Lacustra Commodities SA) · Contract 1',
      'Gave documentary instructions' +
        '15 Oct 2030, 09:00 GMT-3 · Claire Morel (Lacustra Commodities SA) · Contract 1',
      'Acknowledged receipt of a notice' +
        '15 Oct 2030, 09:00 GMT-3 · Claire Morel (Lacustra Commodities SA) · Contract 1',
      'Issued a notice' +
        '15 Oct 2030, 09:00 GMT-3 · Ana Souza (Cerrado Grãos Exportadora S.A.) · Contract 1',
      // About the voyage itself: no contract.
      'Created the voyage' + '1 Oct 2030, 08:00 GMT-3 · Ana Souza (Cerrado Grãos Exportadora S.A.)',
    ]);
    expect(screen.queryByLabelText('Loading timeline')).not.toBeInTheDocument();
    // Everything is on one page.
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
  });

  it('says when there is nothing to show yet', async () => {
    servePage();
    serveTimeline(() => json(emptyTimeline));
    renderRoute(page);

    expect(
      await screen.findByText(
        'Nothing your organization can see has been recorded on this voyage yet.',
      ),
    ).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: 'Timeline' })).not.toBeInTheDocument();
  });

  it('loads older pages with the cursor of the page before, until there are none', async () => {
    servePage();
    const pages: Record<string, VoyageTimelinePage> = {
      first: timelinePage([noticeIssued(5), noticeIssued(4)], 'cursor-after-4'),
      'cursor-after-4': timelinePage([noticeIssued(3), noticeIssued(2)], 'cursor-after-2'),
      'cursor-after-2': timelinePage([voyageCreated(1)]),
    };
    const gate = aGate();
    const requests = serveTimeline(async (cursor) => {
      if (cursor === 'cursor-after-2') await gate.pass();
      return json(pages[cursor ?? 'first'] ?? emptyTimeline);
    });
    const { user } = renderRoute(page);

    expect(await timelineItems()).toHaveLength(2);
    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await waitFor(async () => {
      expect(await timelineItems()).toHaveLength(4);
    });

    await user.click(screen.getByRole('button', { name: 'Load more' }));
    await gate.received;
    // While a page is on its way, the button cannot ask for it twice.
    expect(screen.getByRole('button', { name: 'Load more' })).toBeDisabled();
    expect(await timelineList()).toHaveAttribute('aria-busy', 'true');
    gate.release();

    await waitFor(async () => {
      expect(await timelineItems()).toHaveLength(5);
    });
    expect((await timelineText()).at(-1)).toMatch(/^Created the voyage/);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(requests.map(({ cursor }) => cursor)).toEqual([
      null,
      'cursor-after-4',
      'cursor-after-2',
    ]);
  });

  it('reports a failed first load in its own card, and retries on request', async () => {
    servePage();
    let fail = true;
    serveTimeline(() =>
      fail ? problemResponse(500, 'Boom') : json(timelinePage([voyageCreated()])),
    );
    const { user } = renderRoute(page);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Timeline could not be loaded');
    // Server internals are not shown.
    expect(alert).not.toHaveTextContent('Boom');
    // The rest of the page stays.
    expect(screen.getByRole('heading', { name: voyage.reference })).toBeInTheDocument();

    fail = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    expect(await timelineText()).toEqual([expect.stringMatching(/^Created the voyage/)]);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('keeps what it has when an older page fails, and retries that page', async () => {
    servePage();
    let failNext = true;
    const requests = serveTimeline((cursor) => {
      if (cursor === null) return json(timelinePage([noticeIssued(2)], 'cursor-after-2'));
      return failNext ? problemResponse(500, 'Boom') : json(timelinePage([voyageCreated(1)]));
    });
    const { user } = renderRoute(page);

    expect(await timelineItems()).toHaveLength(1);
    await user.click(screen.getByRole('button', { name: 'Load more' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Older events could not be loaded. Please try again.');
    expect(await timelineItems()).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();

    failNext = false;
    await user.click(within(alert).getByRole('button', { name: 'Retry' }));

    await waitFor(async () => {
      expect(await timelineItems()).toHaveLength(2);
    });
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(requests.map(({ cursor }) => cursor)).toEqual([
      null,
      'cursor-after-2',
      'cursor-after-2',
    ]);
  });

  describe('when the identity changes while a timeline request is on its way', () => {
    const anasEvent = noticeIssued(7);
    const clairesEvent: TimelineEvent = {
      ...eventBase(8, undefined, claireActor),
      action: 'NOTICE_ACKNOWLEDGED',
      contract: timelineContract1,
      noticeId: '01990000-0000-7000-8009-000000000007',
    };

    it("cancels Ana's first page and shows Claire only her own", async () => {
      servePage();
      const rendered = renderRoute(page, { accounts: [ana, claire] });
      const { session, queryClient } = rendered;
      const otherTab = anotherTab(queryClient);
      const anasPage = aGate();
      const requests = serveTimeline(async () => {
        // Who the cookie belongs to when the request arrives decides the answer.
        if (session.current === claire) return json(timelinePage([clairesEvent]));
        await anasPage.pass();
        return json(timelinePage([anasEvent], 'anas-cursor'));
      });
      await anasPage.received;

      await anotherTabSignsInAs(otherTab, rendered, claire);
      expect(await timelineText()).toEqual([
        expect.stringMatching(/^Acknowledged receipt of a notice.*Claire Morel/),
      ]);
      expect(requests[0]?.signal.aborted).toBe(true);

      anasPage.release();
      await waitFor(() => {
        expect(requests).toHaveLength(2);
      });
      // Let Ana's late answer arrive, if anything were still listening for it.
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await timelineText()).toEqual([
        expect.stringMatching(/^Acknowledged receipt of a notice.*Claire Morel/),
      ]);
      expect(screen.queryByText(/Issued a notice/)).not.toBeInTheDocument();
      expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
      for (const query of protectedQueries(queryClient)) {
        expect(query.queryKey[1]).toBe(scopeOf(claire));
      }
    });

    it("cancels Ana's older page and lets nothing of hers reach Claire", async () => {
      servePage();
      const rendered = renderRoute(page, { accounts: [ana, claire] });
      const { user, session, queryClient } = rendered;
      const otherTab = anotherTab(queryClient);
      const anasOlderPage = aGate();
      const requests = serveTimeline(async (cursor) => {
        if (session.current === claire) return json(timelinePage([clairesEvent]));
        if (cursor === null) return json(timelinePage([anasEvent], 'anas-cursor'));
        await anasOlderPage.pass();
        return json(timelinePage([voyageCreated(1)]));
      });

      expect(await timelineText()).toEqual([expect.stringMatching(/^Issued a notice/)]);
      await user.click(screen.getByRole('button', { name: 'Load more' }));
      await anasOlderPage.received;

      await anotherTabSignsInAs(otherTab, rendered, claire);
      expect(await timelineText()).toEqual([
        expect.stringMatching(/^Acknowledged receipt of a notice.*Claire Morel/),
      ]);
      expect(requests[1]?.signal.aborted).toBe(true);

      anasOlderPage.release();
      await new Promise((resolve) => setTimeout(resolve, 50));

      expect(await timelineText()).toEqual([
        expect.stringMatching(/^Acknowledged receipt of a notice.*Claire Morel/),
      ]);
      expect(screen.queryByText(/Created the voyage/)).not.toBeInTheDocument();
      expect(screen.queryByText(/Issued a notice/)).not.toBeInTheDocument();
      // Claire's timeline was asked from its first page, never with Ana's cursor.
      expect(requests.map(({ cursor }) => cursor)).toEqual([null, 'anas-cursor', null]);
      for (const query of protectedQueries(queryClient)) {
        expect(query.queryKey[1]).toBe(scopeOf(claire));
      }
      const [timeline] = queryClient.getQueryCache().findAll({
        queryKey: ['protected', scopeOf(claire), 'voyages', 'detail', voyage.id, 'timeline'],
      });
      expect(timeline?.state.data).toEqual({
        pages: [timelinePage([clairesEvent])],
        pageParams: [undefined],
      });
    });

    it('drops the timeline when a 401 ends the session, and asks to sign in', async () => {
      servePage();
      const { router } = renderRoute(page);
      serveTimeline(() => problemResponse(401, 'Authentication is required.'));

      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
    });
  });
});
