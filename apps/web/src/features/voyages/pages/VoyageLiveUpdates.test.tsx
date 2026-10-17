import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import type { Notice, TimelineEvent, VoyageDetail } from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../../test/fixtures/auth';
import {
  aCounterpartyContract,
  acknowledged,
  aNotice,
  claire as claireActor,
  contractList,
} from '../../../test/fixtures/notices';
import {
  eventBase,
  noticeIssued,
  timelineContract1,
  timelinePage,
} from '../../../test/fixtures/timeline';
import { aTradeString, aVoyageDetail } from '../../../test/fixtures/voyages';
import { FakeEventSource } from '../../../test/fake-event-source';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { endSession, startSession } from '../../auth/session';
import { FALLBACK_POLL_INTERVAL_MS, RECONNECT_DELAYS_MS } from '../hooks/use-voyage-live-updates';

/*
 * Live updates on the voyage page, through the real route tree, providers and query client.
 * The network is MSW; the event stream is `FakeEventSource`, a simulated transport the tests
 * drive by hand. Nothing here involves a real EventSource or the browser's cookies: the API's
 * integration tests stream over real HTTP, and the end-to-end suite (`e2e/`) in real Chromium.
 */

const voyage = aVoyageDetail();
const page = `/voyages/${voyage.id}`;
const otherVoyage: VoyageDetail = {
  ...aVoyageDetail(),
  id: '01990000-0000-7000-8003-000000000099',
  reference: 'TF-2026-0099',
};

/** Ana operates for Cerrado, the seller under contract 1; Claire for Lacustra, its buyer. */
const ana = aCurrentUser();
const claire = anotherUser();
const asBuyer = aCounterpartyContract({ side: 'BUYER' });

type Endpoint =
  | 'voyage'
  | 'trade-string'
  | 'my-contracts'
  | 'notices'
  | 'documentary-instructions'
  | 'documents'
  | 'timeline';

/**
 * Serves the details page of `detail`. `state` is the fake server's data: a test changes it as
 * another user's command would, and every request answers what it holds then. Counts requests
 * per endpoint.
 */
function servePage(detail: VoyageDetail = voyage) {
  const state = { notices: [] as Notice[], events: [] as TimelineEvent[] };
  const requests: Record<Endpoint, number> = {
    voyage: 0,
    'trade-string': 0,
    'my-contracts': 0,
    notices: 0,
    'documentary-instructions': 0,
    documents: 0,
    timeline: 0,
  };
  const base = `*/api/voyages/${detail.id}`;
  const counted = (endpoint: Endpoint, respond: () => Response) => () => {
    requests[endpoint] += 1;
    return respond();
  };
  server.use(
    http.get(
      base,
      counted('voyage', () => HttpResponse.json(detail)),
    ),
    http.get(
      `${base}/trade-string`,
      counted('trade-string', () => HttpResponse.json(aTradeString())),
    ),
    http.get(
      `${base}/my-contracts`,
      counted('my-contracts', () => HttpResponse.json(contractList(asBuyer))),
    ),
    http.get(
      `${base}/notices`,
      counted('notices', () => HttpResponse.json({ items: state.notices })),
    ),
    http.get(
      `${base}/documentary-instructions`,
      counted('documentary-instructions', () => HttpResponse.json({ items: [] })),
    ),
    http.get(
      `${base}/documents`,
      counted('documents', () => HttpResponse.json({ items: [] })),
    ),
    http.get(
      `${base}/timeline`,
      counted('timeline', () => HttpResponse.json(timelinePage(state.events))),
    ),
  );
  return { state, requests };
}

type Requests = ReturnType<typeof servePage>['requests'];

const eventsPath = (voyageId: string) => `/api/voyages/${voyageId}/events`;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The page's one open stream, once it has connected. */
async function theStream(voyageId = voyage.id) {
  await waitFor(() => {
    expect(FakeEventSource.open()).toHaveLength(1);
  });
  const [source] = FakeEventSource.open();
  if (!source) throw new Error('No stream');
  expect(source.path).toBe(eventsPath(voyageId));
  return source;
}

/** Waits until the page has loaded once: every endpoint asked exactly once. */
async function loaded(requests: Requests) {
  await waitFor(() => {
    expect(requests).toEqual({
      voyage: 1,
      'trade-string': 1,
      'my-contracts': 1,
      notices: 1,
      'documentary-instructions': 1,
      documents: 1,
      timeline: 1,
    });
  });
}

/** Lets anything a late callback could have started reach the (fake) server. */
const quietly = async () => {
  await act(() => sleep(50));
};

const credentialsOf = (identity: typeof ana) => ({
  email: identity.user.email,
  password: TEST_PASSWORD,
});

beforeEach(() => {
  FakeEventSource.reset();
  vi.stubGlobal('EventSource', FakeEventSource);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  focusManager.setFocused(undefined);
});

