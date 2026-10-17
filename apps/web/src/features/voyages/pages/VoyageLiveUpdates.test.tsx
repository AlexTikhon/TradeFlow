import { focusManager } from '@tanstack/react-query';
import { act, screen, waitFor, within } from '@testing-library/react';
import type {
  ContractDocument,
  CounterpartyContract,
  DocumentaryInstruction,
  DocumentListResponse,
  DocumentReviewDecision,
  Notice,
  TimelineEvent,
  VoyageDetail,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../../test/fixtures/auth';
import {
  acknowledgedRevision,
  anInstruction,
  aRevision,
} from '../../../test/fixtures/documentary-instructions';
import {
  aDocument,
  aDocumentVersion,
  brunoUploads,
  davidReviews,
  replacedBy,
  reviewedAs,
} from '../../../test/fixtures/documents';
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
const asSeller = aCounterpartyContract();
const asBuyer = aCounterpartyContract({ side: 'BUYER' });

/** Instructions under contract 1 as Claire's organization, its buyer, sees them. */
const buyersView = (instruction: DocumentaryInstruction): DocumentaryInstruction => ({
  ...instruction,
  contract: asBuyer,
});

/** Revision 2, given by Lea, Claire's colleague, on top of `base`. */
const revisedByColleague = (base: DocumentaryInstruction) =>
  buyersView({
    ...base,
    version: base.version + 1,
    currentRevision: aRevision({
      number: base.currentRevision.number + 1,
      consignee: 'To order of Another Bank AG',
      createdBy: { name: 'Lea Brunner', organization: claire.organization },
      createdAt: '2030-10-17T09:00:00.000Z',
    }),
    previousRevisions: [base.currentRevision, ...base.previousRevisions],
  });

const instructionEvent = (revisionNumber: number, version: number) => ({
  contract: timelineContract1,
  instructionId: anInstruction().id,
  revisionNumber,
  version,
});
/** Revision `revisionNumber`, given by Claire's side. */
const instructionRevised = (n: number, revisionNumber: number, version = 1): TimelineEvent => ({
  ...eventBase(n, undefined, claireActor),
  ...instructionEvent(revisionNumber, version),
  action: 'DOCUMENTARY_INSTRUCTION_REVISED',
});
/** Revision `revisionNumber`, acknowledged by Ana for the seller. */
const instructionAcknowledged = (
  n: number,
  revisionNumber: number,
  version: number,
): TimelineEvent => ({
  ...eventBase(n),
  ...instructionEvent(revisionNumber, version),
  action: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
});

const contractName = 'Contract 1 · Cerrado Grãos Exportadora S.A. → Lacustra Commodities SA';

/** The documentary instructions under contract 1. */
const instructionPanel = async () =>
  within(await screen.findByRole('listitem', { name: contractName }));

/** The bill of lading under contract 1's current revision, with its upload or review form. */
const billOfLading = async () =>
  within(await (await instructionPanel()).findByRole('listitem', { name: 'Bill of lading' }));

/** `document` as Claire's organization, the buyer under contract 1, sees it. */
const buyersDocument = (document: ContractDocument): ContractDocument => ({
  ...document,
  contract: asBuyer,
});

const documentEvent = (versionNumber: number) => ({
  contract: timelineContract1,
  documentId: aDocument().id,
  revisionNumber: 1,
  documentType: 'BILL_OF_LADING' as const,
  versionNumber,
});
/** File version `versionNumber` of the bill of lading, uploaded by Ana for the seller. */
const documentUploaded = (n: number, versionNumber: number, version = versionNumber) =>
  ({
    ...eventBase(n),
    ...documentEvent(versionNumber),
    action: 'DOCUMENT_VERSION_UPLOADED',
    version,
  }) satisfies TimelineEvent;
/** File version `versionNumber` of the bill of lading, decided on by Claire's side. */
const documentReviewed = (
  n: number,
  versionNumber: number,
  version: number,
  decision: DocumentReviewDecision,
) =>
  ({
    ...eventBase(n, undefined, claireActor),
    ...documentEvent(versionNumber),
    action: 'DOCUMENT_VERSION_REVIEWED',
    decision,
    version,
  }) satisfies TimelineEvent;

const REASON = 'The consignee does not match the instructions.';

type Endpoint =
  | 'voyage'
  | 'trade-string'
  | 'my-contracts'
  | 'notices'
  | 'documentary-instructions'
  | 'documents'
  | 'timeline';

/**
 * Serves the details page of `detail`, from `contract`'s side (the buyer's unless stated).
 * `state` is the fake server's data: a test changes it as another user's command would, and
 * every request answers what it holds then. Counts requests per endpoint.
 */
function servePage(detail: VoyageDetail = voyage, contract: CounterpartyContract = asBuyer) {
  const state = {
    notices: [] as Notice[],
    instructions: [] as DocumentaryInstruction[],
    documents: [] as ContractDocument[],
    events: [] as TimelineEvent[],
  };
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
      counted('my-contracts', () => HttpResponse.json(contractList(contract))),
    ),
    http.get(
      `${base}/notices`,
      counted('notices', () => HttpResponse.json({ items: state.notices })),
    ),
    http.get(
      `${base}/documentary-instructions`,
      counted('documentary-instructions', () => HttpResponse.json({ items: state.instructions })),
    ),
    http.get(
      `${base}/documents`,
      counted('documents', () => HttpResponse.json({ items: state.documents })),
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

  it('reads the notices, the instructions, the documents and the timeline again on READY, and nothing else', async () => {
    const { requests } = servePage();
    renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);

    act(() => {
      source.emit({ type: 'READY' });
    });

    await waitFor(() => {
      expect(requests.notices).toBe(2);
      expect(requests['documentary-instructions']).toBe(2);
      expect(requests.documents).toBe(2);
      expect(requests.timeline).toBe(2);
    });
    await quietly();
    expect(requests).toEqual({
      voyage: 1,
      'trade-string': 1,
      'my-contracts': 1,
      'documentary-instructions': 2,
      documents: 2,
      notices: 2,
      timeline: 2,
    });
  });

  it('reads again on READY even while the first reads are still on their way', async () => {
    // The first reads were sent before the stream listened, so their answers may predate a
    // change nobody will signal: READY must send reads of its own, not wait for those.
    const { state, requests } = servePage();
    const releases: (() => void)[] = [];
    const held =
      (
        endpoint: 'notices' | 'documentary-instructions' | 'documents' | 'timeline',
        respond: () => Response,
      ) =>
      async () => {
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
        `*/api/voyages/${voyage.id}/documentary-instructions`,
        held('documentary-instructions', () => HttpResponse.json({ items: state.instructions })),
      ),
      http.get(
        `*/api/voyages/${voyage.id}/documents`,
        held('documents', () => HttpResponse.json({ items: state.documents })),
      ),
      http.get(
        `*/api/voyages/${voyage.id}/timeline`,
        held('timeline', () => HttpResponse.json(timelinePage(state.events))),
      ),
    );
    renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await waitFor(() => {
      expect(releases).toHaveLength(4);
    });
    expect(screen.getByLabelText('Loading documentary instructions')).toBeInTheDocument();

    // Committed after the first reads were answered from the database, before READY.
    state.notices = [aNotice({ contract: asBuyer })];
    state.instructions = [buyersView(anInstruction())];
    state.documents = [buyersDocument(aDocument())];
    state.events = [documentUploaded(4, 1), instructionRevised(3, 1), noticeIssued(2)];
    act(() => {
      source.emit({ type: 'READY' });
    });

    await waitFor(() => {
      expect(requests.notices).toBe(2);
      expect(requests['documentary-instructions']).toBe(2);
      expect(requests.documents).toBe(2);
      expect(requests.timeline).toBe(2);
    });
    releases.forEach((release) => {
      release();
    });
    const notices = await screen.findByRole('list', { name: 'Notices' });
    expect(within(notices).getAllByRole('listitem')).toHaveLength(1);
    const panel = await instructionPanel();
    expect(await panel.findByRole('region', { name: 'Revision 1' })).toBeVisible();
    expect(await (await billOfLading()).findByText('Pending review')).toBeVisible();
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(within(timeline).getByText('Issued a notice')).toBeInTheDocument();
    expect(within(timeline).getByText('Gave documentary instructions')).toBeInTheDocument();
    expect(
      within(timeline).getByText(
        'Uploaded version 1 of the bill of lading (instructions revision 1)',
      ),
    ).toBeInTheDocument();
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
      source.emit({ type: 'DOCUMENT_DELETED' });
      source.emit({ noticeId: aNotice().id });
    });
    await quietly();

    expect(requests.notices).toBe(1);
    expect(requests.documents).toBe(1);
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

