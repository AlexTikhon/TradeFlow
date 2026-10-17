import { screen, waitFor, within } from '@testing-library/react';
import type {
  CounterpartyContractListResponse,
  DocumentaryInstruction,
  DocumentaryInstructionContent,
  ProblemDetails,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { aCurrentUser, anotherUser } from '../../../test/fixtures/auth';
import {
  acknowledgedRevision,
  anaAcknowledges,
  anInstruction,
  aRevision,
} from '../../../test/fixtures/documentary-instructions';
import { aCounterpartyContract, contractList } from '../../../test/fixtures/notices';
import { aTradeString, aVoyageDetail } from '../../../test/fixtures/voyages';
import { emptyTimeline } from '../../../test/fixtures/timeline';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from '../../auth/session-sync';

const voyage = aVoyageDetail();
const page = `/voyages/${voyage.id}`;

/** Ana operates for Cerrado, the seller under contract 1: she acknowledges. */
const ana = aCurrentUser();
const anaAsViewer = aCurrentUser({ user: { ...ana.user, role: 'VIEWER' } });
/** Claire operates for Lacustra, the buyer under contract 1: she gives the instructions. */
const claire = anotherUser();
const claireAsViewer = anotherUser();
claireAsViewer.user = { ...claire.user, role: 'VIEWER' };

const asSeller = aCounterpartyContract();
const asBuyer = aCounterpartyContract({ side: 'BUYER' });
const contractName = 'Contract 1 · Cerrado Grãos Exportadora S.A. → Lacustra Commodities SA';
const instructionPath = `/contracts/${asSeller.id}/documentary-instructions`;

/** The instructions as the buyer sees them. */
const forBuyer = (instruction: DocumentaryInstruction = anInstruction()) => ({
  ...instruction,
  contract: asBuyer,
});

/**
 * Serves the details page. `instructions` is the fake server's state: tests and command handlers
 * change it, and every list request answers what it holds at that moment.
 */
function servePage({
  contracts = contractList(asSeller),
  instructions = [] as DocumentaryInstruction[],
  listResponse,
}: {
  contracts?: CounterpartyContractListResponse;
  instructions?: DocumentaryInstruction[];
  listResponse?: () => Response | undefined;
} = {}) {
  const state = { instructions, listRequests: 0 };
  server.use(
    http.get(`*/api/voyages/${voyage.id}`, () => HttpResponse.json(voyage)),
    http.get(`*/api/voyages/${voyage.id}/trade-string`, () => HttpResponse.json(aTradeString())),
    http.get(`*/api/voyages/${voyage.id}/my-contracts`, () => HttpResponse.json(contracts)),
    http.get(`*/api/voyages/${voyage.id}/notices`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${voyage.id}/documentary-instructions`, () => {
      state.listRequests += 1;
      return listResponse?.() ?? HttpResponse.json({ items: state.instructions });
    }),
    // Documents presented against the revisions have their own tests.
    http.get(`*/api/voyages/${voyage.id}/timeline`, () => HttpResponse.json(emptyTimeline)),
    http.get(`*/api/voyages/${voyage.id}/documents`, () => HttpResponse.json({ items: [] })),
  );
  return state;
}

interface Sent {
  body: unknown;
  ifMatch: string | null;
  ifNoneMatch: string | null;
}

/**
 * Serves one command with `respond`, recording each request's body and preconditions. With
 * `hold`, responses wait for `release()`, so a test can change who is signed in meanwhile.
 */
function serveCommand(
  method: 'put' | 'post',
  path: string,
  respond: () => Response,
  { hold = false } = {},
) {
  const sent: Sent[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  server.use(
    http[method](`*/api/voyages/${voyage.id}${path}`, async ({ request }) => {
      sent.push({
        body: await request.json(),
        ifMatch: request.headers.get('if-match'),
        ifNoneMatch: request.headers.get('if-none-match'),
      });
      arrived();
      if (hold) await gate;
      return respond();
    }),
  );
  return { sent, received, release };
}

const servePut = (respond: () => Response, options?: { hold?: boolean }) =>
  serveCommand('put', instructionPath, respond, options);
const serveAcknowledgement = (
  revision: number,
  respond: () => Response,
  options?: { hold?: boolean },
) =>
  serveCommand(
    'post',
    `${instructionPath}/revisions/${revision}/acknowledgement`,
    respond,
    options,
  );

function validationProblem(errors: ProblemDetails['errors']) {
  const problem: ProblemDetails = {
    type: '/problems/validation-failed',
    title: 'Request validation failed',
    status: 400,
    detail: 'The request is invalid.',
    errors,
  };
  return HttpResponse.json(problem, {
    status: 400,
    headers: { 'Content-Type': 'application/problem+json' },
  });
}

const preconditionFailed = () =>
  HttpResponse.json(
    {
      type: 'about:blank',
      title: 'Precondition Failed',
      status: 412,
      detail: 'The documentary instructions have changed since the version you sent.',
    } satisfies ProblemDetails,
    { status: 412, headers: { 'Content-Type': 'application/problem+json' } },
  );

type Rendered = ReturnType<typeof renderRoute>;
type User = Rendered['user'];

/** The panel for contract 1. */
const contractPanel = async () =>
  within(await screen.findByRole('listitem', { name: contractName }));

async function openForm(
  user: User,
  button: 'Give documentary instructions' | 'Revise instructions',
) {
  const panel = await contractPanel();
  await user.click(await panel.findByRole('button', { name: button }));
  return within(
    panel.getByRole('form', {
      name: button === 'Revise instructions' ? 'Revise documentary instructions' : button,
    }),
  );
}

type Form = Awaited<ReturnType<typeof openForm>>;

const rows = (form: Form) =>
  within(form.getByRole('list', { name: 'Required documents' })).getAllByRole('listitem');

async function fillRow(
  user: User,
  form: Form,
  index: number,
  { document, originals, copies }: { document: string; originals: string; copies: string },
) {
  const row = within(rows(form)[index] as HTMLElement);
  await user.selectOptions(row.getByLabelText('Document'), document);
  await user.clear(row.getByLabelText('Originals'));
  if (originals) await user.type(row.getByLabelText('Originals'), originals);
  await user.clear(row.getByLabelText('Copies'));
  if (copies) await user.type(row.getByLabelText('Copies'), copies);
}

const firstContent: DocumentaryInstructionContent = {
  consignee: 'To order of Banco Exemplo S.A.',
  notifyParty: 'Lacustra Commodities SA',
  requirements: [
    { document: 'BILL_OF_LADING', originals: 3, copies: 3 },
    { document: 'CERTIFICATE_OF_ORIGIN', originals: 1, copies: 0 },
  ],
};

/** Fills a fresh form with `firstContent`. */
async function fillFirstContent(user: User, form: Form) {
  await user.click(form.getByLabelText(/Consignee/));
  await user.paste(firstContent.consignee);
  await user.click(form.getByLabelText(/Notify party/));
  await user.paste(firstContent.notifyParty ?? '');
  await fillRow(user, form, 0, { document: 'Bill of lading', originals: '3', copies: '3' });
  await user.click(form.getByRole('button', { name: 'Add a document' }));
  await fillRow(user, form, 1, { document: 'Certificate of origin', originals: '1', copies: '0' });
}

const protectedQueries = (queryClient: Rendered['queryClient']) =>
  queryClient.getQueryCache().findAll({ queryKey: ['protected'] });

const settledMutations = (queryClient: Rendered['queryClient']) =>
  queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status !== 'pending');

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

/** Revision 2 given by a colleague of Claire's while Claire was editing. */
const revisedByColleague = (base: DocumentaryInstruction) =>
  forBuyer({
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

describe('Documentary instructions on the voyage page', () => {
  describe('reading', () => {
    it('shows the seller the current revision, its documents, and earlier revisions', async () => {
      const first = acknowledgedRevision(aRevision({ consignee: 'To order' }));
      servePage({
        instructions: [
          anInstruction({
            version: 3,
            currentRevision: aRevision({ number: 2, createdAt: '2030-10-16T15:00:00.000Z' }),
            previousRevisions: [first],
          }),
        ],
      });
      const { user } = renderRoute(page, { signedInAs: anaAsViewer });

      const panel = await contractPanel();
      expect(panel.getByText('You sell: you receive them')).toBeVisible();
      const current = within(panel.getByRole('region', { name: 'Revision 2' }));
      expect(current.getByRole('heading', { name: 'Revision 2 (current)' })).toBeVisible();
      expect(current.getByText('Not acknowledged')).toBeVisible();
      expect(current.getByText('To order of Banco Exemplo S.A.')).toBeVisible();
      expect(
        current.getByText('16 Oct 2030, 12:00 GMT-3 by Claire Morel (Lacustra Commodities SA)'),
      ).toBeVisible();
      const table = current.getByRole('table', { name: 'Documents required in revision 2' });
      expect(
        within(table)
          .getAllByRole('row')
          .map((row) => row.textContent),
      ).toEqual(['DocumentOriginalsCopies', 'Bill of lading33', 'Phytosanitary certificate10']);

      await user.click(panel.getByRole('button', { name: 'Earlier revisions (1)' }));
      const earlier = within(await panel.findByRole('region', { name: 'Revision 1' }));
      expect(earlier.getByText('Acknowledged by the seller')).toBeVisible();
      expect(earlier.getByText('To order')).toBeVisible();
      expect(
        earlier.getByText('16 Oct 2030, 10:30 GMT-3 by Ana Souza (Cerrado Grãos Exportadora S.A.)'),
      ).toBeVisible();

      // A viewer of the seller is told who can acknowledge, and offered nothing.
      expect(
        panel.getByText('An operator in your organization can acknowledge receipt.'),
      ).toBeVisible();
      expect(panel.queryByRole('button', { name: /Acknowledge receipt/ })).not.toBeInTheDocument();
      expect(panel.queryByRole('button', { name: 'Revise instructions' })).not.toBeInTheDocument();
    });

    it('offers nothing to write to a viewer of the buyer', async () => {
      servePage({ contracts: contractList(asBuyer) });
      renderRoute(page, { signedInAs: claireAsViewer });

      const panel = await contractPanel();
      expect(
        panel.getByText(
          'Your organization has not given documentary instructions under this contract yet.',
        ),
      ).toBeVisible();
      expect(panel.getByText('An operator in your organization can give them.')).toBeVisible();
      expect(panel.queryByRole('button')).not.toBeInTheDocument();
    });

    it('tells the seller nothing has been given yet, and offers it nothing', async () => {
      servePage();
      renderRoute(page);

      const panel = await contractPanel();
      expect(
        panel.getByText(
          'The buyer has not given documentary instructions under this contract yet.',
        ),
      ).toBeVisible();
      expect(panel.queryByRole('button')).not.toBeInTheDocument();
    });

    it('explains itself to a participant that is a party to no contract', async () => {
      servePage({ contracts: contractList() });
      renderRoute(page);

      expect(
        await screen.findByText(
          /Documentary instructions pass only between the buyer and the seller/,
        ),
      ).toBeVisible();
    });

    it('reports a failure in its own card, keeps the page, and retries on request', async () => {
      let fail = true;
      const state = servePage({
        listResponse: () => (fail ? problemResponse(500, 'database down') : undefined),
        instructions: [anInstruction()],
      });
      const { user } = renderRoute(page);

      const alert = await screen.findByRole('alert');
      expect(alert).toHaveTextContent('Documentary instructions could not be loaded');
      expect(alert).not.toHaveTextContent('database down');
      expect(screen.getByRole('heading', { name: 'TF-2026-0001' })).toBeInTheDocument();

      fail = false;
      await user.click(within(alert).getByRole('button', { name: 'Retry' }));
      expect(await screen.findByRole('region', { name: 'Revision 1' })).toBeVisible();
      expect(state.listRequests).toBe(2);
    });
  });

  describe('giving and revising, as the buyer', () => {
    it('gives the first instructions only if there are none (If-None-Match: *)', async () => {
      const state = servePage({ contracts: contractList(asBuyer) });
      const given = forBuyer(
        anInstruction({
          currentRevision: aRevision({
            ...firstContent,
            notifyParty: firstContent.notifyParty ?? null,
          }),
        }),
      );
      const put = servePut(() => {
        state.instructions = [given];
        return HttpResponse.json(given, { status: 201 });
      });
      const { user } = renderRoute(page, { signedInAs: claire });

      const form = await openForm(user, 'Give documentary instructions');
      await fillFirstContent(user, form);
      await user.click(form.getByRole('button', { name: 'Send instructions' }));

      const panel = await contractPanel();
      expect(
        await panel.findByText(
          'Revision 1 has been sent to Cerrado Grãos Exportadora S.A. for acknowledgement.',
        ),
      ).toBeVisible();
      expect(put.sent).toEqual([{ body: firstContent, ifMatch: null, ifNoneMatch: '*' }]);
      expect(panel.queryByRole('form')).not.toBeInTheDocument();
      expect(panel.getByRole('region', { name: 'Revision 1' })).toHaveTextContent(
        'Certificate of origin',
      );
    });

    it('revises from the current revision, sending the version it started from', async () => {
      const current = forBuyer(
        anInstruction({ version: 2, currentRevision: acknowledgedRevision(aRevision()) }),
      );
      const state = servePage({ contracts: contractList(asBuyer), instructions: [current] });
      const revised = forBuyer({
        ...current,
        version: 3,
        currentRevision: aRevision({
          number: 2,
          requirements: [
            { document: 'BILL_OF_LADING', originals: 3, copies: 2 },
            { document: 'PHYTOSANITARY_CERTIFICATE', originals: 1, copies: 0 },
          ],
        }),
        previousRevisions: [current.currentRevision],
      });
      const put = servePut(() => {
        state.instructions = [revised];
        return HttpResponse.json(revised);
      });
      const { user } = renderRoute(page, { signedInAs: claire });

      const form = await openForm(user, 'Revise instructions');
      // The draft starts as the current revision.
      expect(form.getByLabelText(/Consignee/)).toHaveValue('To order of Banco Exemplo S.A.');
      expect(rows(form)).toHaveLength(2);
      const firstRow = within(rows(form)[0] as HTMLElement);
      await user.clear(firstRow.getByLabelText('Copies'));
      await user.type(firstRow.getByLabelText('Copies'), '2');
      await user.click(form.getByRole('button', { name: 'Send revision 2' }));

      const panel = await contractPanel();
      expect(
        await panel.findByText(
          'Revision 2 has been sent to Cerrado Grãos Exportadora S.A. for acknowledgement.',
        ),
      ).toBeVisible();
      expect(put.sent).toEqual([
        {
          body: {
            consignee: 'To order of Banco Exemplo S.A.',
            notifyParty: 'Lacustra Commodities SA\nRue du Rhône 1, Geneva',
            requirements: revised.currentRevision.requirements,
          },
          ifMatch: '"2"',
          ifNoneMatch: null,
        },
      ]);
      expect(panel.getByRole('region', { name: 'Revision 2' })).toHaveTextContent(
        'Not acknowledged',
      );
      expect(panel.getByRole('button', { name: 'Earlier revisions (1)' })).toBeVisible();
    });

    it('checks the draft before sending anything', async () => {
      servePage({ contracts: contractList(asBuyer) });
      const put = servePut(() => HttpResponse.json(forBuyer(), { status: 201 }));
      const { user } = renderRoute(page, { signedInAs: claire });
      const form = await openForm(user, 'Give documentary instructions');

      await user.click(form.getByRole('button', { name: 'Send instructions' }));
      expect(await form.findByText('Enter the consignee')).toBeVisible();
      expect(form.getByText('Choose a document')).toBeVisible();
      expect(form.getAllByText('Enter a number')).toHaveLength(2);

      await user.type(form.getByLabelText(/Consignee/), 'To order');
      await fillRow(user, form, 0, { document: 'Bill of lading', originals: '0', copies: '0' });
      await user.click(form.getByRole('button', { name: 'Send instructions' }));
      expect(await form.findByText('Ask for at least one original or copy')).toBeVisible();

      await fillRow(user, form, 0, { document: 'Bill of lading', originals: '11', copies: '0' });
      await user.click(form.getByRole('button', { name: 'Send instructions' }));
      expect(await form.findByText('At most 10')).toBeVisible();

      // A document already listed cannot be chosen twice.
      await user.click(form.getByRole('button', { name: 'Add a document' }));
      const second = within(rows(form)[1] as HTMLElement);
      expect(second.getByRole('option', { name: 'Bill of lading' })).toBeDisabled();
      expect(put.sent).toEqual([]);
    });

    it("shows the server's validation errors where they belong", async () => {
      const current = forBuyer();
      servePage({ contracts: contractList(asBuyer), instructions: [current] });
      servePut(() =>
        validationProblem([
          { path: 'body', message: 'This revision changes nothing: it is the same as revision 1.' },
          { path: 'body.requirements.0.copies', message: 'At most 10' },
        ]),
      );
      const { user } = renderRoute(page, { signedInAs: claire });
      const form = await openForm(user, 'Revise instructions');

      await user.click(form.getByRole('button', { name: 'Send revision 2' }));

      expect(
        await form.findByText('This revision changes nothing: it is the same as revision 1.'),
      ).toBeVisible();
      expect(within(rows(form)[0] as HTMLElement).getByLabelText('Copies')).toHaveAttribute(
        'aria-invalid',
        'true',
      );
    });

    it.each([
      ['a network failure', () => HttpResponse.error(), 'The instructions could not be sent.'],
      [
        'a server failure',
        () => problemResponse(500, 'audit store unavailable'),
        'The instructions could not be sent.',
      ],
      [
        'a refusal',
        () =>
          problemResponse(403, 'Your role does not allow you to give documentary instructions.'),
        'Your role does not allow you to give documentary instructions.',
      ],
    ])('reports %s, keeps the draft and the session, and sends once', async (_, respond, text) => {
      const state = servePage({ contracts: contractList(asBuyer) });
      const put = servePut(respond);
      const { user, queryClient, session } = renderRoute(page, { signedInAs: claire });
      const form = await openForm(user, 'Give documentary instructions');
      await fillFirstContent(user, form);

      await user.click(form.getByRole('button', { name: 'Send instructions' }));

      expect(await form.findByRole('alert')).toHaveTextContent(text);
      expect(screen.queryByText(/audit store/)).not.toBeInTheDocument();
      expect(form.getByLabelText(/Consignee/)).toHaveValue(firstContent.consignee);
      expect(rows(form)).toHaveLength(2);
      expect(put.sent).toHaveLength(1);
      expect(state.listRequests).toBe(1);
      expect(queryClient.getQueryData(['session'])).toEqual(claire);
      expect(session.signOutRequests).toBe(0);
    });
  });

  describe('when the instructions changed meanwhile', () => {
    it('keeps the draft on a 412, and sends it again only once the user has reviewed and chosen', async () => {
      const current = forBuyer();
      const state = servePage({ contracts: contractList(asBuyer), instructions: [current] });
      const theirs = revisedByColleague(current);
      let answer = () => {
        // Lea's revision 2 committed first: Claire's draft was based on revision 1.
        state.instructions = [theirs];
        return preconditionFailed();
      };
      const put = servePut(() => answer());
      const { user } = renderRoute(page, { signedInAs: claire });

      const form = await openForm(user, 'Revise instructions');
      await user.clear(form.getByLabelText(/Consignee/));
      await user.type(form.getByLabelText(/Consignee/), 'To order of My Bank');
      await user.click(form.getByRole('button', { name: 'Send revision 2' }));

      expect(await form.findByText('Not sent')).toBeVisible();
      expect(form.getByLabelText(/Consignee/)).toHaveValue('To order of My Bank');
      // Nothing was refreshed or re-sent behind the user's back.
      expect(state.listRequests).toBe(1);
      expect(put.sent).toHaveLength(1);

      await user.click(form.getByRole('button', { name: 'Review the latest version' }));
      const latest = within(await form.findByRole('region', { name: 'Latest version' }));
      expect(
        latest.getByText(/Revision 2 was given by Lea Brunner on 17 Oct 2030, 06:00 GMT-3/),
      ).toBeVisible();
      expect(latest.getByText('To order of Another Bank AG')).toBeVisible();
      expect(form.getByLabelText(/Consignee/)).toHaveValue('To order of My Bank');
      expect(form.getByRole('button', { name: 'Send revision 2' })).toBeDisabled();

      await user.click(latest.getByRole('button', { name: 'Base my draft on revision 2' }));
      const mine = forBuyer({
        ...theirs,
        version: 3,
        currentRevision: aRevision({ number: 3, consignee: 'To order of My Bank' }),
        previousRevisions: [theirs.currentRevision, current.currentRevision],
      });
      answer = () => {
        state.instructions = [mine];
        return HttpResponse.json(mine);
      };
      expect(form.queryByRole('region', { name: 'Latest version' })).not.toBeInTheDocument();
      await user.click(form.getByRole('button', { name: 'Send revision 3' }));

      expect(
        await screen.findByText(
          'Revision 3 has been sent to Cerrado Grãos Exportadora S.A. for acknowledgement.',
        ),
      ).toBeVisible();
      expect(put.sent.map(({ ifMatch }) => ifMatch)).toEqual(['"1"', '"2"']);
      expect(put.sent[1]?.body).toMatchObject({ consignee: 'To order of My Bank' });
    });

    it('turns a first instruction someone else gave meanwhile into a revision of theirs', async () => {
      const state = servePage({ contracts: contractList(asBuyer) });
      const theirs = forBuyer(
        anInstruction({
          currentRevision: aRevision({
            createdBy: { name: 'Lea Brunner', organization: claire.organization },
          }),
        }),
      );
      const put = servePut(() => {
        state.instructions = [theirs];
        return preconditionFailed();
      });
      const { user } = renderRoute(page, { signedInAs: claire });

      const form = await openForm(user, 'Give documentary instructions');
      await fillFirstContent(user, form);
      await user.click(form.getByRole('button', { name: 'Send instructions' }));
      await user.click(await form.findByRole('button', { name: 'Review the latest version' }));

      const latest = within(await form.findByRole('region', { name: 'Latest version' }));
      expect(latest.getByText(/Revision 1 was given by Lea Brunner/)).toBeVisible();
      await user.click(latest.getByRole('button', { name: 'Base my draft on revision 1' }));
      expect(form.getByLabelText(/Consignee/)).toHaveValue(firstContent.consignee);

      await user.click(form.getByRole('button', { name: 'Send revision 2' }));
      await waitFor(() => {
        expect(put.sent).toHaveLength(2);
      });
      expect(put.sent.map(({ ifMatch, ifNoneMatch }) => [ifMatch, ifNoneMatch])).toEqual([
        [null, '*'],
        ['"1"', null],
      ]);
    });

    it('shows a newer version that a refresh brings in, before anything is sent', async () => {
      const current = forBuyer();
      const state = servePage({ contracts: contractList(asBuyer), instructions: [current] });
      const put = servePut(() => HttpResponse.json(current));
      const { user, queryClient } = renderRoute(page, { signedInAs: claire });
      const form = await openForm(user, 'Revise instructions');
      await user.type(form.getByLabelText(/Notify party/), ' (attn. execution desk)');

      // The seller acknowledged meanwhile; a refresh (window focus, say) brings it in.
      state.instructions = [
        forBuyer({
          ...current,
          version: 2,
          currentRevision: acknowledgedRevision(current.currentRevision),
        }),
      ];
      await queryClient.invalidateQueries({ queryKey: ['protected'] });

      const latest = within(await form.findByRole('region', { name: 'Latest version' }));
      expect(
        latest.getByText(/The seller \(Ana Souza\) acknowledged revision 1 after you started/),
      ).toBeVisible();
      expect(form.getByLabelText(/Notify party/)).toHaveValue(
        'Lacustra Commodities SA\nRue du Rhône 1, Geneva (attn. execution desk)',
      );
      expect(form.getByRole('button', { name: 'Send revision 2' })).toBeDisabled();
      expect(put.sent).toEqual([]);
    });

    it('keeps an open draft when a refresh fails', async () => {
      let fail = false;
      servePage({
        contracts: contractList(asBuyer),
        instructions: [forBuyer()],
        listResponse: () => (fail ? problemResponse(500, 'database down') : undefined),
      });
      const { user, queryClient } = renderRoute(page, { signedInAs: claire });
      const form = await openForm(user, 'Revise instructions');
      await user.clear(form.getByLabelText(/Consignee/));
      await user.type(form.getByLabelText(/Consignee/), 'Draft in progress');

      fail = true;
      await queryClient.invalidateQueries({ queryKey: ['protected'] });

      expect(
        await screen.findByText('Documentary instructions could not be refreshed'),
      ).toBeVisible();
      expect(
        screen.getByRole('form', { name: 'Revise documentary instructions' }),
      ).toBeInTheDocument();
      expect(screen.getByLabelText(/Consignee/)).toHaveValue('Draft in progress');
    });
  });

  describe('acknowledging, as the seller', () => {
    it('acknowledges the revision shown, at the version read', async () => {
      const current = anInstruction({
        version: 4,
        currentRevision: aRevision({ number: 2 }),
        previousRevisions: [acknowledgedRevision(aRevision())],
      });
      const state = servePage({ instructions: [current] });
      const done = {
        ...current,
        version: 5,
        currentRevision: acknowledgedRevision(current.currentRevision, anaAcknowledges),
      };
      const acknowledgement = serveAcknowledgement(2, () => {
        state.instructions = [done];
        return HttpResponse.json(done);
      });
      const { user } = renderRoute(page);

      const panel = await contractPanel();
      await user.click(panel.getByRole('button', { name: 'Acknowledge receipt of revision 2' }));

      const revision = panel.getByRole('region', { name: 'Revision 2' });
      await waitFor(() => {
        expect(revision).toHaveTextContent(
          'Acknowledged16 Oct 2030, 10:30 GMT-3 by Ana Souza (Cerrado Grãos Exportadora S.A.)',
        );
      });
      expect(panel.queryByRole('button', { name: /Acknowledge receipt/ })).not.toBeInTheDocument();
      expect(acknowledgement.sent).toEqual([{ body: {}, ifMatch: '"4"', ifNoneMatch: null }]);
    });

    it('reports a revision that arrived first, shows it, and does not acknowledge it on its own', async () => {
      const current = anInstruction();
      const state = servePage({ instructions: [current] });
      const acknowledgement = serveAcknowledgement(1, () => {
        state.instructions = [{ ...revisedByColleague(current), contract: asSeller }];
        return preconditionFailed();
      });
      const { user } = renderRoute(page);

      const panel = await contractPanel();
      await user.click(panel.getByRole('button', { name: 'Acknowledge receipt of revision 1' }));

      expect(await panel.findByRole('alert')).toHaveTextContent(
        'Not recorded: the instructions changed before your acknowledgement arrived.',
      );
      expect(await panel.findByRole('region', { name: 'Revision 2' })).toHaveTextContent(
        'To order of Another Bank AG',
      );
      expect(
        panel.getByRole('button', { name: 'Acknowledge receipt of revision 2' }),
      ).toBeEnabled();
      expect(acknowledgement.sent).toHaveLength(1);
    });

    it('reports a failure and leaves trying again to the user', async () => {
      servePage({ instructions: [anInstruction()] });
      const acknowledgement = serveAcknowledgement(1, () => problemResponse(500, 'db down'));
      const { user } = renderRoute(page);

      const panel = await contractPanel();
      await user.click(panel.getByRole('button', { name: 'Acknowledge receipt of revision 1' }));

      expect(await panel.findByRole('alert')).toHaveTextContent(
        'Receipt could not be acknowledged. Please try again.',
      );
      expect(
        panel.getByRole('button', { name: 'Acknowledge receipt of revision 1' }),
      ).toBeEnabled();
      expect(acknowledgement.sent).toHaveLength(1);
    });
  });

  describe('when the server answers 401', () => {
    it('ends the session a revision was sent under, and asks to sign in again', async () => {
      servePage({ contracts: contractList(asBuyer), instructions: [forBuyer()] });
      const put = servePut(() => problemResponse(401, 'Authentication is required.'));
      const { router, user, session, queryClient } = renderRoute(page, { signedInAs: claire });
      const form = await openForm(user, 'Revise instructions');
      await user.type(form.getByLabelText(/Consignee/), ' (amended)');
      session.current = null;

      await user.click(form.getByRole('button', { name: 'Send revision 2' }));

      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
      await waitFor(() => {
        expect(protectedQueries(queryClient)).toEqual([]);
      });
      expect(put.sent).toHaveLength(1);
      expect(session.signOutRequests).toBe(0);
    });
  });

  describe('when the identity changes while a write is in flight', () => {
    it("lets a revision's response touch neither the next identity's cache nor its screen", async () => {
      const current = forBuyer();
      const state = servePage({ contracts: contractList(asBuyer), instructions: [current] });
      const put = servePut(() => HttpResponse.json(revisedByColleague(current)), { hold: true });
      const { user, session, queryClient } = renderRoute(page, {
        signedInAs: claire,
        accounts: [claire, ana],
      });
      const otherTab = anotherTab(queryClient);
      const form = await openForm(user, 'Revise instructions');
      await user.type(form.getByLabelText(/Consignee/), ' (amended)');
      await user.click(form.getByRole('button', { name: 'Send revision 2' }));
      await put.received;

      // Another tab signs in as Ana, the seller; this tab now shows her the same voyage.
      session.current = ana;
      state.instructions = [current].map((instruction) => ({ ...instruction, contract: asSeller }));
      server.use(
        http.get(`*/api/voyages/${voyage.id}/my-contracts`, () =>
          HttpResponse.json(contractList(asSeller)),
        ),
      );
      otherTab.postMessage(SESSION_CHANGED);
      expect(await screen.findByText('Ana Souza')).toBeInTheDocument();
      await screen.findByRole('button', { name: 'Acknowledge receipt of revision 1' });
      const listRequestsBefore = state.listRequests;

      put.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(screen.queryByText(/has been sent to/)).not.toBeInTheDocument();
      expect(screen.queryByRole('region', { name: 'Revision 2' })).not.toBeInTheDocument();
      expect(state.listRequests).toBe(listRequestsBefore);
      const anaScope = `${ana.user.id}:${ana.organization.id}`;
      for (const query of protectedQueries(queryClient)) {
        expect(query.queryKey[1]).toBe(anaScope);
        expect(query.state.isInvalidated).toBe(false);
      }
    });

    it('lets an acknowledgement response write nothing after a sign-out', async () => {
      const current = anInstruction();
      servePage({ instructions: [current] });
      const acknowledgement = serveAcknowledgement(
        1,
        () =>
          HttpResponse.json({
            ...current,
            version: 2,
            currentRevision: acknowledgedRevision(current.currentRevision),
          }),
        { hold: true },
      );
      const { router, user, queryClient } = renderRoute(page);
      const panel = await contractPanel();
      await user.click(panel.getByRole('button', { name: 'Acknowledge receipt of revision 1' }));
      await acknowledgement.received;

      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();

      acknowledgement.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(router.state.location.pathname).toBe('/sign-in');
      expect(protectedQueries(queryClient)).toEqual([]);
    });
  });
});
