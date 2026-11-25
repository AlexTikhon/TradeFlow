import { act, screen, waitFor, within } from '@testing-library/react';
import type {
  ContractDocument,
  CounterpartyContract,
  CurrentUser,
  DocumentaryInstruction,
  RequiredDocumentType,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyActionPage } from '../../../test/fixtures/action-items';
import { aCurrentUser, anotherUser } from '../../../test/fixtures/auth';
import { anInstruction, aRevision } from '../../../test/fixtures/documentary-instructions';
import { aDocument, replacedBy, reviewedAs } from '../../../test/fixtures/documents';
import {
  aCounterpartyContract,
  contractList,
  lacustraSellsToNordlys,
} from '../../../test/fixtures/notices';
import { emptyTimeline } from '../../../test/fixtures/timeline';
import { aTradeString, aVoyageDetail } from '../../../test/fixtures/voyages';
import { FakeEventSource } from '../../../test/fake-event-source';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';

/*
 * The document-set summary above the current revision's documents: a read-only projection of the
 * instructions and documents the page already reads. Through the real route tree, providers and
 * query client; only the network (MSW) and the event stream (FakeEventSource) are faked.
 */

const voyage = aVoyageDetail();
const page = `/voyages/${voyage.id}`;

/** Ana operates for Cerrado, the seller under contract 1; Rafael-like viewer at Cerrado. */
const ana = aCurrentUser();
const anaAsViewer: CurrentUser = { ...ana, user: { ...ana.user, role: 'VIEWER' } };
/** Claire operates for Lacustra, the buyer under contract 1. */
const claire = anotherUser();

const asSeller = aCounterpartyContract();
const asBuyer = aCounterpartyContract({ side: 'BUYER' });
const contractName = 'Contract 1 · Cerrado Grãos Exportadora S.A. → Lacustra Commodities SA';
const versionsPath = (type: RequiredDocumentType) =>
  `*/api/voyages/${voyage.id}/contracts/${asSeller.id}/documentary-instructions/revisions/1/documents/${type}/versions`;

const FOUR: RequiredDocumentType[] = [
  'COMMERCIAL_INVOICE',
  'CERTIFICATE_OF_ORIGIN',
  'WEIGHT_CERTIFICATE',
  'BILL_OF_LADING',
];
const REASON = 'Net weight does not match the contract quantity.';

/** Revision `number` requiring each of `types`, with quantities that must not count. */
const revisionRequiring = (types: RequiredDocumentType[], number = 1) =>
  aRevision({
    number,
    requirements: types.map((document) => ({ document, originals: 3, copies: 2 })),
  });

/** Instructions under contract 1 whose current revision requires `types`. */
const instructionsRequiring = (types: RequiredDocumentType[]) =>
  anInstruction({ currentRevision: revisionRequiring(types) });

/** A first file of `type` against revision `revisionNumber` of contract 1. */
const presented = (type: RequiredDocumentType, revisionNumber = 1): ContractDocument =>
  aDocument({
    id: `01990000-0000-7000-800b-${String(FOUR.indexOf(type) + 2).padStart(4, '0')}0000000${revisionNumber}`,
    documentType: type,
    revisionNumber,
  });
const approved = (document: ContractDocument) => reviewedAs(document);
const rejected = (document: ContractDocument) =>
  reviewedAs(document, { decision: 'REJECTED', reason: REASON });

/** The portfolio showcase's four states: invoice missing, one pending, rejected, approved. */
const showcaseDocuments = () => [
  presented('CERTIFICATE_OF_ORIGIN'),
  rejected(presented('WEIGHT_CERTIFICATE')),
  approved(replacedBy(rejected(presented('BILL_OF_LADING')))),
];

/** The documents and instructions as `contract`'s side receives them. */
const seenFrom = <T extends { contract: CounterpartyContract }>(
  items: T[],
  contract: CounterpartyContract,
): T[] => items.map((item) => (item.contract.id === contract.id ? { ...item, contract } : item));