/** The query key of the voyage's documentary instructions for `identity`. */
const diKey = (identity: typeof ana) => [
  'protected',
  `${identity.user.id}:${identity.organization.id}`,
  'voyages',
  'detail',
  voyage.id,
  'documentary-instructions',
];

/** Renders the page for `identity` (Claire unless stated), connected, past READY and its reads. */
async function liveFor(served: ReturnType<typeof servePage>, identity = claire) {
  const rendered = renderRoute(page, { signedInAs: identity });
  const source = await theStream();
  await loaded(served.requests);
  act(() => {
    source.emit({ type: 'READY' });
  });
  await waitFor(() => {
    expect(served.requests).toMatchObject({
      notices: 2,
      'documentary-instructions': 2,
      documents: 2,
      timeline: 2,
    });
  });
  await quietly();
  return { ...rendered, source };
}

describe('Documentary instructions over the stream', () => {
  it('reads each signal’s own resource and the timeline, and nothing else', async () => {
    const served = servePage();
    const { source } = await liveFor(served);

    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
    });
    await waitFor(() => {
      expect(served.requests['documentary-instructions']).toBe(3);
      expect(served.requests.timeline).toBe(3);
    });
    await quietly();
    expect(served.requests.notices).toBe(2);

    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
    });
    await waitFor(() => {
      expect(served.requests['documentary-instructions']).toBe(4);
      expect(served.requests.timeline).toBe(4);
    });

    act(() => {
      source.emit({ type: 'NOTICE_ISSUED' });
    });
    await waitFor(() => {
      expect(served.requests.notices).toBe(3);
      expect(served.requests.timeline).toBe(5);
    });
    await quietly();
    expect(served.requests).toEqual({
      voyage: 1,
      'trade-string': 1,
      'my-contracts': 1,
      notices: 3,
      'documentary-instructions': 4,
      documents: 2,
      timeline: 5,
    });
  });

  it("shows the buyer a colleague's revision, then the seller's acknowledgement, as they are signalled", async () => {
    const served = servePage();
    const first = buyersView(anInstruction());
    served.state.instructions = [first];
    served.state.events = [instructionRevised(2, 1)];
    const { source } = await liveFor(served);
    const panel = await instructionPanel();
    expect(panel.getByRole('region', { name: 'Revision 1' })).toBeVisible();

    // Lea, Claire's colleague, revises elsewhere; the server signals it.
    const second = revisedByColleague(first);
    served.state.instructions = [second];
    served.state.events = [instructionRevised(3, 2, 2), instructionRevised(2, 1)];
    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
    });
    const revision = await panel.findByRole('region', { name: 'Revision 2' });
    expect(revision).toHaveTextContent('To order of Another Bank AG');
    expect(revision).toHaveTextContent('Not acknowledged');
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(
      await within(timeline).findByText('Revised the documentary instructions (revision 2)'),
    ).toBeInTheDocument();

    // Ana acknowledges revision 2 for the seller.
    served.state.instructions = [
      { ...second, version: 3, currentRevision: acknowledgedRevision(second.currentRevision) },
    ];
    served.state.events = [instructionAcknowledged(4, 2, 3), ...served.state.events];
    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
    });
    await waitFor(() => {
      expect(panel.getByRole('region', { name: 'Revision 2' })).toHaveTextContent(
        'Acknowledged by the seller',
      );
    });
    expect(
      await within(timeline).findByText('Acknowledged revision 2 of the documentary instructions'),
    ).toBeInTheDocument();
  });

  it('reads every resource that mixed signals asked for during a refresh, once each', async () => {
    const served = servePage();
    const { requests, state } = served;
    const holding = new Set<'notices' | 'documentary-instructions'>();
    const releases = new Map<string, () => void>();
    const holdable =
      (endpoint: 'notices' | 'documentary-instructions', respond: () => Response) => async () => {
        requests[endpoint] += 1;
        if (holding.delete(endpoint)) {
          await new Promise<void>((resolve) => releases.set(endpoint, resolve));
        }
        return respond();
      };
    server.use(
      http.get(
        `*/api/voyages/${voyage.id}/notices`,
        holdable('notices', () => HttpResponse.json({ items: state.notices })),
      ),
      http.get(
        `*/api/voyages/${voyage.id}/documentary-instructions`,
        holdable('documentary-instructions', () =>
          HttpResponse.json({ items: state.instructions }),
        ),
      ),
    );
    const { source } = await liveFor(served);
    const release = (endpoint: string) => {
      const resolve = releases.get(endpoint);
      releases.delete(endpoint);
      resolve?.();
    };

    // A notice refresh is held; instruction and notice signals pile up meanwhile.
    holding.add('notices');
    act(() => {
      source.emit({ type: 'NOTICE_ISSUED' });
    });
    await waitFor(() => {
      expect(releases.has('notices')).toBe(true);
    });
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        source.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
        source.emit({ type: 'NOTICE_ACKNOWLEDGED' });
        source.emit({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
      }
    });
    await quietly();
    // Nothing more while one refresh runs.
    expect(requests).toMatchObject({ notices: 3, 'documentary-instructions': 2, timeline: 3 });
    act(() => {
      release('notices');
    });
    // One more refresh, with reads sent after the signals: each resource once.
    await waitFor(() => {
      expect(requests).toMatchObject({ notices: 4, 'documentary-instructions': 3, timeline: 4 });
    });
    await quietly();
    expect(requests).toMatchObject({ notices: 4, 'documentary-instructions': 3, timeline: 4 });

    // The other way round: an instruction refresh is held, and a notice signal arrives.
    holding.add('documentary-instructions');
    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
    });
    await waitFor(() => {
      expect(releases.has('documentary-instructions')).toBe(true);
    });
    act(() => {
      source.emit({ type: 'NOTICE_ISSUED' });
    });
    await quietly();
    expect(requests).toMatchObject({ notices: 4, 'documentary-instructions': 4, timeline: 5 });
    act(() => {
      release('documentary-instructions');
    });
    await waitFor(() => {
      expect(requests).toMatchObject({ notices: 5, timeline: 6 });
    });
    await quietly();
    expect(requests).toMatchObject({ notices: 5, 'documentary-instructions': 4, timeline: 6 });
  });

  it("invalidates only this identity's instructions and timeline", async () => {
    const { requests } = servePage();
    const { queryClient } = renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);
    // Data cached for someone else, for the same voyage.
    queryClient.setQueryData(diKey(ana), { items: [] });

    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
    });
    await waitFor(() => {
      expect(requests['documentary-instructions']).toBe(2);
    });

    expect(queryClient.getQueryState(diKey(ana))?.isInvalidated).toBe(false);
    const claireScope = ['protected', `${claire.user.id}:${claire.organization.id}`];
    const invalidated = queryClient
      .getQueryCache()
      .findAll({ queryKey: claireScope })
      .filter((query) => query.state.isInvalidated || query.state.dataUpdateCount > 1)
      .map((query) => query.queryKey.at(-1));
    expect(invalidated.sort()).toEqual(['documentary-instructions', 'timeline']);
  });
});