describe('Live updates on the voyage page', () => {
  it('connects to the voyage’s stream only once the voyage has loaded', async () => {
    servePage();
    let releaseVoyage: () => void = () => undefined;
    const voyageHeld = new Promise<void>((resolve) => {
      releaseVoyage = resolve;
    });
    server.use(
      http.get(`*/api/voyages/${voyage.id}`, async () => {
        await voyageHeld;
        return HttpResponse.json(voyage);
      }),
    );
    renderRoute(page, { signedInAs: claire });

    await screen.findByLabelText('Loading voyage');
    expect(FakeEventSource.instances).toHaveLength(0);
    releaseVoyage();

    await theStream();
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('never connects for a voyage it cannot see', async () => {
    servePage();
    server.use(
      http.get(`*/api/voyages/${voyage.id}`, () => problemResponse(404, 'Voyage was not found.')),
    );
    renderRoute(page, { signedInAs: claire });

    expect(await screen.findByText('Voyage not found')).toBeInTheDocument();
    await quietly();
    expect(FakeEventSource.instances).toHaveLength(0);
  });

  it('reads the notices and the timeline again on READY, and nothing else', async () => {
    const { requests } = servePage();
    renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);

    act(() => {
      source.emit({ type: 'READY' });
    });

    await waitFor(() => {
      expect(requests.notices).toBe(2);
      expect(requests.timeline).toBe(2);
    });
    await quietly();
    expect(requests).toMatchObject({
      voyage: 1,
      'trade-string': 1,
      'my-contracts': 1,
      'documentary-instructions': 1,
      documents: 1,
      notices: 2,
      timeline: 2,
    });
  });

  it('reads again on READY even while the first reads are still on their way', async () => {
    // The first reads were sent before the stream listened, so their answers may predate a
    // change nobody will signal: READY must send reads of its own, not wait for those.
    const { state, requests } = servePage();
    const releases: (() => void)[] = [];
    const held = (endpoint: 'notices' | 'timeline', respond: () => Response) => async () => {
      requests[endpoint] += 1;
      if (requests[endpoint] === 1) {
        await new Promise<void>((resolve) => {
          releases.push(resolve);
        });
      }
      return respond();
    };
    server.use(
      http.get(
        `*/api/voyages/${voyage.id}/notices`,
        held('notices', () => HttpResponse.json({ items: state.notices })),
      ),
      http.get(
        `*/api/voyages/${voyage.id}/timeline`,
        held('timeline', () => HttpResponse.json(timelinePage(state.events))),
      ),
    );
    renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await waitFor(() => {
      expect(releases).toHaveLength(2);
    });

    // Committed after the first reads were answered from the database, before READY.
    state.notices = [aNotice({ contract: asBuyer })];
    state.events = [noticeIssued(2)];
    act(() => {
      source.emit({ type: 'READY' });
    });

    await waitFor(() => {
      expect(requests.notices).toBe(2);
      expect(requests.timeline).toBe(2);
    });
    releases.forEach((release) => {
      release();
    });
    const notices = await screen.findByRole('list', { name: 'Notices' });
    expect(within(notices).getAllByRole('listitem')).toHaveLength(1);
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText('Issued a notice')).toBeInTheDocument();
  });

  it("shows the buyer the seller's new notice, then its acknowledgement, as they are signalled", async () => {
    const { state, requests } = servePage();
    renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    act(() => {
      source.emit({ type: 'READY' });
    });
    expect(await screen.findByText('No notices under your contracts yet.')).toBeInTheDocument();
    await waitFor(() => {
      expect(requests.timeline).toBe(2);
    });

    // Ana issues a notice elsewhere; the server signals it.
    const notice = aNotice({ contract: asBuyer });
    state.notices = [notice];
    state.events = [noticeIssued(2)];
    act(() => {
      source.emit({ type: 'NOTICE_ISSUED' });
    });

    const notices = await screen.findByRole('list', { name: 'Notices' });
    expect(within(notices).getAllByRole('listitem')).toHaveLength(1);
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText('Issued a notice')).toBeInTheDocument();

    // A colleague of Claire's acknowledges it in another browser.
    state.notices = [acknowledged(notice, claireActor, '2030-10-16T09:00:00.000Z')];
    state.events = [
      {
        ...eventBase(3, undefined, claireActor),
        action: 'NOTICE_ACKNOWLEDGED',
        contract: timelineContract1,
        noticeId: notice.id,
      },
      noticeIssued(2),
    ];
    act(() => {
      source.emit({ type: 'NOTICE_ACKNOWLEDGED' });
    });

    expect(
      await within(timeline).findByText('Acknowledged receipt of a notice'),
    ).toBeInTheDocument();
    expect(within(notices).getByText(/by Claire Morel/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Acknowledge receipt/ })).not.toBeInTheDocument();
  });

  it("invalidates only this identity's notices and timeline", async () => {
    const { requests } = servePage();
    const { queryClient } = renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);
    // Data cached for someone else, for the same voyage.
    const anasNotices = [
      'protected',
      `${ana.user.id}:${ana.organization.id}`,
      'voyages',
      'detail',
      voyage.id,
      'notices',
    ];
    queryClient.setQueryData(anasNotices, { items: [] });

    act(() => {
      source.emit({ type: 'NOTICE_ISSUED' });
    });
    await waitFor(() => {
      expect(requests.notices).toBe(2);
    });

    expect(queryClient.getQueryState(anasNotices)?.isInvalidated).toBe(false);
    const claireScope = ['protected', `${claire.user.id}:${claire.organization.id}`];
    const invalidated = queryClient
      .getQueryCache()
      .findAll({ queryKey: claireScope })
      .filter((query) => query.state.isInvalidated || query.state.dataUpdateCount > 1)
      .map((query) => query.queryKey.at(-1));
    expect(invalidated.sort()).toEqual(['notices', 'timeline']);
  });

  it('ignores messages it does not understand', async () => {
    const { requests } = servePage();
    renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);

    act(() => {
      source.emit('not json');
      source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
      source.emit({ noticeId: aNotice().id });
    });
    await quietly();

    expect(requests.notices).toBe(1);
    expect(requests.timeline).toBe(1);
  });

  it('refreshes once more, not once per signal, when signals arrive during a refresh', async () => {
    const { requests } = servePage();
    let release: () => void = () => undefined;
    let held = 0;
    server.use(
      http.get(`*/api/voyages/${voyage.id}/notices`, async () => {
        requests.notices += 1;
        if (requests.notices === 2) {
          held += 1;
          await new Promise<void>((resolve) => {
            release = resolve;
          });
        }
        return HttpResponse.json({ items: [] });
      }),
    );
    renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);

    act(() => {
      source.emit({ type: 'NOTICE_ISSUED' });
    });
    await waitFor(() => {
      expect(held).toBe(1);
    });
    act(() => {
      for (let i = 0; i < 20; i += 1) source.emit({ type: 'NOTICE_ACKNOWLEDGED' });
    });
    release();

    await waitFor(() => {
      expect(requests.notices).toBe(3);
    });
    await quietly();
    expect(requests.notices).toBe(3);
  });
});

