import { act, screen, waitFor, within } from '@testing-library/react';
import {
  type ContractDocument,
  type CounterpartyContractListResponse,
  type CurrentUser,
  type DocumentaryInstruction,
  type ProblemDetails,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../../test/fixtures/auth';
import { anInstruction } from '../../../test/fixtures/documentary-instructions';
import { aDocument, davidReviews, replacedBy, reviewedAs } from '../../../test/fixtures/documents';
import { aCounterpartyContract, contractList } from '../../../test/fixtures/notices';
import { aTradeString, aVoyageDetail } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from '../../auth/session-sync';

const voyage = aVoyageDetail();
const page = `/voyages/${voyage.id}`;

/** Claire operates for Lacustra, the buyer under contract 1: she reviews the documents. */
const claire = anotherUser();
const claireAsViewer: CurrentUser = { ...claire, user: { ...claire.user, role: 'VIEWER' } };
/** Ana operates for Cerrado, the seller under contract 1: she presents them. */
const ana = aCurrentUser();

const asSeller = aCounterpartyContract();
const asBuyer = aCounterpartyContract({ side: 'BUYER' });
const contractName = 'Contract 1 · Cerrado Grãos Exportadora S.A. → Lacustra Commodities SA';
const versionsPath = `/contracts/${asSeller.id}/documentary-instructions/revisions/1/documents/BILL_OF_LADING/versions`;

const REASON = 'The consignee does not match the instructions.';

/** `document` as the buyer sees it. */
const forBuyer = (document: ContractDocument): ContractDocument => ({
  ...document,
  contract: asBuyer,
});

/**
 * Serves the details page from one side of contract 1. `documents` is the fake server's state:
 * tests change it, and every list request answers what it holds at that moment.
 */
function servePage({
  side = 'BUYER',
  documents = [] as ContractDocument[],
}: { side?: 'BUYER' | 'SELLER'; documents?: ContractDocument[] } = {}) {
  const contract = side === 'BUYER' ? asBuyer : asSeller;
  const contracts: CounterpartyContractListResponse = contractList(contract);
  const instructions: DocumentaryInstruction[] = [{ ...anInstruction(), contract }];
  const state = { documents, documentRequests: 0, instructionRequests: 0 };
  server.use(
    http.get(`*/api/voyages/${voyage.id}`, () => HttpResponse.json(voyage)),
    http.get(`*/api/voyages/${voyage.id}/trade-string`, () => HttpResponse.json(aTradeString())),
    http.get(`*/api/voyages/${voyage.id}/my-contracts`, () => HttpResponse.json(contracts)),
    http.get(`*/api/voyages/${voyage.id}/notices`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${voyage.id}/documentary-instructions`, () => {
      state.instructionRequests += 1;
      return HttpResponse.json({ items: instructions });
    }),
    http.get(`*/api/voyages/${voyage.id}/documents`, () => {
      state.documentRequests += 1;
      return HttpResponse.json({ items: state.documents });
    }),
  );
  return state;
}

interface SentReview {
  version: string;
  ifMatch: string | null;
  body: unknown;
}

/** Holds a response until `release()`. */
function aGate() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  return { gate, received, arrived, release };
}

/** Serves reviews of the bill of lading with `respond`. With `hold`, responses wait for `release()`. */
function serveReview(respond: (sent: SentReview) => Response, { hold = false } = {}) {
  const sent: SentReview[] = [];
  const { gate, received, arrived, release } = aGate();
  server.use(
    http.post(
      `*/api/voyages/${voyage.id}${versionsPath}/:version/review`,
      async ({ request, params }) => {
        const review = {
          version: String(params.version),
          ifMatch: request.headers.get('if-match'),
          body: await request.json(),
        };
        sent.push(review);
        arrived();
        if (hold) await gate;
        return respond(review);
      },
    ),
  );
  return { sent, received, release };
}

/** Serves uploads of the bill of lading with `respond`, recording their preconditions. */
function serveUpload(respond: () => Response) {
  const sent: { ifMatch: string | null; ifNoneMatch: string | null }[] = [];
  server.use(
    http.post(`*/api/voyages/${voyage.id}${versionsPath}`, async ({ request }) => {
      await request.formData();
      sent.push({
        ifMatch: request.headers.get('if-match'),
        ifNoneMatch: request.headers.get('if-none-match'),
      });
      return respond();
    }),
  );
  return { sent };
}

const problem = (status: number, title: string, detail: string) =>
  HttpResponse.json({ type: 'about:blank', title, status, detail } satisfies ProblemDetails, {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

const stale = () =>
  problem(
    412,
    'Precondition Failed',
    'The document has changed since the version you sent; it is now at version 2.',
  );

type Rendered = ReturnType<typeof renderRoute>;
type User = Rendered['user'];

/** The bill of lading's entry under contract 1's current revision. */
async function billOfLading() {
  const panel = within(await screen.findByRole('listitem', { name: contractName }));
  return within(await panel.findByRole('listitem', { name: 'Bill of lading' }));
}
type Item = Awaited<ReturnType<typeof billOfLading>>;

/** Chooses to reject, and types the reason. */
async function draftRejection(user: User, item: Item, reason = REASON) {
  await user.click(item.getByRole('radio', { name: 'Reject' }));
  await user.type(item.getByRole('textbox', { name: /Reason for rejecting/ }), reason);
}

const protectedQueries = (queryClient: Rendered['queryClient']) =>
  queryClient.getQueryCache().findAll({ queryKey: ['protected'] });

const pendingMutations = (queryClient: Rendered['queryClient']) =>
  queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status === 'pending');

/** Waits until every request still on its way has been answered and handled. */
async function allAnswered(queryClient: Rendered['queryClient']) {
  await waitFor(() => {
    expect(pendingMutations(queryClient)).toEqual([]);
  });
}

/** Claire's document list in the session now current: what a stale response must not touch. */
const clairesDocuments = (queryClient: Rendered['queryClient']) =>
  queryClient
    .getQueryCache()
    .findAll({ queryKey: ['protected', `${claire.user.id}:${claire.organization.id}`] })
    .filter((query) => query.queryKey.includes('documents'));

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

async function signOut(user: User) {
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
}

/** Signs in on the sign-in page, then opens the voyage page again. */
async function signIn({ user, router }: Pick<Rendered, 'user' | 'router'>, identity: CurrentUser) {
  await user.type(await screen.findByLabelText(/Email/), identity.user.email);
  await user.type(screen.getByLabelText(/Password/), TEST_PASSWORD);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
  expect(await screen.findByText(identity.user.fullName)).toBeInTheDocument();
  await act(() => router.navigate(page));
}

/** Another tab signed in as `identity`; waits until this tab has adopted it. */
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

/** The cookie now belongs to `identity`, unannounced: a session check finds out. */
async function aSessionCheckFinds(
  { session, queryClient }: Pick<Rendered, 'session' | 'queryClient'>,
  identity: CurrentUser,
) {
  session.current = identity;
  await act(() => queryClient.refetchQueries({ queryKey: ['session'] }));
  expect(queryClient.getQueryData(['session'])).toEqual(identity);
}

describe('Reviewing documents on the voyage page', () => {
  describe('as an operator of the buyer', () => {
    it('approves the latest version at the version read, and shows the decision', async () => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      const decided = forBuyer(reviewedAs(aDocument()));
      const review = serveReview(() => {
        state.documents = [decided];
        return HttpResponse.json(decided);
      });
      const { user } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();
      expect(item.getByText('Pending review')).toBeVisible();
      expect(item.getByText('Pending review by Lacustra Commodities SA')).toBeVisible();

      await user.click(item.getByRole('radio', { name: 'Approve' }));
      await user.click(item.getByRole('button', { name: 'Approve version 1' }));

      expect(
        await item.findByText('Version 1 of the bill of lading has been approved.'),
      ).toBeVisible();
      expect(review.sent).toEqual([
        { version: '1', ifMatch: '"1"', body: { decision: 'APPROVED' } },
      ]);
      expect(item.getByText('Approved')).toBeVisible();
      expect(item.getByText(/^Approved by Claire Morel \(Lacustra Commodities SA\)/)).toBeVisible();
      expect(item.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
    });

    it('asks why before it sends a rejection, then sends the reason', async () => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      const decided = forBuyer(reviewedAs(aDocument(), { decision: 'REJECTED', reason: REASON }));
      const review = serveReview(() => {
        state.documents = [decided];
        return HttpResponse.json(decided);
      });
      const { user } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();

      await user.click(item.getByRole('radio', { name: 'Reject' }));
      await user.type(item.getByRole('textbox', { name: /Reason for rejecting/ }), '   ');
      await user.click(item.getByRole('button', { name: 'Reject version 1' }));

      expect(item.getByText('Say why the document is rejected')).toBeVisible();
      expect(review.sent).toEqual([]);

      await user.clear(item.getByRole('textbox', { name: /Reason for rejecting/ }));
      await user.type(item.getByRole('textbox', { name: /Reason for rejecting/ }), REASON);
      await user.click(item.getByRole('button', { name: 'Reject version 1' }));

      expect(
        await item.findByText('Version 1 of the bill of lading has been rejected.'),
      ).toBeVisible();
      expect(review.sent).toEqual([
        { version: '1', ifMatch: '"1"', body: { decision: 'REJECTED', reason: REASON } },
      ]);
      expect(item.getByLabelText('Reason for rejecting version 1')).toHaveTextContent(REASON);
    });

    it.each<[string, ContractDocument, string]>([
      // A decision changes the document but not its latest file: ordered by version, it shows.
      ['shows a decision from its response at once', aDocument(), 'Approved'],
      // A newer document already shown is never replaced by an older response.
      [
        'keeps a newer document over a late response',
        replacedBy(reviewedAs(aDocument())),
        'Pending review',
      ],
    ])('%s, ahead of the refresh', async (_case, onScreenMeanwhile, status) => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      const { user, queryClient } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();
      // From now on the list is refreshed only when the test says.
      const refresh = aGate();
      watchers.push(refresh.release);
      server.use(
        http.get(`*/api/voyages/${voyage.id}/documents`, async () => {
          await refresh.gate;
          return HttpResponse.json({ items: state.documents });
        }),
      );
      const review = serveReview(() => HttpResponse.json(forBuyer(reviewedAs(aDocument()))), {
        hold: true,
      });
      await user.click(item.getByRole('radio', { name: 'Approve' }));
      await user.click(item.getByRole('button', { name: 'Approve version 1' }));
      await review.received;
      const scope = ['protected', `${claire.user.id}:${claire.organization.id}`];
      act(() => {
        queryClient.setQueryData([...scope, 'voyages', 'detail', voyage.id, 'documents'], {
          items: [forBuyer(onScreenMeanwhile)],
        });
      });

      review.release();
      await allAnswered(queryClient);

      expect(await item.findByText(status)).toBeVisible();
      const [documents] = clairesDocuments(queryClient);
      expect(documents?.state.data).toEqual({
        items: [
          forBuyer(onScreenMeanwhile.version > 1 ? onScreenMeanwhile : reviewedAs(aDocument())),
        ],
      });
    });

    it('decides on a replacement at the version that counts the earlier decision', async () => {
      const rejected = reviewedAs(aDocument(), { decision: 'REJECTED', reason: REASON });
      const pending = replacedBy(rejected);
      servePage({ documents: [forBuyer(pending)] });
      const review = serveReview(() => HttpResponse.json(forBuyer(reviewedAs(pending))));
      const { user } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();

      await user.click(item.getByRole('radio', { name: 'Approve' }));
      await user.click(item.getByRole('button', { name: 'Approve version 2' }));

      await waitFor(() => {
        expect(review.sent).toEqual([
          { version: '2', ifMatch: '"3"', body: { decision: 'APPROVED' } },
        ]);
      });
    });

    it('offers viewers of the buyer no decision, and says who can make one', async () => {
      servePage({ documents: [forBuyer(aDocument())] });
      renderRoute(page, { signedInAs: claireAsViewer });

      const item = await billOfLading();
      expect(item.getByText('Pending review')).toBeVisible();
      expect(item.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
      expect(
        item.getByText('An operator in your organization can approve or reject it.'),
      ).toBeVisible();
    });

    it('offers nothing to decide once the latest version is decided', async () => {
      servePage({ documents: [forBuyer(reviewedAs(aDocument()))] });
      renderRoute(page, { signedInAs: claire });

      const item = await billOfLading();
      expect(item.getByText('Approved')).toBeVisible();
      expect(item.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
      expect(item.queryByText(/An operator in your organization/)).not.toBeInTheDocument();
    });
  });

  describe('as the seller', () => {
    it('shows every decision with its reason, on the version it was made on, read-only', async () => {
      const rejected = reviewedAs(aDocument(), { decision: 'REJECTED', reason: REASON });
      servePage({ side: 'SELLER', documents: [replacedBy(rejected)] });
      const { user } = renderRoute(page, { signedInAs: ana });

      const item = await billOfLading();
      expect(item.getByText('Pending review')).toBeVisible();
      expect(item.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
      await user.click(item.getByRole('button', { name: 'Earlier versions (1)' }));
      const earlier = within(
        item.getByRole('list', { name: 'Earlier versions of the bill of lading' }),
      );
      expect(
        earlier.getByText(/^Rejected by Claire Morel \(Lacustra Commodities SA\)/),
      ).toBeVisible();
      expect(earlier.getByLabelText('Reason for rejecting version 1')).toHaveTextContent(REASON);
    });
  });

  describe('when the document changes before a decision arrives', () => {
    it('tells a new file apart, keeps the draft, and moves it onto the new file only when asked', async () => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      const replaced = forBuyer(replacedBy(aDocument()));
      const review = serveReview((sent) =>
        sent.version === '1'
          ? stale()
          : HttpResponse.json(
              forBuyer(
                reviewedAs(replacedBy(aDocument()), { decision: 'REJECTED', reason: REASON }),
              ),
            ),
      );
      const { user } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();
      await draftRejection(user, item);
      // Ana uploads version 2 meanwhile.
      state.documents = [replaced];

      await user.click(item.getByRole('button', { name: 'Reject version 1' }));

      const notice = within(await item.findByRole('region', { name: 'Changes to Bill of lading' }));
      expect(notice.getByText('A new version was uploaded')).toBeVisible();
      expect(notice.getByText(/after you started reviewing version 1/)).toBeVisible();
      expect(item.getByRole('textbox', { name: /Reason for rejecting/ })).toHaveValue(REASON);
      expect(item.getByRole('button', { name: 'Reject version 1' })).toBeDisabled();
      expect(review.sent).toHaveLength(1);

      await user.click(notice.getByRole('button', { name: 'Review version 2 instead' }));
      expect(item.getByRole('textbox', { name: /Reason for rejecting/ })).toHaveValue(REASON);
      await user.click(item.getByRole('button', { name: 'Reject version 2' }));

      expect(
        await item.findByText('Version 2 of the bill of lading has been rejected.'),
      ).toBeVisible();
      expect(review.sent.map(({ version, ifMatch }) => [version, ifMatch])).toEqual([
        ['1', '"1"'],
        ['2', '"2"'],
      ]);
    });

    it("tells a colleague's decision apart: final, so the draft can only be dismissed", async () => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      const review = serveReview(stale);
      const { user } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();
      await user.click(item.getByRole('radio', { name: 'Approve' }));
      // David rejects version 1 meanwhile.
      state.documents = [
        forBuyer(
          reviewedAs(aDocument(), {
            decision: 'REJECTED',
            reason: REASON,
            reviewedBy: davidReviews,
          }),
        ),
      ];

      await user.click(item.getByRole('button', { name: 'Approve version 1' }));

      const notice = within(await item.findByRole('region', { name: 'Changes to Bill of lading' }));
      expect(notice.getByText('Version 1 was already rejected')).toBeVisible();
      expect(
        notice.getByText(/David Keller \(Lacustra Commodities SA\) rejected version 1/),
      ).toBeVisible();
      expect(notice.getByText(new RegExp(REASON))).toBeVisible();
      expect(notice.queryByRole('button', { name: /instead/ })).not.toBeInTheDocument();
      expect(item.getByRole('button', { name: 'Approve version 1' })).toBeDisabled();

      await user.click(notice.getByRole('button', { name: 'Dismiss' }));

      expect(item.queryByRole('region', { name: 'Changes to Bill of lading' })).toBeNull();
      expect(item.queryByRole('radio', { name: 'Approve' })).not.toBeInTheDocument();
      expect(item.getByText('Rejected')).toBeVisible();
      expect(review.sent).toHaveLength(1);
    });

    it('shows a change a refresh brings in before anything is sent', async () => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      const review = serveReview(stale);
      const { user, queryClient } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();
      await draftRejection(user, item);

      state.documents = [forBuyer(replacedBy(aDocument()))];
      await act(() => queryClient.invalidateQueries({ queryKey: ['protected'] }));

      expect(await item.findByRole('region', { name: 'Changes to Bill of lading' })).toBeVisible();
      expect(item.getByRole('button', { name: 'Reject version 1' })).toBeDisabled();
      expect(review.sent).toEqual([]);
    });

    it('reports a revision superseded meanwhile and refreshes the instructions', async () => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      serveReview(() =>
        problem(
          409,
          'Conflict',
          'Revision 1 has been superseded by revision 2; only documents of the current revision are reviewed.',
        ),
      );
      const { user } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();
      await user.click(item.getByRole('radio', { name: 'Approve' }));
      const instructionRequests = state.instructionRequests;

      await user.click(item.getByRole('button', { name: 'Approve version 1' }));

      expect(
        await item.findByText(
          'Not recorded: Revision 1 has been superseded by revision 2; only documents of the current revision are reviewed.',
        ),
      ).toBeVisible();
      await waitFor(() => {
        expect(state.instructionRequests).toBeGreaterThan(instructionRequests);
      });
    });

    it("tells the seller the buyer's decision apart from a new file, and keeps the chosen file", async () => {
      const state = servePage({ side: 'SELLER', documents: [aDocument()] });
      const rejected = reviewedAs(aDocument(), { decision: 'REJECTED', reason: REASON });
      const upload = serveUpload(() =>
        upload.sent.length === 1
          ? stale()
          : HttpResponse.json(replacedBy(rejected), { status: 201 }),
      );
      const { user } = renderRoute(page, { signedInAs: ana });
      const item = await billOfLading();
      await user.upload(
        item.getByLabelText('PDF file for the bill of lading'),
        new File([new TextEncoder().encode('%PDF-1.7\n')], 'bl-corrected.pdf', {
          type: 'application/pdf',
        }),
      );
      // Claire rejects version 1 meanwhile.
      state.documents = [rejected];

      await user.click(item.getByRole('button', { name: 'Upload as version 2' }));

      expect(await item.findByText('Not uploaded')).toBeVisible();
      await user.click(item.getByRole('button', { name: 'Review the latest version' }));
      const latest = within(
        await item.findByRole('region', { name: 'Latest version of Bill of lading' }),
      );
      expect(latest.getByText('Version 1 was rejected')).toBeVisible();
      expect(latest.queryByText('A new version was uploaded')).toBeNull();
      expect(latest.getByText(new RegExp(REASON))).toBeVisible();
      expect(item.getByText(/^bl-corrected\.pdf/)).toBeVisible();
      expect(item.getByRole('button', { name: 'Upload as version 2' })).toBeDisabled();

      await user.click(latest.getByRole('button', { name: 'Replace version 1 with my file' }));
      await user.click(item.getByRole('button', { name: 'Upload as version 2' }));

      expect(
        await item.findByText('Version 2 of the bill of lading has been uploaded.'),
      ).toBeVisible();
      // The first upload was based on the file alone; the second on the decision too.
      expect(upload.sent).toEqual([
        { ifMatch: '"1"', ifNoneMatch: null },
        { ifMatch: '"2"', ifNoneMatch: null },
      ]);
    });
  });

  describe('when the session is replaced while a decision is on its way', () => {
    it('lets a decision sent before Claire signed out and back in touch nothing of her new session', async () => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      const review = serveReview(() => HttpResponse.json(forBuyer(reviewedAs(aDocument()))), {
        hold: true,
      });
      const rendered = renderRoute(page, { signedInAs: claire });
      const { user, queryClient } = rendered;
      const before = await billOfLading();
      await user.click(before.getByRole('radio', { name: 'Approve' }));
      await user.click(before.getByRole('button', { name: 'Approve version 1' }));
      await review.received;

      await signOut(user);
      await signIn(rendered, claire);
      const item = await billOfLading();
      expect(item.getByText('Pending review')).toBeVisible();
      const documentRequests = state.documentRequests;
      const instructionRequests = state.instructionRequests;
      review.release();
      await allAnswered(queryClient);

      expect(screen.queryByText(/has been approved/)).not.toBeInTheDocument();
      expect(item.getByText('Pending review')).toBeVisible();
      expect(state.documentRequests).toBe(documentRequests);
      expect(state.instructionRequests).toBe(instructionRequests);
      const [documents] = clairesDocuments(queryClient);
      expect(documents?.state.data).toEqual({ items: [forBuyer(aDocument())] });
      expect(documents?.state.isInvalidated).toBe(false);
    });

    it.each<[string, () => Response]>([
      ['answers 412', stale],
      ['answers 409', () => problem(409, 'Conflict', 'Version 1 has already been approved.')],
      ['succeeds', () => HttpResponse.json(forBuyer(reviewedAs(aDocument())))],
    ])(
      'lets a decision sent before session checks went to Ana and back, which %s, refresh nothing',
      async (_case, respond) => {
        const state = servePage({ documents: [forBuyer(aDocument())] });
        const review = serveReview(respond, { hold: true });
        const rendered = renderRoute(page, { signedInAs: claire, accounts: [claire, ana] });
        const { user, queryClient } = rendered;
        const before = await billOfLading();
        await user.click(before.getByRole('radio', { name: 'Approve' }));
        await user.click(before.getByRole('button', { name: 'Approve version 1' }));
        await review.received;

        await aSessionCheckFinds(rendered, ana);
        expect(await screen.findByText('Ana Souza')).toBeInTheDocument();
        await aSessionCheckFinds(rendered, claire);
        expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
        const item = await billOfLading();
        expect(await item.findByText('Pending review')).toBeVisible();
        const documentRequests = state.documentRequests;
        const instructionRequests = state.instructionRequests;
        review.release();
        await allAnswered(queryClient);

        expect(screen.queryByText(/has been approved/)).not.toBeInTheDocument();
        expect(item.queryByRole('region', { name: 'Changes to Bill of lading' })).toBeNull();
        expect(state.documentRequests).toBe(documentRequests);
        expect(state.instructionRequests).toBe(instructionRequests);
        for (const query of protectedQueries(queryClient)) {
          expect(query.state.isInvalidated).toBe(false);
        }
      },
    );

    it('keeps Claire signed in when a 401 sent before another tab went to Ana and back answers', async () => {
      servePage({ documents: [forBuyer(aDocument())] });
      const review = serveReview(() => problemResponse(401, 'Authentication is required.'), {
        hold: true,
      });
      const rendered = renderRoute(page, { signedInAs: claire, accounts: [claire, ana] });
      const { router, user, session, queryClient } = rendered;
      const otherTab = anotherTab(queryClient);
      const before = await billOfLading();
      await user.click(before.getByRole('radio', { name: 'Approve' }));
      await user.click(before.getByRole('button', { name: 'Approve version 1' }));
      await review.received;

      await anotherTabSignsInAs(otherTab, rendered, ana);
      expect(await screen.findByText('Ana Souza')).toBeInTheDocument();
      await anotherTabSignsInAs(otherTab, rendered, claire);
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      expect(await billOfLading()).toBeDefined();
      review.release();
      await allAnswered(queryClient);

      expect(queryClient.getQueryData(['session'])).toEqual(claire);
      expect(router.state.location.pathname).toBe(page);
      expect(screen.queryByRole('heading', { name: 'Sign in to TradeFlow' })).toBeNull();
      expect(session.signOutRequests).toBe(0);
    });

    it('records the decision when a session check only confirmed that Claire is still signed in', async () => {
      const state = servePage({ documents: [forBuyer(aDocument())] });
      const decided = forBuyer(reviewedAs(aDocument()));
      const review = serveReview(
        () => {
          state.documents = [decided];
          return HttpResponse.json(decided);
        },
        { hold: true },
      );
      const rendered = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();
      await rendered.user.click(item.getByRole('radio', { name: 'Approve' }));
      await rendered.user.click(item.getByRole('button', { name: 'Approve version 1' }));
      await review.received;

      const checks = rendered.session.meRequests;
      await aSessionCheckFinds(rendered, claire);
      expect(rendered.session.meRequests).toBe(checks + 1);
      review.release();

      expect(
        await item.findByText('Version 1 of the bill of lading has been approved.'),
      ).toBeVisible();
    });

    it('ends the session a decision was sent under when it answers 401', async () => {
      servePage({ documents: [forBuyer(aDocument())] });
      serveReview(() => problemResponse(401, 'Authentication is required.'));
      const { router, user, session, queryClient } = renderRoute(page, { signedInAs: claire });
      const item = await billOfLading();
      await user.click(item.getByRole('radio', { name: 'Approve' }));
      session.current = null;

      await user.click(item.getByRole('button', { name: 'Approve version 1' }));

      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
      await waitFor(() => {
        expect(protectedQueries(queryClient)).toEqual([]);
      });
      expect(session.signOutRequests).toBe(0);
    });
  });
});