describe('An open draft while revisions are pushed', () => {
  interface Put {
    body: unknown;
    ifMatch: string | null;
    ifNoneMatch: string | null;
  }

  /** Serves the PUT of contract 1's instructions with `respond`, recording what was sent. */
  function servePut(respond: () => Promise<Response> | Response) {
    const sent: Put[] = [];
    server.use(
      http.put(
        `*/api/voyages/${voyage.id}/contracts/${asBuyer.id}/documentary-instructions`,
        async ({ request }) => {
          sent.push({
            body: await request.json(),
            ifMatch: request.headers.get('if-match'),
            ifNoneMatch: request.headers.get('if-none-match'),
          });
          return respond();
        },
      ),
    );
    return sent;
  }

  async function openDraft(user: ReturnType<typeof renderRoute>['user']) {
    const panel = await instructionPanel();
    await user.click(await panel.findByRole('button', { name: 'Revise instructions' }));
    const form = within(panel.getByRole('form', { name: 'Revise documentary instructions' }));
    await user.clear(form.getByLabelText(/Consignee/));
    await user.type(form.getByLabelText(/Consignee/), 'To order of My Bank');
    return form;
  }

  it('keeps the draft and its version, and sends nothing until the user chooses', async () => {
    const { state, requests } = servePage();
    const first = buyersView(anInstruction());
    state.instructions = [first];
    const sent = servePut(() => {
      const [current] = state.instructions;
      if (!current) throw new Error('No instructions to revise');
      const mine = buyersView({
        ...current,
        version: 4,
        currentRevision: aRevision({ number: 3, consignee: 'To order of My Bank' }),
        previousRevisions: [current.currentRevision, ...current.previousRevisions],
      });
      state.instructions = [mine];
      return HttpResponse.json(mine, { headers: { ETag: '"4"' } });
    });
    const { user } = renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    act(() => {
      source.emit({ type: 'READY' });
    });
    const form = await openDraft(user);
    const before = requests['documentary-instructions'];

    // Lea's revision 2 is pushed while Claire's draft, based on revision 1, is open.
    const theirs = revisedByColleague(first);
    state.instructions = [theirs];
    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
    });
    const latest = within(await form.findByRole('region', { name: 'Latest version' }));
    expect(latest.getByText(/Revision 2 was given by Lea Brunner/)).toBeVisible();
    expect(latest.getByText('To order of Another Bank AG')).toBeVisible();
    expect(form.getByLabelText(/Consignee/)).toHaveValue('To order of My Bank');
    expect(form.getByRole('button', { name: 'Send revision 2' })).toBeDisabled();

    // Then the seller acknowledges it: still Claire's draft, still based on revision 1.
    state.instructions = [
      { ...theirs, version: 3, currentRevision: acknowledgedRevision(theirs.currentRevision) },
    ];
    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
    });
    await waitFor(() => {
      expect(latest.getByText('Acknowledged by the seller')).toBeVisible();
    });
    expect(requests['documentary-instructions']).toBe(before + 2);
    expect(form.getByLabelText(/Consignee/)).toHaveValue('To order of My Bank');
    expect(form.getByRole('button', { name: 'Send revision 2' })).toBeDisabled();
    await quietly();
    // Nothing was sent, rebased or retried behind the user's back.
    expect(sent).toEqual([]);

    // Only the user's choice bases the draft on the newer version, which is what is then sent.
    await user.click(latest.getByRole('button', { name: 'Base my draft on revision 2' }));
    expect(form.getByLabelText(/Consignee/)).toHaveValue('To order of My Bank');
    await user.click(form.getByRole('button', { name: 'Send revision 3' }));
    expect(
      await screen.findByText(
        'Revision 3 has been sent to Cerrado Grãos Exportadora S.A. for acknowledgement.',
      ),
    ).toBeVisible();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      ifMatch: '"3"',
      ifNoneMatch: null,
      body: { consignee: 'To order of My Bank' },
    });
  });

  it('shows no conflict when its own revision is signalled before the response', async () => {
    const { state, requests } = servePage();
    const first = buyersView(anInstruction());
    state.instructions = [first];
    const mine = buyersView({
      ...first,
      version: 2,
      currentRevision: aRevision({ number: 2, consignee: 'To order of My Bank' }),
      previousRevisions: [first.currentRevision],
    });
    let arrived: () => void = () => undefined;
    const received = new Promise<void>((resolve) => (arrived = resolve));
    let respond: () => void = () => undefined;
    const answered = new Promise<void>((resolve) => (respond = resolve));
    const sent = servePut(async () => {
      // Committed: the server signals it before this response reaches the browser.
      state.instructions = [mine];
      arrived();
      await answered;
      return HttpResponse.json(mine, { headers: { ETag: '"2"' } });
    });
    const { user, queryClient } = renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    act(() => {
      source.emit({ type: 'READY' });
    });
    const form = await openDraft(user);
    await user.click(form.getByRole('button', { name: 'Send revision 2' }));
    await received;

    const before = requests['documentary-instructions'];
    act(() => {
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<{ items: DocumentaryInstruction[] }>(diKey(claire))?.items[0]
          ?.version,
      ).toBe(2);
    });
    expect(requests['documentary-instructions']).toBe(before + 1);
    // The write is still on its way: its answer decides, not the refresh.
    expect(form.queryByRole('region', { name: 'Latest version' })).not.toBeInTheDocument();
    expect(form.getByLabelText(/Consignee/)).toHaveValue('To order of My Bank');

    respond();
    expect(
      await screen.findByText(
        'Revision 2 has been sent to Cerrado Grãos Exportadora S.A. for acknowledgement.',
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole('form', { name: 'Revise documentary instructions' }),
    ).not.toBeInTheDocument();
    expect(sent.map(({ ifMatch }) => ifMatch)).toEqual(['"1"']);
  });
});