/**
 * Serves the details page from `contract`'s side. `state` is the fake server's data; tests change
 * it as another user's command would. `fail` makes the next reads of a resource fail; `hold`
 * holds the documents reads until released.
 */
function servePage({
  contract = asSeller,
  instructions = [instructionsRequiring(FOUR)],
  documents = [] as ContractDocument[],
}: {
  contract?: CounterpartyContract;
  instructions?: DocumentaryInstruction[];
  documents?: ContractDocument[];
} = {}) {
  const state = {
    instructions,
    documents,
    failDocuments: false,
    failInstructions: false,
    holdDocuments: null as Promise<void> | null,
    documentRequests: 0,
    instructionRequests: 0,
    commands: [] as string[],
  };
  const base = `*/api/voyages/${voyage.id}`;
  server.use(
    http.get(base, () => HttpResponse.json(voyage)),
    http.get(`${base}/trade-string`, () => HttpResponse.json(aTradeString())),
    http.get(`${base}/my-contracts`, () => HttpResponse.json(contractList(contract))),
    http.get(`${base}/notices`, () => HttpResponse.json({ items: [] })),
    http.get(`${base}/timeline`, () => HttpResponse.json(emptyTimeline)),
    http.get(`${base}/documentary-instructions`, () => {
      state.instructionRequests += 1;
      if (state.failInstructions) return problemResponse(500, 'Boom');
      return HttpResponse.json({ items: seenFrom(state.instructions, contract) });
    }),
    http.get(`${base}/documents`, async () => {
      state.documentRequests += 1;
      if (state.holdDocuments) await state.holdDocuments;
      if (state.failDocuments) return problemResponse(500, 'Boom');
      return HttpResponse.json({ items: seenFrom(state.documents, contract) });
    }),
    // Any write: the summary must never send one.
    http.all(`${base}/contracts/*`, ({ request }) => {
      if (request.method === 'GET') return undefined;
      state.commands.push(`${request.method} ${new URL(request.url).pathname}`);
      return problemResponse(500, 'Unexpected command');
    }),
  );
  return state;
}

/** A promise to hold a response on, and its release. */
function aGate() {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { gate, release };
}

const panel = async () => within(await screen.findByRole('listitem', { name: contractName }));

/** The summary named `headline`, with its four counts in order. */
async function expectDocumentSet(
  headline: string,
  [missing, pending, rejectedCount, approvedCount]: [number, number, number, number],
) {
  // Waits: a refresh may change the counts while the headline stays the same.
  return waitFor(() => {
    const group = screen.getByRole('group', { name: headline });
    expect(
      within(group)
        .getAllByRole('listitem')
        .map((item) => item.textContent),
    ).toEqual([
      `Missing: ${missing}`,
      `Pending review: ${pending}`,
      `Rejected: ${rejectedCount}`,
      `Approved: ${approvedCount}`,
    ]);
    return within(group);
  });
}

const summaries = () => screen.queryAllByRole('group', { name: /^Documents approved:/ });
const COMPLETE = 'All required documents approved.';

const refreshDocuments = (queryClient: ReturnType<typeof renderRoute>['queryClient']) =>
  act(() =>
    queryClient.invalidateQueries({ predicate: (query) => query.queryKey.at(-1) === 'documents' }),
  );
const refreshInstructions = (queryClient: ReturnType<typeof renderRoute>['queryClient']) =>
  act(() =>
    queryClient.invalidateQueries({
      predicate: (query) => query.queryKey.at(-1) === 'documentary-instructions',
    }),
  );

