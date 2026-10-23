import { act, screen, waitFor, within } from '@testing-library/react';
import type {
  ContractDocument,
  CounterpartyContract,
  CurrentUser,
  DocumentaryInstruction,
  DocumentVersionTarget,
  Notice,
} from '@tradeflow/contracts';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { describe, expect, it } from 'vitest';
import { actionPage, aReviewAction } from '../../../test/fixtures/action-items';
import { aCurrentUser, anotherUser } from '../../../test/fixtures/auth';
import {
  acknowledgedRevision,
  aRevision,
  anInstruction,
} from '../../../test/fixtures/documentary-instructions';
import { aDocument, replacedBy, reviewedAs } from '../../../test/fixtures/documents';
import {
  acknowledged,
  aCounterpartyContract,
  aNotice,
  claire as claireActor,
  lacustraSellsToNordlys,
} from '../../../test/fixtures/notices';
import { emptyTimeline } from '../../../test/fixtures/timeline';
import { aTradeString, aVoyageDetail } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { recordLinkPath, type RecordTarget } from '../navigation/record-link';

const voyage = aVoyageDetail();

/** Ana operates for Cerrado, the seller under contract 1. */
const ana = aCurrentUser();
/** Claire operates for Lacustra, the buyer under contract 1. */
const claire = anotherUser();
const claireAsViewer: CurrentUser = { ...claire, user: { ...claire.user, role: 'VIEWER' } };

const asSeller = aCounterpartyContract();
const asBuyer = aCounterpartyContract({ side: 'BUYER' });

const REASON = 'The consignee does not match the instructions.';

type Resource = 'voyage' | 'contracts' | 'notices' | 'instructions' | 'documents';

interface PageState {
  contracts: CounterpartyContract[];
  notices: Notice[];
  instructions: DocumentaryInstruction[];
  documents: ContractDocument[];
  /** Resources that answer 500 until removed. */
  failing: Set<Resource>;
  requests: Record<Resource, number>;
  /** Every write that reached the API. Opening a link must never send one. */
  commands: string[];
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
    async pass() {
      arrive();
      await opened;
    },
  };
}

/**
 * Serves the details page from the state returned, which tests may change: every read answers
 * what it holds then. With `hold`, that resource's first answer waits for the gate.
 */
function servePage(
  initial: Partial<Pick<PageState, 'contracts' | 'notices' | 'instructions' | 'documents'>>,
  { hold }: { hold?: { resource: Resource; gate: ReturnType<typeof aGate> } } = {},
): PageState {
  const state: PageState = {
    contracts: [asBuyer],
    notices: [],
    instructions: [],
    documents: [],
    failing: new Set(),
    requests: { voyage: 0, contracts: 0, notices: 0, instructions: 0, documents: 0 },
    commands: [],
    ...initial,
  };
  const serve = (resource: Resource, body: () => JsonBodyType) => async () => {
    state.requests[resource] += 1;
    if (hold?.resource === resource && state.requests[resource] === 1) await hold.gate.pass();
    if (state.failing.has(resource)) return problemResponse(500, 'Boom');
    return HttpResponse.json(body());
  };
  const recordCommand = ({ request }: { request: Request }) => {
    state.commands.push(`${request.method} ${new URL(request.url).pathname}`);
    return problemResponse(500, 'No command is expected.');
  };
  server.use(
    http.get(
      `*/api/voyages/${voyage.id}`,
      serve('voyage', () => voyage),
    ),
    http.get(`*/api/voyages/${voyage.id}/trade-string`, () => HttpResponse.json(aTradeString())),
    http.get(
      `*/api/voyages/${voyage.id}/my-contracts`,
      serve('contracts', () => ({ items: state.contracts })),
    ),
    http.get(
      `*/api/voyages/${voyage.id}/notices`,
      serve('notices', () => ({ items: state.notices })),
    ),
    http.get(
      `*/api/voyages/${voyage.id}/documentary-instructions`,
      serve('instructions', () => ({ items: state.instructions })),
    ),
    http.get(
      `*/api/voyages/${voyage.id}/documents`,
      serve('documents', () => ({ items: state.documents })),
    ),
    http.get(`*/api/voyages/${voyage.id}/timeline`, () => HttpResponse.json(emptyTimeline)),
    http.post('*/api/*', recordCommand),
    http.put('*/api/*', recordCommand),
  );
  return state;
}