/** The query key of the voyage's documents for `identity`. */
const documentsKey = (identity: typeof ana) => [
  'protected',
  `${identity.user.id}:${identity.organization.id}`,
  'voyages',
  'detail',
  voyage.id,
  'documents',
];

describe('Documents over the stream', () => {
  it('reads the documents and the timeline on each document signal, and nothing else', async () => {
    const served = servePage();
    const { source } = await liveFor(served);

    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
    });
    await waitFor(() => {
      expect(served.requests.documents).toBe(3);
      expect(served.requests.timeline).toBe(3);
    });
    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
    });
    await waitFor(() => {
      expect(served.requests.documents).toBe(4);
      expect(served.requests.timeline).toBe(4);
    });
    await quietly();
    expect(served.requests).toEqual({
      voyage: 1,
      'trade-string': 1,
      'my-contracts': 1,
      notices: 2,
      'documentary-instructions': 2,
      documents: 4,
      timeline: 4,
    });
  });

  it("shows the buyer the seller's file, a colleague's rejection and the replacement, keeping every version", async () => {
    const served = servePage();
    served.state.instructions = [buyersView(anInstruction())];
    const { source, user } = await liveFor(served);
    const item = await billOfLading();
    expect(item.getByText('Not uploaded yet')).toBeVisible();

    // Ana uploads version 1 for the seller; the server signals it.
    const first = buyersDocument(aDocument());
    served.state.documents = [first];
    served.state.events = [documentUploaded(2, 1)];
    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
    });
    expect(await item.findByText('Pending review')).toBeVisible();
    expect(item.getByText(/^Version 1: bill-of-lading\.pdf/)).toBeVisible();
    expect(item.getByRole('radio', { name: 'Approve' })).toBeInTheDocument();
    const timeline = await screen.findByRole('list', { name: 'Timeline' });
    expect(
      within(timeline).getByText(
        'Uploaded version 1 of the bill of lading (instructions revision 1)',
      ),
    ).toBeInTheDocument();

    // David, Claire's colleague, rejects it in another browser: nothing is left to decide.
    const rejected = reviewedAs(first, {
      decision: 'REJECTED',
      reason: REASON,
      reviewedBy: davidReviews,
    });
    served.state.documents = [rejected];
    served.state.events = [documentReviewed(3, 1, 2, 'REJECTED'), ...served.state.events];
    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
    });
    expect(await item.findByText('Rejected')).toBeVisible();
    expect(item.getByLabelText('Reason for rejecting version 1')).toHaveTextContent(REASON);
    expect(item.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
    expect(
      await within(timeline).findByText(
        'Rejected version 1 of the bill of lading (instructions revision 1)',
      ),
    ).toBeInTheDocument();

    // Ana replaces it: version 2 waits for a decision, version 1 keeps its rejection.
    served.state.documents = [replacedBy(rejected)];
    served.state.events = [documentUploaded(4, 2, 3), ...served.state.events];
    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
    });
    expect(await item.findByText('Pending review')).toBeVisible();
    expect(item.getByText(/^Version 2: bill-of-lading-v2\.pdf/)).toBeVisible();
    expect(item.getByRole('radio', { name: 'Approve' })).toBeInTheDocument();
    expect(
      await within(timeline).findByText(
        'Uploaded version 2 of the bill of lading (instructions revision 1)',
      ),
    ).toBeInTheDocument();
    await user.click(item.getByRole('button', { name: 'Earlier versions (1)' }));
    const earlier = within(
      item.getByRole('list', { name: 'Earlier versions of the bill of lading' }),
    );
    expect(earlier.getByText(/^Version 1: bill-of-lading\.pdf/)).toBeVisible();
    expect(earlier.getByText(/^Rejected by David Keller/)).toBeVisible();
    expect(earlier.getByLabelText('Reason for rejecting version 1')).toHaveTextContent(REASON);
  });

  it('reads every resource that mixed signals asked for during a documents refresh, once each', async () => {
    const served = servePage();
    const { requests, state } = served;
    let hold = false;
    let release: (() => void) | undefined;
    server.use(
      http.get(`*/api/voyages/${voyage.id}/documents`, async () => {
        requests.documents += 1;
        if (hold) {
          hold = false;
          await new Promise<void>((resolve) => (release = resolve));
        }
        return HttpResponse.json({ items: state.documents });
      }),
    );
    const { source } = await liveFor(served);

    // A documents refresh is held; signals of every kind pile up meanwhile.
    hold = true;
    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
    });
    await waitFor(() => {
      expect(release).toBeDefined();
    });
    act(() => {
      for (let i = 0; i < 5; i += 1) {
        source.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
        source.emit({ type: 'NOTICE_ISSUED' });
        source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
        source.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      }
    });
    await quietly();
    // Nothing more while one refresh runs.
    expect(requests).toMatchObject({
      notices: 2,
      'documentary-instructions': 2,
      documents: 3,
      timeline: 3,
    });
    act(() => {
      release?.();
    });
    // One more refresh, with reads sent after the signals: each resource once.
    const after = { notices: 3, 'documentary-instructions': 3, documents: 4, timeline: 4 };
    await waitFor(() => {
      expect(requests).toMatchObject(after);
    });
    await quietly();
    expect(requests).toMatchObject(after);
  });

  it("invalidates only this identity's documents and timeline", async () => {
    const { requests } = servePage();
    const { queryClient } = renderRoute(page, { signedInAs: claire });
    const source = await theStream();
    await loaded(requests);
    // Data cached for someone else, for the same voyage.
    queryClient.setQueryData(documentsKey(ana), { items: [] });

    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
    });
    await waitFor(() => {
      expect(requests.documents).toBe(2);
    });

    expect(queryClient.getQueryState(documentsKey(ana))?.isInvalidated).toBe(false);
    const claireScope = ['protected', `${claire.user.id}:${claire.organization.id}`];
    const invalidated = queryClient
      .getQueryCache()
      .findAll({ queryKey: claireScope })
      .filter((query) => query.state.isInvalidated || query.state.dataUpdateCount > 1)
      .map((query) => query.queryKey.at(-1));
    expect(invalidated.sort()).toEqual(['documents', 'timeline']);
  });
});