describe('Reconnecting and polling', () => {
  it('reads again after the browser reconnects, and polls while it is away', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { requests } = servePage();
    renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);
    act(() => {
      source.emit({ type: 'READY' });
    });
    await waitFor(() => {
      expect(requests.notices).toBe(2);
    });

    // Live: no polling.
    await act(() => vi.advanceTimersByTimeAsync(2 * FALLBACK_POLL_INTERVAL_MS));
    expect(requests.notices).toBe(2);
    expect(requests.timeline).toBe(2);

    // The connection drops; the browser reconnects by itself. Meanwhile, the page polls.
    act(() => {
      source.drop();
    });
    await act(() => vi.advanceTimersByTimeAsync(FALLBACK_POLL_INTERVAL_MS));
    await waitFor(() => {
      expect(requests.notices).toBe(3);
      expect(requests.timeline).toBe(3);
    });

    // Back: whatever changed while away is read through REST, and polling stops.
    act(() => {
      source.emit({ type: 'READY' });
    });
    await waitFor(() => {
      expect(requests.notices).toBe(4);
      expect(requests.timeline).toBe(4);
    });
    await act(() => vi.advanceTimersByTimeAsync(2 * FALLBACK_POLL_INTERVAL_MS));
    expect(requests.notices).toBe(4);
    // Nothing else was ever refetched.
    expect(requests.documents).toBe(1);
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('polls until the stream is ready, and not while the page is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { requests } = servePage();
    renderRoute(page, { signedInAs: claire });
    await theStream();
    await loaded(requests);

    await act(() => vi.advanceTimersByTimeAsync(FALLBACK_POLL_INTERVAL_MS));
    await waitFor(() => {
      expect(requests.notices).toBe(2);
      expect(requests.timeline).toBe(2);
    });

    act(() => {
      focusManager.setFocused(false);
    });
    await act(() => vi.advanceTimersByTimeAsync(3 * FALLBACK_POLL_INTERVAL_MS));
    expect(requests.notices).toBe(2);
    expect(requests.timeline).toBe(2);
  });

  it('opens a new stream after the browser gives up, waiting longer each time', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { requests } = servePage();
    renderRoute(page, { signedInAs: claire });
    const first = await theStream();
    await loaded(requests);

    act(() => {
      first.fail();
    });
    expect(FakeEventSource.open()).toHaveLength(0);
    await act(() => vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[0] - 100));
    expect(FakeEventSource.instances).toHaveLength(1);
    await act(() => vi.advanceTimersByTimeAsync(200));
    const second = await theStream();
    expect(second).not.toBe(first);

    act(() => {
      second.fail();
    });
    await act(() => vi.advanceTimersByTimeAsync(RECONNECT_DELAYS_MS[1] - 100));
    expect(FakeEventSource.instances).toHaveLength(2);
    await act(() => vi.advanceTimersByTimeAsync(200));
    const third = await theStream();

    // Connected again: it reads what it missed.
    const before = requests.notices;
    act(() => {
      third.emit({ type: 'READY' });
    });
    await waitFor(() => {
      expect(requests.notices).toBe(before + 1);
    });
    // A late error from a source given up on starts nothing.
    act(() => {
      first.fail();
    });
    await act(() => vi.advanceTimersByTimeAsync(2 * (RECONNECT_DELAYS_MS.at(-1) ?? 0)));
    expect(FakeEventSource.instances).toHaveLength(3);
  });
});