const noticeLink = (notice: Notice, contractId = notice.contract.id) =>
  recordLinkPath({ kind: 'NOTICE', voyageId: voyage.id, contractId, noticeId: notice.id });

const revisionLink = (instruction: DocumentaryInstruction, revisionNumber: number) =>
  recordLinkPath({
    kind: 'INSTRUCTION_REVISION',
    voyageId: voyage.id,
    contractId: instruction.contract.id,
    instructionId: instruction.id,
    revisionNumber,
  });

const documentTarget = (
  document: ContractDocument,
  versionNumber: number,
  overrides: Partial<DocumentVersionTarget> = {},
): RecordTarget => ({
  kind: 'DOCUMENT_VERSION',
  voyageId: voyage.id,
  contractId: document.contract.id,
  revisionNumber: document.revisionNumber,
  documentType: document.documentType,
  documentId: document.id,
  versionNumber,
  ...overrides,
});

const documentLink = (document: ContractDocument, versionNumber: number) =>
  recordLinkPath(documentTarget(document, versionNumber));

const linkedStatus = () => screen.findByRole('status', { name: 'Linked record' });

/** The instructions under contract 1, from `contract`'s side, at revision `current`. */
function instructionsAt(contract: CounterpartyContract, current: number): DocumentaryInstruction {
  const revisions = Array.from({ length: current }, (_, index) =>
    aRevision({ number: current - index }),
  );
  return anInstruction({
    contract,
    version: current,
    currentRevision: revisions[0] ?? aRevision(),
    previousRevisions: revisions.slice(1),
  });
}

const forBuyer = (document: ContractDocument): ContractDocument => ({
  ...document,
  contract: asBuyer,
});

const ackNoticeButton = () => screen.queryByRole('button', { name: 'Acknowledge receipt' });