describe('An upload or a decision being made while documents are pushed', () => {
  const versionsPath = `*/api/voyages/${voyage.id}/contracts/${asSeller.id}/documentary-instructions/revisions/1/documents/BILL_OF_LADING/versions`;

  const aPdf = (name: string) =>
    new File([new TextEncoder().encode('%PDF-1.7\n')], name, { type: 'application/pdf' });

  /** Holds a response until `release()`; `received` once the request has arrived. */
  function aGate() {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let arrived: () => void = () => undefined;
    const received = new Promise<void>((resolve) => (arrived = resolve));
    return { gate, received, arrived, release };
  }

  /** Serves uploads of the bill of lading with `respond`, recording what each one carried. */
  function serveUploads(respond: () => Promise<Response> | Response) {
    const sent: { fileName: string; ifMatch: string | null; ifNoneMatch: string | null }[] = [];
    server.use(
      http.post(versionsPath, async ({ request }) => {
        const file = (await request.formData()).get('file');
        sent.push({
          fileName: file instanceof File ? file.name : '',
          ifMatch: request.headers.get('if-match'),
          ifNoneMatch: request.headers.get('if-none-match'),
        });
        return respond();
      }),
    );
    return sent;
  }

  /** Serves decisions on the bill of lading with `respond`, recording what each one carried. */
  function serveReviews(respond: () => Promise<Response> | Response) {
    const sent: { version: string; ifMatch: string | null; body: unknown }[] = [];
    server.use(
      http.post(`${versionsPath}/:version/review`, async ({ request, params }) => {
        sent.push({
          version: String(params.version),
          ifMatch: request.headers.get('if-match'),
          body: await request.json(),
        });
        return respond();
      }),
    );
    return sent;
  }

  /** Records downloads of any version: a push must never start one. */
  function recordDownloads() {
    const downloads: string[] = [];
    server.use(
      http.get(`${versionsPath}/:version/content`, ({ params }) => {
        downloads.push(String(params.version));
        return new HttpResponse(new TextEncoder().encode('%PDF-1.7\n'), {
          headers: { 'Content-Type': 'application/pdf' },
        });
      }),
    );
    return downloads;
  }

  const fileInput = (item: Awaited<ReturnType<typeof billOfLading>>) =>
    item.getByLabelText('PDF file for the bill of lading');

  it("keeps the seller's chosen file and its basis while a colleague's file and the buyer's decision are pushed", async () => {
    const served = servePage(voyage, asSeller);
    served.state.instructions = [anInstruction()];
    const theirs = aDocument({ currentVersion: aDocumentVersion({ uploadedBy: brunoUploads }) });
    const rejected = reviewedAs(theirs, { decision: 'REJECTED', reason: REASON });
    const mine = replacedBy(rejected, { fileName: 'bl-signed.pdf' });
    const sent = serveUploads(() => {
      served.state.documents = [mine];
      return HttpResponse.json(mine, { status: 201 });
    });
    const downloads = recordDownloads();
    const { source, user } = await liveFor(served, ana);
    const item = await billOfLading();
    await user.upload(fileInput(item), aPdf('bl-signed.pdf'));
    expect(item.getByRole('button', { name: 'Upload' })).toBeEnabled();

    // Bruno, Ana's colleague, uploads version 1 elsewhere; the server signals it.
    served.state.documents = [theirs];
    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
    });
    const latest = within(
      await item.findByRole('region', { name: 'Latest version of Bill of lading' }),
    );
    expect(latest.getByText('A new version was uploaded')).toBeVisible();
    expect(latest.getByText(/uploaded by Bruno Lima/)).toBeVisible();
    expect(item.getByText(/^bl-signed\.pdf/)).toBeVisible();
    expect(item.getByRole('button', { name: 'Upload' })).toBeDisabled();

    // Then Claire rejects Bruno's file: still Ana's file, still based on no document at all.
    served.state.documents = [rejected];
    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
    });
    expect(await item.findByText('Rejected')).toBeVisible();
    expect(item.getByText(/^bl-signed\.pdf/)).toBeVisible();
    expect(item.getByRole('button', { name: 'Upload' })).toBeDisabled();
    await quietly();
    // Nothing was sent, rebased, retried or downloaded behind Ana's back.
    expect(sent).toEqual([]);
    expect(downloads).toEqual([]);

    // Only Ana's choice bases her file on the document as it is now, which is what is sent.
    await user.click(latest.getByRole('button', { name: 'Replace version 1 with my file' }));
    await user.click(item.getByRole('button', { name: 'Upload as version 2' }));
    expect(
      await item.findByText('Version 2 of the bill of lading has been uploaded.'),
    ).toBeVisible();
    expect(sent).toEqual([{ fileName: 'bl-signed.pdf', ifMatch: '"2"', ifNoneMatch: null }]);
    expect(downloads).toEqual([]);
  });

  it("keeps the buyer's decision on its exact file while a replacement is pushed", async () => {
    const served = servePage();
    served.state.instructions = [buyersView(anInstruction())];
    served.state.documents = [buyersDocument(aDocument())];
    const replaced = buyersDocument(replacedBy(aDocument()));
    const sent = serveReviews(() =>
      HttpResponse.json(reviewedAs(replaced, { decision: 'REJECTED', reason: REASON })),
    );
    const downloads = recordDownloads();
    const { source, user } = await liveFor(served);
    const item = await billOfLading();
    await user.click(item.getByRole('radio', { name: 'Reject' }));
    await user.type(item.getByRole('textbox', { name: /Reason for rejecting/ }), REASON);

    // Ana replaces version 1 while Claire is deciding on it; the server signals it.
    served.state.documents = [replaced];
    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
    });
    const notice = within(await item.findByRole('region', { name: 'Changes to Bill of lading' }));
    expect(notice.getByText('A new version was uploaded')).toBeVisible();
    expect(notice.getByText(/after you started reviewing version 1/)).toBeVisible();
    expect(item.getByRole('textbox', { name: /Reason for rejecting/ })).toHaveValue(REASON);
    expect(item.getByRole('button', { name: 'Reject version 1' })).toBeDisabled();
    await quietly();
    // Nothing was sent, moved onto the new file, retried or downloaded behind Claire's back.
    expect(sent).toEqual([]);
    expect(downloads).toEqual([]);

    // Only Claire's choice moves the draft onto version 2, which is what is then decided.
    await user.click(notice.getByRole('button', { name: 'Review version 2 instead' }));
    expect(item.getByRole('textbox', { name: /Reason for rejecting/ })).toHaveValue(REASON);
    await user.click(item.getByRole('button', { name: 'Reject version 2' }));
    expect(
      await item.findByText('Version 2 of the bill of lading has been rejected.'),
    ).toBeVisible();
    expect(sent).toEqual([
      { version: '2', ifMatch: '"2"', body: { decision: 'REJECTED', reason: REASON } },
    ]);
    expect(downloads).toEqual([]);
  });

  it.each([
    ['first version', false],
    ['replacement', true],
  ] as const)(
    'shows no conflict when its own %s is signalled before the response',
    async (_case, replacing) => {
      const served = servePage(voyage, asSeller);
      served.state.instructions = [anInstruction()];
      const before = replacing ? aDocument() : null;
      served.state.documents = before ? [before] : [];
      const mine = before
        ? replacedBy(before, { fileName: 'bl-signed.pdf' })
        : aDocument({ currentVersion: aDocumentVersion({ fileName: 'bl-signed.pdf' }) });
      const { gate, received, arrived, release } = aGate();
      const sent = serveUploads(async () => {
        // Committed: the server signals it before this response reaches the browser.
        served.state.documents = [mine];
        arrived();
        await gate;
        return HttpResponse.json(mine, { status: 201 });
      });
      const { source, user, queryClient } = await liveFor(served, ana);
      const item = await billOfLading();
      await user.upload(fileInput(item), aPdf('bl-signed.pdf'));
      await user.click(
        item.getByRole('button', { name: replacing ? 'Upload as version 2' : 'Upload' }),
      );
      await received;

      const reads = served.requests.documents;
      act(() => {
        source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
      });
      await waitFor(() => {
        expect(
          queryClient.getQueryData<DocumentListResponse>(documentsKey(ana))?.items[0]?.version,
        ).toBe(mine.version);
      });
      expect(served.requests.documents).toBe(reads + 1);
      // The upload is still on its way: its answer decides, not the refresh.
      expect(
        item.queryByRole('region', { name: 'Latest version of Bill of lading' }),
      ).not.toBeInTheDocument();
      expect(item.getByText(/^bl-signed\.pdf/)).toBeVisible();

      release();
      expect(
        await item.findByText(
          `Version ${mine.currentVersion.number} of the bill of lading has been uploaded.`,
        ),
      ).toBeVisible();
      expect(
        item.queryByRole('region', { name: 'Latest version of Bill of lading' }),
      ).not.toBeInTheDocument();
      expect(item.queryByText('Not uploaded')).not.toBeInTheDocument();
      expect(item.getByText('No file chosen')).toBeVisible();
      expect(sent).toEqual([
        {
          fileName: 'bl-signed.pdf',
          ifMatch: replacing ? '"1"' : null,
          ifNoneMatch: replacing ? null : '*',
        },
      ]);
    },
  );

  it('shows no conflict when its own decision is signalled before the response', async () => {
    const served = servePage();
    served.state.instructions = [buyersView(anInstruction())];
    served.state.documents = [buyersDocument(aDocument())];
    const mine = buyersDocument(reviewedAs(aDocument()));
    const { gate, received, arrived, release } = aGate();
    const sent = serveReviews(async () => {
      // Committed: the server signals it before this response reaches the browser.
      served.state.documents = [mine];
      arrived();
      await gate;
      return HttpResponse.json(mine);
    });
    const { source, user, queryClient } = await liveFor(served);
    const item = await billOfLading();
    await user.click(item.getByRole('radio', { name: 'Approve' }));
    await user.click(item.getByRole('button', { name: 'Approve version 1' }));
    await received;

    act(() => {
      source.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
    });
    await waitFor(() => {
      expect(
        queryClient.getQueryData<DocumentListResponse>(documentsKey(claire))?.items[0]?.version,
      ).toBe(2);
    });
    // The decision is still on its way: its answer decides, not the refresh.
    expect(
      item.queryByRole('region', { name: 'Changes to Bill of lading' }),
    ).not.toBeInTheDocument();
    expect(item.getByRole('radio', { name: 'Approve' })).toBeChecked();

    release();
    expect(
      await item.findByText('Version 1 of the bill of lading has been approved.'),
    ).toBeVisible();
    expect(
      item.queryByRole('region', { name: 'Changes to Bill of lading' }),
    ).not.toBeInTheDocument();
    expect(item.queryByText('Not recorded')).not.toBeInTheDocument();
    expect(sent).toEqual([{ version: '1', ifMatch: '"1"', body: { decision: 'APPROVED' } }]);
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
    const live = (count: number) => ({
      notices: count,
      'documentary-instructions': count,
      documents: count,
      timeline: count,
    });
    await waitFor(() => {
      expect(requests).toMatchObject(live(2));
    });

    // Live: no polling.
    await act(() => vi.advanceTimersByTimeAsync(2 * FALLBACK_POLL_INTERVAL_MS));
    expect(requests).toMatchObject(live(2));

    // The connection drops; the browser reconnects by itself. Meanwhile, the page polls.
    act(() => {
      source.drop();
    });
    await act(() => vi.advanceTimersByTimeAsync(FALLBACK_POLL_INTERVAL_MS));
    await waitFor(() => {
      expect(requests).toMatchObject(live(3));
    });

    // Back: whatever changed while away is read through REST, and polling stops.
    act(() => {
      source.emit({ type: 'READY' });
    });
    await waitFor(() => {
      expect(requests).toMatchObject(live(4));
    });
    await act(() => vi.advanceTimersByTimeAsync(2 * FALLBACK_POLL_INTERVAL_MS));
    // Nothing else was ever refetched.
    expect(requests).toEqual({ voyage: 1, 'trade-string': 1, 'my-contracts': 1, ...live(4) });
    expect(FakeEventSource.instances).toHaveLength(1);
  });

  it('polls until the stream is ready, and not while the page is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const { requests } = servePage();
    renderRoute(page, { signedInAs: claire });
    await theStream();
    await loaded(requests);

    await act(() => vi.advanceTimersByTimeAsync(FALLBACK_POLL_INTERVAL_MS));
    const polledOnce = {
      notices: 2,
      'documentary-instructions': 2,
      documents: 2,
      timeline: 2,
    };
    await waitFor(() => {
      expect(requests).toMatchObject(polledOnce);
    });

    act(() => {
      focusManager.setFocused(false);
    });
    await act(() => vi.advanceTimersByTimeAsync(3 * FALLBACK_POLL_INTERVAL_MS));
    expect(requests).toMatchObject(polledOnce);
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
      source.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
      source.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
    });
    await quietly();
    expect(requests.notices).toBe(1);
    expect(requests['documentary-instructions']).toBe(1);
    expect(requests.documents).toBe(1);
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
    const settledInstructions = requests['documentary-instructions'];
    const settledDocuments = requests.documents;

    // The old stream speaks for the session that was signed out, though it was Claire's too.
    act(() => {
      before.emit({ type: 'READY' });
      before.emit({ type: 'NOTICE_ISSUED' });
      before.emit({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
      before.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
    });
    await quietly();
    expect(requests.notices).toBe(settled);
    expect(requests['documentary-instructions']).toBe(settledInstructions);
    expect(requests.documents).toBe(settledDocuments);

    act(() => {
      after.emit({ type: 'NOTICE_ISSUED' });
    });
    await waitFor(() => {
      expect(requests.notices).toBe(settled + 1);
    });
    act(() => {
      after.emit({ type: 'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED' });
    });
    await waitFor(() => {
      expect(requests['documentary-instructions']).toBe(settledInstructions + 1);
    });
    act(() => {
      after.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
    });
    await waitFor(() => {
      expect(requests.documents).toBe(settledDocuments + 1);
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

    await waitFor(() => {
      expect(requests['documentary-instructions']).toBe(3);
      expect(requests.documents).toBe(3);
    });

    // Claire's first stream speaks for a session that has ended, though she is back.
    act(() => {
      claires.emit({ type: 'NOTICE_ISSUED' });
      claires.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      claires.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
      anas.emit({ type: 'NOTICE_ISSUED' });
      anas.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      anas.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
    });
    await quietly();
    expect(requests.notices).toBe(3);
    expect(requests['documentary-instructions']).toBe(3);
    expect(requests.documents).toBe(3);

    act(() => {
      clairesAgain.emit({ type: 'NOTICE_ISSUED' });
      clairesAgain.emit({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
      clairesAgain.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
    });
    await waitFor(() => {
      expect(requests.notices).toBe(4);
      expect(requests['documentary-instructions']).toBe(4);
      expect(requests.documents).toBe(4);
    });
    expect(FakeEventSource.open()).toEqual([clairesAgain]);
  });
});