describe('The stream belongs to the voyage and the session it was opened for', () => {
  it('closes when the page goes away, and moves with the voyage shown', async () => {
    servePage();
    const other = servePage(otherVoyage);
    const { router } = renderRoute(page, { signedInAs: claire });
    const first = await theStream();

    await act(() => router.navigate(`/voyages/${otherVoyage.id}`));
    const second = await theStream(otherVoyage.id);
    expect(first.readyState).toBe(FakeEventSource.CLOSED);
    await loaded(other.requests);

    await act(() => router.navigate('/nowhere'));
    expect(await screen.findByText(/not found/i)).toBeInTheDocument();
    expect(second.readyState).toBe(FakeEventSource.CLOSED);
    expect(FakeEventSource.open()).toHaveLength(0);
  });

  it('closes on sign-out, and a late event refreshes nothing', async () => {
    const { requests } = servePage();
    const { queryClient } = renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);

    await act(() => endSession(queryClient).signedOutLocally);

    expect(source.readyState).toBe(FakeEventSource.CLOSED);
    act(() => {
      source.emit({ type: 'NOTICE_ISSUED' });
    });
    await quietly();
    expect(requests.notices).toBe(1);
    expect(
      await screen.findByRole('heading', { name: 'Sign in to TradeFlow' }),
    ).toBeInTheDocument();
  });

  it('opens a new stream when the same user signs back in, and ignores the old one', async () => {
    const { requests } = servePage();
    const { queryClient } = renderRoute(page, { signedInAs: claire });
    const before = await theStream();
    await loaded(requests);

    await act(() => endSession(queryClient).settled);
    expect(before.readyState).toBe(FakeEventSource.CLOSED);
    await act(() => startSession(queryClient, credentialsOf(claire)));
    const after = await theStream();
    expect(after).not.toBe(before);
    await quietly();
    const settled = requests.notices;

    // The old stream speaks for the session that was signed out, though it was Claire's too.
    act(() => {
      before.emit({ type: 'READY' });
      before.emit({ type: 'NOTICE_ISSUED' });
    });
    await quietly();
    expect(requests.notices).toBe(settled);

    act(() => {
      after.emit({ type: 'NOTICE_ISSUED' });
    });
    await waitFor(() => {
      expect(requests.notices).toBe(settled + 1);
    });
  });

  it('ignores the first stream after session checks went to someone else and back', async () => {
    const { requests } = servePage();
    const { queryClient, session } = renderRoute(page, {
      signedInAs: claire,
      accounts: [claire, ana],
    });
    const claires = await theStream();
    await loaded(requests);
    const checkSession = () => act(() => queryClient.refetchQueries({ queryKey: ['session'] }));

    // The cookie changed behind this tab's back, twice, with no notification.
    session.current = ana;
    await checkSession();
    const anas = await theStream();
    expect(claires.readyState).toBe(FakeEventSource.CLOSED);
    session.current = claire;
    await checkSession();
    const clairesAgain = await theStream();
    expect(anas.readyState).toBe(FakeEventSource.CLOSED);
    await waitFor(() => {
      expect(requests.notices).toBe(3);
    });

    // Claire's first stream speaks for a session that has ended, though she is back.
    act(() => {
      claires.emit({ type: 'NOTICE_ISSUED' });
      anas.emit({ type: 'NOTICE_ISSUED' });
    });
    await quietly();
    expect(requests.notices).toBe(3);

    act(() => {
      clairesAgain.emit({ type: 'NOTICE_ISSUED' });
    });
    await waitFor(() => {
      expect(requests.notices).toBe(4);
    });
    expect(FakeEventSource.open()).toEqual([clairesAgain]);
  });
});