describe('Opening a record link on the voyage page', () => {
  describe('ETA notices', () => {
    const notice = aNotice({ contract: asBuyer });

    it('locates the notice once what it needs has loaded, then focuses it, sending nothing', async () => {
      const gate = aGate();
      const state = servePage({ notices: [notice] }, { hold: { resource: 'notices', gate } });
      renderRoute(noticeLink(notice), { signedInAs: claire });

      await gate.received;
      expect(await screen.findByText('Finding the linked record…')).toBeInTheDocument();
      expect(document.getElementById('linked-record')).toBeNull();
      expect(document.body).toHaveFocus();
      gate.release();

      const status = await linkedStatus();
      expect(status).toHaveTextContent(
        'This ETA notice is waiting for your organization to acknowledge receipt' +
          'Acknowledge by 20 Oct 2030, 12:00 GMT-3.',
      );
      const item = screen.getByRole('listitem', { name: 'ETA notice, contract 1' });
      await waitFor(() => {
        expect(item).toHaveFocus();
      });
      expect(item).toHaveAccessibleDescription(/waiting for your organization/);
      // The command stays where it was, for the user to choose.
      expect(ackNoticeButton()).toBeEnabled();
      expect(state.commands).toEqual([]);
    });

    it('says when the deadline has passed', async () => {
      servePage({ notices: [{ ...notice, overdue: true }] });
      renderRoute(noticeLink(notice), { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(
        'Acknowledge by 20 Oct 2030, 12:00 GMT-3: the deadline has passed.',
      );
    });

    it('shows a notice acknowledged since, with nothing waiting on it', async () => {
      const state = servePage({
        notices: [acknowledged(notice, claireActor, '2030-10-16T13:30:00.000Z')],
      });
      renderRoute(noticeLink(notice), { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(
        'This ETA notice has already been acknowledged' +
          'Claire Morel (Lacustra Commodities SA) acknowledged receipt on 16 Oct 2030, 10:30 GMT-3. ' +
          'Nothing is waiting on it any more.',
      );
      await waitFor(() => {
        expect(screen.getByRole('listitem', { name: 'ETA notice, contract 1' })).toHaveFocus();
      });
      expect(ackNoticeButton()).not.toBeInTheDocument();
      expect(state.commands).toEqual([]);
    });

    it('lets a viewer open it, and offers no command', async () => {
      const state = servePage({ notices: [notice] });
      renderRoute(noticeLink(notice), { signedInAs: claireAsViewer });

      await waitFor(() => {
        expect(screen.getByRole('listitem', { name: 'ETA notice, contract 1' })).toHaveFocus();
      });
      expect(ackNoticeButton()).not.toBeInTheDocument();
      expect(
        screen.getByText('An operator in your organization can acknowledge receipt.'),
      ).toBeInTheDocument();
      expect(state.commands).toEqual([]);
    });
  });

  describe('documentary instructions', () => {
    it('focuses the current revision, waiting for the seller', async () => {
      const instruction = instructionsAt(asSeller, 1);
      const state = servePage({ contracts: [asSeller], instructions: [instruction] });
      renderRoute(revisionLink(instruction, 1), { signedInAs: ana });

      expect(await linkedStatus()).toHaveTextContent(
        'Revision 1 is waiting for your organization to acknowledge receipt',
      );
      await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Revision 1' })).toHaveFocus();
      });
      expect(
        screen.getByRole('button', { name: 'Acknowledge receipt of revision 1' }),
      ).toBeEnabled();
      expect(state.commands).toEqual([]);
    });

    it('opens a superseded revision as history, and leaves the current one alone', async () => {
      const instruction = instructionsAt(asSeller, 2);
      const state = servePage({ contracts: [asSeller], instructions: [instruction] });
      renderRoute(revisionLink(instruction, 1), { signedInAs: ana });

      expect(await linkedStatus()).toHaveTextContent(
        'Revision 1 has been superseded' +
          'Revision 2 of these documentary instructions is now in force. Revision 1 is shown ' +
          'below as history, read-only: it can no longer be acknowledged, so nothing is waiting on it.',
      );
      const history = screen.getByRole('button', { name: 'Earlier revisions (1)' });
      expect(history).toHaveAttribute('aria-expanded', 'true');
      const earlier = screen.getByRole('region', { name: 'Revision 1' });
      await waitFor(() => {
        expect(earlier).toHaveFocus();
      });
      expect(earlier).toBeVisible();
      expect(screen.getByRole('region', { name: 'Revision 2' })).not.toHaveFocus();
      // The only command is for the revision in force, and nobody pressed it.
      expect(
        screen.getByRole('button', { name: 'Acknowledge receipt of revision 2' }),
      ).toBeEnabled();
      expect(
        screen.queryByRole('button', { name: 'Acknowledge receipt of revision 1' }),
      ).not.toBeInTheDocument();
      expect(state.commands).toEqual([]);
    });

    it('says when the current revision has been acknowledged since', async () => {
      const instruction = instructionsAt(asSeller, 1);
      servePage({
        contracts: [asSeller],
        instructions: [
          {
            ...instruction,
            version: 2,
            currentRevision: {
              ...instruction.currentRevision,
              acknowledgement: {
                acknowledgedAt: '2030-10-16T13:30:00.000Z',
                acknowledgedBy: { name: 'Ana Souza', organization: asSeller.seller },
              },
            },
          },
        ],
      });
      renderRoute(revisionLink(instruction, 1), { signedInAs: ana });

      expect(await linkedStatus()).toHaveTextContent(
        'Revision 1 has already been acknowledged' +
          'Ana Souza (Cerrado Grãos Exportadora S.A.) acknowledged receipt on 16 Oct 2030, 10:30 GMT-3.',
      );
      expect(
        screen.queryByRole('button', { name: /Acknowledge receipt of revision/ }),
      ).not.toBeInTheDocument();
    });
  });

  describe('documents', () => {
    it('focuses the exact file awaiting a decision, without starting one', async () => {
      const document = forBuyer(replacedBy(aDocument()));
      const state = servePage({
        instructions: [instructionsAt(asBuyer, 1)],
        documents: [document],
      });
      renderRoute(documentLink(document, 2), { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(
        'Version 2 of the bill of lading is waiting for your organization’s decision',
      );
      await waitFor(() => {
        expect(
          screen.getByRole('group', { name: 'Version 2 of the bill of lading' }),
        ).toHaveFocus();
      });
      const form = screen.getByRole('form', { name: 'Review version 2 of the bill of lading' });
      expect(within(form).getByRole('radio', { name: 'Approve' })).not.toBeChecked();
      expect(within(form).getByRole('radio', { name: 'Reject' })).not.toBeChecked();
      // History stays folded: the linked file is the latest.
      expect(screen.getByRole('button', { name: 'Earlier versions (1)' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(state.commands).toEqual([]);
    });

    it('opens a replaced file as history, and never moves the decision onto the newer file', async () => {
      // Version 1 was rejected, then replaced: the buyer's link to version 1 is history now.
      const document = forBuyer(
        replacedBy(reviewedAs(aDocument(), { decision: 'REJECTED', reason: REASON })),
      );
      const state = servePage({
        instructions: [instructionsAt(asBuyer, 1)],
        documents: [document],
      });
      renderRoute(documentLink(document, 1), { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(
        'Version 1 of the bill of lading has been replaced' +
          'Version 2 is now the latest file. Version 1 is shown below as history, read-only, and ' +
          'nothing is waiting on it. It was rejected by Claire Morel (Lacustra Commodities SA) on ' +
          '16 Oct 2030, 12:00 GMT-3. A decision or a replacement applies only to version 2.',
      );
      expect(screen.getByRole('button', { name: 'Earlier versions (1)' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      const historical = screen.getByRole('group', { name: 'Version 1 of the bill of lading' });
      await waitFor(() => {
        expect(historical).toHaveFocus();
      });
      expect(within(historical).getByText(REASON)).toBeInTheDocument();
      // Nothing decides on version 1, and nothing has been chosen for version 2.
      expect(
        screen.queryByRole('form', { name: 'Review version 1 of the bill of lading' }),
      ).not.toBeInTheDocument();
      const form = screen.getByRole('form', { name: 'Review version 2 of the bill of lading' });
      expect(within(form).getByRole('radio', { name: 'Approve' })).not.toBeChecked();
      expect(within(form).getByRole('radio', { name: 'Reject' })).not.toBeChecked();
      expect(state.commands).toEqual([]);
    });

    it('opens a document of a superseded revision as history, with nothing to decide', async () => {
      const document = forBuyer(aDocument());
      const state = servePage({
        instructions: [instructionsAt(asBuyer, 2)],
        documents: [document],
      });
      renderRoute(documentLink(document, 1), { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(
        'Revision 1 has been superseded' +
          'Version 1 of the bill of lading was presented against revision 1 of the documentary ' +
          'instructions; revision 2 is now in force. It is shown below as history, read-only, and ' +
          'nothing is waiting on it. It was never reviewed.',
      );
      expect(screen.getByRole('button', { name: 'Earlier revisions (1)' })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
      await waitFor(() => {
        expect(
          screen.getByRole('group', { name: 'Version 1 of the bill of lading' }),
        ).toHaveFocus();
      });
      expect(screen.queryByRole('form', { name: /^Review version/ })).not.toBeInTheDocument();
      expect(state.commands).toEqual([]);
    });

    it('tells the seller a rejected file is waiting for its replacement', async () => {
      const document = reviewedAs(aDocument(), { decision: 'REJECTED', reason: REASON });
      const state = servePage({
        contracts: [asSeller],
        instructions: [instructionsAt(asSeller, 1)],
        documents: [document],
      });
      renderRoute(documentLink(document, 1), { signedInAs: ana });

      expect(await linkedStatus()).toHaveTextContent(
        'Version 1 of the bill of lading was rejected and is waiting for your organization to replace it',
      );
      const version = screen.getByRole('group', { name: 'Version 1 of the bill of lading' });
      await waitFor(() => {
        expect(version).toHaveFocus();
      });
      expect(within(version).getByText(REASON)).toBeInTheDocument();
      expect(state.commands).toEqual([]);
    });

    it.each([
      ['approved', { decision: 'APPROVED' as const, reason: null }, 'has already been approved'],
      ['rejected', { decision: 'REJECTED' as const, reason: REASON }, 'has already been rejected'],
    ])('tells the buyer a file %s since needs nothing from it', async (_case, review, title) => {
      const document = forBuyer(reviewedAs(aDocument(), review));
      servePage({ instructions: [instructionsAt(asBuyer, 1)], documents: [document] });
      renderRoute(documentLink(document, 1), { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(`Version 1 of the bill of lading ${title}`);
      expect(screen.queryByRole('form', { name: /^Review version/ })).not.toBeInTheDocument();
    });

    it('lets a viewer open it, and offers no decision', async () => {
      const document = forBuyer(aDocument());
      const state = servePage({
        instructions: [instructionsAt(asBuyer, 1)],
        documents: [document],
      });
      renderRoute(documentLink(document, 1), { signedInAs: claireAsViewer });

      await waitFor(() => {
        expect(
          screen.getByRole('group', { name: 'Version 1 of the bill of lading' }),
        ).toHaveFocus();
      });
      expect(screen.queryByRole('form', { name: /^Review version/ })).not.toBeInTheDocument();
      expect(
        screen.getByText('An operator in your organization can approve or reject it.'),
      ).toBeInTheDocument();
      expect(state.commands).toEqual([]);
    });
  });

  describe('links that name nothing the organization can open', () => {
    const notice = aNotice({ contract: asBuyer });
    const bill = forBuyer(replacedBy(aDocument()));
    const otherContract = { ...lacustraSellsToNordlys() };
    const instruction = instructionsAt(asBuyer, 1);

    it.each([
      [
        'a notice that does not exist',
        recordLinkPath({
          kind: 'NOTICE',
          voyageId: voyage.id,
          contractId: asBuyer.id,
          noticeId: '01990000-0000-7000-8009-000000000099',
        }),
      ],
      ['a notice under another of its contracts', noticeLink(notice, otherContract.id)],
      [
        'a contract the organization is not party to',
        noticeLink(notice, '01990000-0000-7000-8008-000000000199'),
      ],
      [
        'an instruction that is not the contract’s',
        recordLinkPath({
          kind: 'INSTRUCTION_REVISION',
          voyageId: voyage.id,
          contractId: asBuyer.id,
          instructionId: '01990000-0000-7000-800a-000000000099',
          revisionNumber: 1,
        }),
      ],
      ['a revision that does not exist', revisionLink(instruction, 3)],
      [
        'a document of another type',
        recordLinkPath(documentTarget(bill, 2, { documentType: 'COMMERCIAL_INVOICE' })),
      ],
      [
        'a document of another revision',
        recordLinkPath(documentTarget(bill, 2, { revisionNumber: 2 })),
      ],
      ['a file version that does not exist', documentLink(bill, 3)],
    ])('says it cannot find %s, and opens nothing in its place', async (_case, link) => {
      const state = servePage({
        contracts: [asBuyer, otherContract],
        notices: [notice],
        instructions: [instruction],
        documents: [bill],
      });
      renderRoute(link, { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(
        'The linked record cannot be found' +
          'It is not on this voyage, or your organization cannot see it. ' +
          'Nothing has been opened or changed.',
      );
      expect(document.getElementById('linked-record')).toBeNull();
      expect(screen.getByRole('button', { name: 'Earlier versions (1)' })).toHaveAttribute(
        'aria-expanded',
        'false',
      );
      expect(document.body).toHaveFocus();
      expect(state.commands).toEqual([]);
    });

    it.each([
      [
        'an id that is not a UUID',
        `/voyages/${voyage.id}?open=notice&contract=${asBuyer.id}&notice=42`,
      ],
      ['an unknown kind of record', `/voyages/${voyage.id}?open=invoice&contract=${asBuyer.id}`],
      ['a missing kind', `/voyages/${voyage.id}?notice=${notice.id}`],
    ])('says a link with %s is not valid, and shows the voyage as usual', async (_case, link) => {
      const state = servePage({ notices: [notice] });
      renderRoute(link, { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(
        'This link is not valid' +
          'Part of it is missing or malformed, so it does not name a record. ' +
          'Nothing has been opened or changed.',
      );
      expect(
        await screen.findByRole('listitem', { name: 'ETA notice, contract 1' }),
      ).toBeInTheDocument();
      expect(document.getElementById('linked-record')).toBeNull();
      expect(state.commands).toEqual([]);
    });

    it('shows a voyage the organization cannot see as not found, whatever the link names', async () => {
      server.use(
        http.get(`*/api/voyages/${voyage.id}`, () => problemResponse(404, 'Voyage not found.')),
        http.get(`*/api/voyages/${voyage.id}/*`, () => problemResponse(404, 'Voyage not found.')),
      );
      renderRoute(noticeLink(notice), { signedInAs: claire });

      expect(await screen.findByRole('heading', { name: 'Voyage not found' })).toBeVisible();
      expect(screen.queryByRole('status', { name: 'Linked record' })).not.toBeInTheDocument();
    });

    it('waits for a section that failed, then finds the record once it is retried', async () => {
      const state = servePage({ notices: [notice] });
      state.failing.add('notices');
      const { user } = renderRoute(noticeLink(notice), { signedInAs: claire });

      expect(await linkedStatus()).toHaveTextContent(
        'The linked record cannot be shown yet' +
          'Part of this voyage could not be loaded. Retry in the section below.',
      );
      expect(document.getElementById('linked-record')).toBeNull();

      state.failing.delete('notices');
      const failure = screen
        .getAllByRole('alert')
        .find((alert) => alert.textContent.includes('Notices could not be loaded'));
      if (!failure) throw new Error('The notices card should report its failure');
      await user.click(within(failure).getByRole('button', { name: 'Retry' }));

      expect(await linkedStatus()).toHaveTextContent('waiting for your organization');
      await waitFor(() => {
        expect(screen.getByRole('listitem', { name: 'ETA notice, contract 1' })).toHaveFocus();
      });
      expect(state.commands).toEqual([]);
    });
  });

  describe('focus', () => {
    it('moves once per link: a refresh leaves the user, and their draft, where they are', async () => {
      const document = forBuyer(aDocument());
      const notice = aNotice({ contract: asBuyer });
      const state = servePage({
        notices: [notice],
        instructions: [instructionsAt(asBuyer, 1)],
        documents: [document],
      });
      const { user, queryClient, router } = renderRoute(documentLink(document, 1), {
        signedInAs: claire,
      });

      const version = await screen.findByRole('group', { name: 'Version 1 of the bill of lading' });
      await waitFor(() => {
        expect(version).toHaveFocus();
      });

      // The user starts a decision; the page is then refreshed in the background.
      const form = screen.getByRole('form', { name: 'Review version 1 of the bill of lading' });
      await user.click(within(form).getByRole('radio', { name: 'Reject' }));
      const reason = within(form).getByRole('textbox', { name: /Reason for rejecting/ });
      await user.type(reason, REASON);
      // The refresh brings something new (a second notice), so the page renders again.
      state.notices = [
        notice,
        aNotice({ id: '01990000-0000-7000-8009-000000000002', contract: asBuyer }),
      ];
      await act(() => queryClient.invalidateQueries({ queryKey: ['protected'] }));
      await waitFor(() => {
        expect(screen.getAllByRole('listitem', { name: 'ETA notice, contract 1' })).toHaveLength(2);
      });

      expect(reason).toHaveFocus();
      expect(reason).toHaveValue(REASON);
      expect(within(form).getByRole('radio', { name: 'Reject' })).toBeChecked();

      // On request, focus goes back to the record.
      await user.click(screen.getByRole('button', { name: 'Show it' }));
      expect(version).toHaveFocus();
      expect(reason).toHaveValue(REASON);

      // Another link on the same page is another request: focus follows it, the draft stays.
      await act(() => router.navigate(noticeLink(notice)));
      await waitFor(() => {
        // The notice the link names, not the one that arrived since.
        expect(
          screen.getAllByRole('listitem', { name: 'ETA notice, contract 1' })[0],
        ).toHaveFocus();
      });
      expect(
        within(
          screen.getByRole('form', { name: 'Review version 1 of the bill of lading' }),
        ).getByRole('textbox', { name: /Reason for rejecting/ }),
      ).toHaveValue(REASON);
      expect(state.commands).toEqual([]);
    });

    it('lets the user fold the history again; a refresh does not reopen it', async () => {
      const instruction = instructionsAt(asSeller, 2);
      const state = servePage({ contracts: [asSeller], instructions: [instruction] });
      const { user, queryClient } = renderRoute(revisionLink(instruction, 1), { signedInAs: ana });

      const history = await screen.findByRole('button', { name: 'Earlier revisions (1)' });
      await waitFor(() => {
        expect(history).toHaveAttribute('aria-expanded', 'true');
      });
      await user.click(history);
      expect(history).toHaveAttribute('aria-expanded', 'false');

      // The refresh brings something new (revision 2 acknowledged), so the page renders again.
      state.instructions = [
        {
          ...instruction,
          version: 3,
          currentRevision: acknowledgedRevision(instruction.currentRevision),
        },
      ];
      await act(() => queryClient.invalidateQueries({ queryKey: ['protected'] }));
      await waitFor(() => {
        expect(screen.getByRole('region', { name: 'Revision 2' })).toHaveTextContent(
          'Acknowledged by the seller',
        );
      });
      expect(history).toHaveAttribute('aria-expanded', 'false');
      expect(history).toHaveFocus();
    });
  });

  it('is where an item of the Action Center leads', async () => {
    const review = aReviewAction();
    const document = forBuyer(replacedBy(aDocument()));
    server.use(http.get('*/api/action-items', () => HttpResponse.json(actionPage([review]))));
    const state = servePage({ instructions: [instructionsAt(asBuyer, 1)], documents: [document] });
    const { user, router } = renderRoute('/actions', { signedInAs: claire });

    await user.click(
      await screen.findByRole('link', { name: 'Open version 2 on TF-2026-0001, contract 1' }),
    );

    expect(router.state.location.pathname).toBe(`/voyages/${voyage.id}`);
    await waitFor(() => {
      expect(screen.getByRole('group', { name: 'Version 2 of the bill of lading' })).toHaveFocus();
    });
    expect(await linkedStatus()).toHaveTextContent(
      'Version 2 of the bill of lading is waiting for your organization’s decision',
    );
    expect(state.commands).toEqual([]);
  });
});