describe('The document-set summary on the voyage page', () => {
  describe('reading', () => {
    it.each([
      ['the seller', ana, asSeller],
      ['the buyer', claire, asBuyer],
      ['a viewer at the seller', anaAsViewer, asSeller],
    ] as const)(
      'shows %s the portfolio scenario: 1 of 4 approved, one in each state',
      async (_who, identity, contract) => {
        const state = servePage({ contract, documents: showcaseDocuments() });
        renderRoute(page, { signedInAs: identity });

        const summary = await expectDocumentSet('Documents approved: 1 of 4', [1, 1, 1, 1]);
        expect(summary.queryByText(COMPLETE)).not.toBeInTheDocument();
        expect(summaries()).toHaveLength(1);
        // It sits in contract 1's panel, above the list of the documents it counts.
        const list = (await panel()).getByRole('list', { name: 'Documents' });
        expect(
          summary.getByText('Documents approved: 1 of 4').compareDocumentPosition(list) &
            Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        expect(state.commands).toEqual([]);
      },
    );

    it('counts every required document as missing while the Action Center is empty', async () => {
      servePage();
      server.use(http.get('*/api/action-items', () => HttpResponse.json(emptyActionPage())));
      const { router } = renderRoute('/actions');
      expect(await screen.findByText('Nothing is waiting for your organization')).toBeVisible();

      await act(() => router.navigate(page));

      const summary = await expectDocumentSet('Documents approved: 0 of 4', [4, 0, 0, 0]);
      expect(summary.queryByText(COMPLETE)).not.toBeInTheDocument();
    });

    it('says all required documents are approved only when every latest file is', async () => {
      servePage({ documents: FOUR.map((type) => approved(presented(type))) });
      renderRoute(page);

      const summary = await expectDocumentSet('Documents approved: 4 of 4', [0, 0, 0, 4]);
      expect(summary.getByText(COMPLETE)).toBeVisible();
      expect(
        summary.getByText(/This does not mean the voyage is completed, payment is settled/),
      ).toBeVisible();
    });

    it('ignores other contracts, other revisions and types the revision does not require', async () => {
      servePage({
        instructions: [instructionsRequiring(['BILL_OF_LADING', 'CERTIFICATE_OF_ORIGIN'])],
        documents: [
          { ...approved(presented('BILL_OF_LADING')), contract: lacustraSellsToNordlys() },
          approved(presented('CERTIFICATE_OF_ORIGIN', 2)),
          approved(presented('WEIGHT_CERTIFICATE')),
        ],
      });
      renderRoute(page);

      await expectDocumentSet('Documents approved: 0 of 2', [2, 0, 0, 0]);
    });

    it('shows nothing before instructions are given', async () => {
      const state = servePage({ instructions: [] });
      renderRoute(page);

      expect(
        await screen.findByText(
          'The buyer has not given documentary instructions under this contract yet.',
        ),
      ).toBeVisible();
      await waitFor(() => {
        expect(state.documentRequests).toBeGreaterThan(0);
      });
      expect(summaries()).toEqual([]);
      expect(screen.queryByText(/Documents approved/)).not.toBeInTheDocument();
    });

    it('gives only the current revision a summary, and starts a new revision with its own set', async () => {
      const state = servePage({
        instructions: [instructionsRequiring(['BILL_OF_LADING'])],
        documents: [approved(presented('BILL_OF_LADING'))],
      });
      const { queryClient, user } = renderRoute(page);
      const before = await expectDocumentSet('Documents approved: 1 of 1', [0, 0, 0, 1]);
      expect(before.getByText(COMPLETE)).toBeVisible();

      // Claire revises: revision 2 requires the bill of lading and a phytosanitary certificate.
      state.instructions = [
        anInstruction({
          version: 2,
          currentRevision: revisionRequiring(['BILL_OF_LADING', 'PHYTOSANITARY_CERTIFICATE'], 2),
          previousRevisions: [revisionRequiring(['BILL_OF_LADING'])],
        }),
      ];
      await refreshInstructions(queryClient);

      const after = await expectDocumentSet('Documents approved: 0 of 2', [2, 0, 0, 0]);
      expect(after.queryByText(COMPLETE)).not.toBeInTheDocument();
      // Revision 1 keeps its record, as before, with no summary of its own.
      await user.click((await panel()).getByRole('button', { name: 'Earlier revisions (1)' }));
      const earlier = within(
        screen.getByRole('region', { name: 'Documents presented against revision 1' }),
      );
      expect(earlier.getByText(/^Approved by Claire Morel/)).toBeVisible();
      expect(summaries()).toHaveLength(1);
    });
  });

  describe('while documents load, fail and recover', () => {
    it('shows no counts while the documents are loading', async () => {
      const state = servePage({ documents: showcaseDocuments() });
      const { gate, release } = aGate();
      state.holdDocuments = gate;
      renderRoute(page);

      expect(await screen.findByLabelText('Loading documents')).toBeVisible();
      expect(summaries()).toEqual([]);
      expect(screen.queryByText(/Missing: /)).not.toBeInTheDocument();

      state.holdDocuments = null;
      release();
      await expectDocumentSet('Documents approved: 1 of 4', [1, 1, 1, 1]);
    });

    it('does not count unreadable documents as missing when the first read fails', async () => {
      const state = servePage();
      state.failDocuments = true;
      const { user } = renderRoute(page);

      expect(await screen.findByText('Documents could not be loaded')).toBeVisible();
      expect(summaries()).toEqual([]);
      expect(screen.queryByText(/Missing: /)).not.toBeInTheDocument();
      expect(screen.queryByText(/of 0/)).not.toBeInTheDocument();

      state.failDocuments = false;
      state.documents = FOUR.map((type) => approved(presented(type)));
      await user.click(screen.getByRole('button', { name: 'Retry' }));
      expect(
        (await expectDocumentSet('Documents approved: 4 of 4', [0, 0, 0, 4])).getByText(COMPLETE),
      ).toBeVisible();
    });

    it('keeps the counts on screen during a background refresh', async () => {
      const state = servePage({ documents: FOUR.map((type) => approved(presented(type))) });
      const { queryClient } = renderRoute(page);
      await expectDocumentSet('Documents approved: 4 of 4', [0, 0, 0, 4]);
      const { gate, release } = aGate();
      state.holdDocuments = gate;
      const requests = state.documentRequests;

      // Not awaited (nor wrapped in act): the read is held until released below.
      void queryClient.invalidateQueries({
        predicate: (query) => query.queryKey.at(-1) === 'documents',
      });
      await waitFor(() => {
        expect(state.documentRequests).toBe(requests + 1);
      });
      const during = await expectDocumentSet('Documents approved: 4 of 4', [0, 0, 0, 4]);
      expect(during.getByText(COMPLETE)).toBeVisible();
      expect(screen.queryByLabelText('Loading documents')).not.toBeInTheDocument();

      state.documents = [
        replacedBy(state.documents[0] as ContractDocument),
        ...state.documents.slice(1),
      ];
      state.holdDocuments = null;
      release();
      await expectDocumentSet('Documents approved: 3 of 4', [0, 1, 0, 3]);
    });

    it('marks the counts last known when a refresh fails, and claims completion only after a successful read', async () => {
      const state = servePage({ documents: FOUR.map((type) => approved(presented(type))) });
      const { queryClient, user } = renderRoute(page);
      await expectDocumentSet('Documents approved: 4 of 4', [0, 0, 0, 4]);

      state.failDocuments = true;
      await refreshDocuments(queryClient);

      expect(await screen.findByText('Documents could not be refreshed')).toBeVisible();
      const stale = await expectDocumentSet(
        'Documents approved: 4 of 4 (last known)',
        [0, 0, 0, 4],
      );
      expect(stale.queryByText(COMPLETE)).not.toBeInTheDocument();
      expect(stale.getByText(/^Last known counts/)).toBeVisible();

      state.failDocuments = false;
      await user.click(screen.getByRole('button', { name: 'Retry' }));

      const recovered = await expectDocumentSet('Documents approved: 4 of 4', [0, 0, 0, 4]);
      expect(recovered.getByText(COMPLETE)).toBeVisible();
      expect(recovered.queryByText(/^Last known counts/)).not.toBeInTheDocument();
      expect(screen.queryByText('Documents could not be refreshed')).not.toBeInTheDocument();
    });

    it('marks the counts last known when the instructions cannot be refreshed', async () => {
      const state = servePage({
        instructions: [instructionsRequiring(['BILL_OF_LADING'])],
        documents: [approved(presented('BILL_OF_LADING'))],
      });
      const { queryClient } = renderRoute(page);
      await expectDocumentSet('Documents approved: 1 of 1', [0, 0, 0, 1]);

      state.failInstructions = true;
      await refreshInstructions(queryClient);

      expect(
        await screen.findByText('Documentary instructions could not be refreshed'),
      ).toBeVisible();
      const stale = await expectDocumentSet(
        'Documents approved: 1 of 1 (last known)',
        [0, 0, 0, 1],
      );
      expect(stale.queryByText(COMPLETE)).not.toBeInTheDocument();

      state.failInstructions = false;
      await refreshInstructions(queryClient);
      expect(
        (await expectDocumentSet('Documents approved: 1 of 1', [0, 0, 0, 1])).getByText(COMPLETE),
      ).toBeVisible();
    });
  });

  describe('as documents change', () => {
    it('turns an approved document pending when it is replaced: the old approval does not survive', async () => {
      const first = approved(presented('BILL_OF_LADING'));
      const state = servePage({
        instructions: [instructionsRequiring(['BILL_OF_LADING'])],
        documents: [first],
      });
      const { queryClient } = renderRoute(page);
      expect(
        (await expectDocumentSet('Documents approved: 1 of 1', [0, 0, 0, 1])).getByText(COMPLETE),
      ).toBeVisible();

      state.documents = [replacedBy(first)];
      await refreshDocuments(queryClient);

      const after = await expectDocumentSet('Documents approved: 0 of 1', [0, 1, 0, 0]);
      expect(after.queryByText(COMPLETE)).not.toBeInTheDocument();
    });

    it('follows a rejection and a replacement, then the buyer’s own approval', async () => {
      const state = servePage({
        contract: asBuyer,
        instructions: [instructionsRequiring(['BILL_OF_LADING', 'CERTIFICATE_OF_ORIGIN'])],
        documents: [
          rejected(presented('BILL_OF_LADING')),
          approved(presented('CERTIFICATE_OF_ORIGIN')),
        ],
      });
      const { queryClient, user } = renderRoute(page, { signedInAs: claire });
      await expectDocumentSet('Documents approved: 1 of 2', [0, 0, 1, 1]);

      // Ana replaces the rejected bill of lading.
      const second = replacedBy(state.documents[0] as ContractDocument);
      state.documents = [second, state.documents[1] as ContractDocument];
      await refreshDocuments(queryClient);
      await expectDocumentSet('Documents approved: 1 of 2', [0, 1, 0, 1]);

      // Claire approves version 2 through the review form.
      const decided = approved(second);
      const sent: unknown[] = [];
      server.use(
        http.post(`${versionsPath('BILL_OF_LADING')}/2/review`, async ({ request }) => {
          sent.push(await request.json());
          state.documents = [decided, state.documents[1] as ContractDocument];
          return HttpResponse.json(
            { ...decided, contract: asBuyer },
            { headers: { ETag: `"${decided.version}"` } },
          );
        }),
      );
      const item = within((await panel()).getByRole('listitem', { name: 'Bill of lading' }));
      await user.click(item.getByRole('radio', { name: 'Approve' }));
      await user.click(item.getByRole('button', { name: 'Approve version 2' }));

      const after = await expectDocumentSet('Documents approved: 2 of 2', [0, 0, 0, 2]);
      expect(after.getByText(COMPLETE)).toBeVisible();
      expect(sent).toEqual([{ decision: 'APPROVED' }]);
    });
  });

  describe('over the live stream', () => {
    beforeEach(() => {
      FakeEventSource.reset();
      vi.stubGlobal('EventSource', FakeEventSource);
    });
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    async function theStream() {
      await waitFor(() => {
        expect(FakeEventSource.open()).toHaveLength(1);
      });
      const [source] = FakeEventSource.open();
      if (!source) throw new Error('No stream');
      act(() => {
        source.emit({ type: 'READY' });
      });
      return source;
    }

    const aPdf = (name: string) =>
      new File([new TextEncoder().encode('%PDF-1.7\n')], name, { type: 'application/pdf' });

    it("updates the seller's counts as files and decisions arrive, keeping a chosen file", async () => {
      const state = servePage({
        instructions: [instructionsRequiring(['BILL_OF_LADING', 'CERTIFICATE_OF_ORIGIN'])],
      });
      const { user } = renderRoute(page, { signedInAs: ana });
      const source = await theStream();
      await expectDocumentSet('Documents approved: 0 of 2', [2, 0, 0, 0]);
      const item = within((await panel()).getByRole('listitem', { name: 'Bill of lading' }));
      const input = item.getByLabelText('PDF file for the bill of lading');
      await user.upload(input, aPdf('bl-chosen.pdf'));

      // A colleague presents the certificate of origin; the buyer then approves it.
      state.documents = [presented('CERTIFICATE_OF_ORIGIN')];
      act(() => {
        source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
      });
      await expectDocumentSet('Documents approved: 0 of 2', [1, 1, 0, 0]);
      state.documents = [approved(presented('CERTIFICATE_OF_ORIGIN'))];
      act(() => {
        source.emit({ type: 'DOCUMENT_VERSION_REVIEWED' });
      });
      await expectDocumentSet('Documents approved: 1 of 2', [1, 0, 0, 1]);

      // The chosen file is still there, in the same input, ready to send; nothing was sent.
      expect(item.getByLabelText('PDF file for the bill of lading')).toBe(input);
      expect(item.getByText(/^bl-chosen\.pdf/)).toBeVisible();
      expect(item.getByRole('button', { name: 'Upload' })).toBeEnabled();
      expect(state.commands).toEqual([]);
    });

    it("updates the buyer's counts while a rejection is being drafted, keeping the draft", async () => {
      const state = servePage({
        contract: asBuyer,
        instructions: [instructionsRequiring(['BILL_OF_LADING', 'CERTIFICATE_OF_ORIGIN'])],
        documents: [presented('BILL_OF_LADING')],
      });
      const { user } = renderRoute(page, { signedInAs: claire });
      const source = await theStream();
      await expectDocumentSet('Documents approved: 0 of 2', [1, 1, 0, 0]);
      const item = within((await panel()).getByRole('listitem', { name: 'Bill of lading' }));
      await user.click(item.getByRole('radio', { name: 'Reject' }));
      const reason = item.getByRole('textbox', { name: /Reason for rejecting/ });
      await user.type(reason, REASON);

      state.documents = [presented('BILL_OF_LADING'), presented('CERTIFICATE_OF_ORIGIN')];
      act(() => {
        source.emit({ type: 'DOCUMENT_VERSION_UPLOADED' });
      });
      await expectDocumentSet('Documents approved: 0 of 2', [0, 2, 0, 0]);

      expect(item.getByRole('textbox', { name: /Reason for rejecting/ })).toBe(reason);
      expect(reason).toHaveValue(REASON);
      expect(item.getByRole('radio', { name: 'Reject' })).toBeChecked();
      expect(item.getByRole('button', { name: 'Reject version 1' })).toBeEnabled();
      expect(state.commands).toEqual([]);
    });
  });
});
