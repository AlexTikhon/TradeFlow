import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  type ContractDocument,
  type CounterpartyContractListResponse,
  type CurrentUser,
  type DocumentaryInstruction,
  MAX_DOCUMENT_BYTES,
  type ProblemDetails,
} from '@tradeflow/contracts';
import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { aCurrentUser, anotherUser, TEST_PASSWORD } from '../../../test/fixtures/auth';
import { anInstruction, aRevision } from '../../../test/fixtures/documentary-instructions';
import {
  aDocument,
  aDocumentVersion,
  brunoUploads,
  replacedBy,
} from '../../../test/fixtures/documents';
import { aCounterpartyContract, contractList } from '../../../test/fixtures/notices';
import { aTradeString, aVoyageDetail } from '../../../test/fixtures/voyages';
import { problemResponse, server } from '../../../test/msw-server';
import { renderRoute } from '../../../test/render-route';
import { checkSession, StaleSessionCheckError } from '../../auth/session';
import { SESSION_CHANGED, SESSION_CHANNEL_NAME, startSessionSync } from '../../auth/session-sync';

const voyage = aVoyageDetail();
const page = `/voyages/${voyage.id}`;

/** Ana operates for Cerrado, the seller under contract 1: she presents the documents. */
const ana = aCurrentUser();
const anaAsViewer = aCurrentUser({ user: { ...ana.user, role: 'VIEWER' } });
/** Claire operates for Lacustra, the buyer under contract 1: she reads them. */
const claire = anotherUser();

const asSeller = aCounterpartyContract();
const asBuyer = aCounterpartyContract({ side: 'BUYER' });
const contractName = 'Contract 1 · Cerrado Grãos Exportadora S.A. → Lacustra Commodities SA';
const revisionPath = `/contracts/${asSeller.id}/documentary-instructions/revisions/1`;
const versionsPath = `${revisionPath}/documents/BILL_OF_LADING/versions`;

/** `document` as the buyer sees it. */
const forBuyer = (document: ContractDocument): ContractDocument => ({
  ...document,
  contract: asBuyer,
});

/**
 * Serves the details page. `documents` is the fake server's state: tests change it, and every
 * list request answers what it holds at that moment.
 */
function servePage({
  contracts = contractList(asSeller),
  instructions = [anInstruction()],
  documents = [] as ContractDocument[],
  documentsResponse,
}: {
  contracts?: CounterpartyContractListResponse;
  instructions?: DocumentaryInstruction[];
  documents?: ContractDocument[];
  documentsResponse?: () => Response | undefined;
} = {}) {
  const state = { documents, instructions, documentRequests: 0, instructionRequests: 0 };
  server.use(
    http.get(`*/api/voyages/${voyage.id}`, () => HttpResponse.json(voyage)),
    http.get(`*/api/voyages/${voyage.id}/trade-string`, () => HttpResponse.json(aTradeString())),
    http.get(`*/api/voyages/${voyage.id}/my-contracts`, () => HttpResponse.json(contracts)),
    http.get(`*/api/voyages/${voyage.id}/notices`, () => HttpResponse.json({ items: [] })),
    http.get(`*/api/voyages/${voyage.id}/documentary-instructions`, () => {
      state.instructionRequests += 1;
      return HttpResponse.json({ items: state.instructions });
    }),
    http.get(`*/api/voyages/${voyage.id}/documents`, () => {
      state.documentRequests += 1;
      return documentsResponse?.() ?? HttpResponse.json({ items: state.documents });
    }),
  );
  return state;
}

interface Sent {
  fields: string[];
  name: string;
  type: string;
  bytes: Uint8Array;
  ifMatch: string | null;
  ifNoneMatch: string | null;
}

/**
 * Serves uploads of the bill of lading with `respond`, recording what each request carried: the
 * form's fields, the file and the preconditions. With `hold`, responses wait for `release()`.
 */
function serveUpload(respond: () => Response, { hold = false } = {}) {
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
    http.post(`*/api/voyages/${voyage.id}${versionsPath}`, async ({ request }) => {
      const form = await request.formData();
      const file = form.get('file');
      if (!(file instanceof File)) throw new Error('The upload carries no file');
      sent.push({
        fields: [...form.keys()],
        name: file.name,
        type: file.type,
        bytes: new Uint8Array(await file.arrayBuffer()),
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

/** Serves version `version`'s content with `bytes`. With `hold`, waits for `release()`. */
function serveDownload(version: number, bytes: Uint8Array, { hold = false } = {}) {
  const requests: { accept: string | null }[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let arrived: () => void = () => undefined;
  const received = new Promise<void>((resolve) => {
    arrived = resolve;
  });
  server.use(
    http.get(
      `*/api/voyages/${voyage.id}${versionsPath}/${version}/content`,
      async ({ request }) => {
        requests.push({ accept: request.headers.get('accept') });
        arrived();
        if (hold) await gate;
        return new HttpResponse(bytes, {
          headers: {
            'Content-Type': 'application/pdf',
            'Content-Disposition': 'attachment; filename="bill-of-lading.pdf"',
          },
        });
      },
    ),
  );
  return { requests, received, release };
}

const problem = (status: number, title: string, detail: string) =>
  HttpResponse.json({ type: 'about:blank', title, status, detail } satisfies ProblemDetails, {
    status,
    headers: { 'Content-Type': 'application/problem+json' },
  });

/** Bytes that start like a PDF. */
const pdfBytes = (size = 2048) => {
  const bytes = new Uint8Array(size);
  bytes.set(new TextEncoder().encode('%PDF-1.7\n'));
  return bytes;
};
const aPdf = (name = 'bl-signed.pdf', bytes = pdfBytes()) =>
  new File([bytes], name, { type: 'application/pdf' });

type Rendered = ReturnType<typeof renderRoute>;
type User = Rendered['user'];

/** The bill of lading's entry under contract 1's current revision. */
async function billOfLading() {
  const panel = within(await screen.findByRole('listitem', { name: contractName }));
  return within(await panel.findByRole('listitem', { name: 'Bill of lading' }));
}
type Item = Awaited<ReturnType<typeof billOfLading>>;

const chooseFile = async (user: User, item: Item, file: File) => {
  await user.upload(item.getByLabelText('PDF file for the bill of lading'), file);
};

const protectedQueries = (queryClient: Rendered['queryClient']) =>
  queryClient.getQueryCache().findAll({ queryKey: ['protected'] });

const pendingMutations = (queryClient: Rendered['queryClient']) =>
  queryClient
    .getMutationCache()
    .getAll()
    .filter((mutation) => mutation.state.status === 'pending');

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

async function signOut(user: User) {
  await user.click(screen.getByRole('button', { name: 'Sign out' }));
  expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
}

/**
 * Signs in on the sign-in page, then opens the voyage page again. (Where sign-in lands depends
 * on whether the sign-out's redirect remembered the page, which these tests do not rely on.)
 */
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

/**
 * The cookie now belongs to `identity`, and nothing announced it: a session check (as on
 * returning to the tab) finds out. Waits until this tab has adopted the answer.
 */
async function aSessionCheckFinds(
  { session, queryClient }: Pick<Rendered, 'session' | 'queryClient'>,
  identity: CurrentUser,
) {
  session.current = identity;
  await act(() => queryClient.refetchQueries({ queryKey: ['session'] }));
  expect(queryClient.getQueryData(['session'])).toEqual(identity);
}

/** Session checks alone go to Claire and back to Ana; waits until Ana's page is back. */
async function sessionChecksGoToClaireAndBack(rendered: Pick<Rendered, 'session' | 'queryClient'>) {
  await aSessionCheckFinds(rendered, claire);
  expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
  await aSessionCheckFinds(rendered, ana);
  expect(await screen.findByText('Ana Souza')).toBeInTheDocument();
}

/** Waits until every request still on its way has been answered and handled. */
async function allAnswered(queryClient: Rendered['queryClient']) {
  await waitFor(() => {
    expect(pendingMutations(queryClient)).toEqual([]);
  });
}

/** What the browser was asked to save: object URLs made, and the links clicked. */
function watchSaves() {
  const saved: { href: string; download: string; blob: Blob }[] = [];
  const blobs = new Map<string, Blob>();
  let next = 0;
  const create = vi.fn((blob: Blob) => {
    const url = `blob:test/${(next += 1)}`;
    blobs.set(url, blob);
    return url;
  });
  const revoke = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: create });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: revoke });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
    this: HTMLAnchorElement,
  ) {
    saved.push({ href: this.href, download: this.download, blob: blobs.get(this.href) as Blob });
  });
  watchers.push(() => {
    click.mockRestore();
  });
  return { saved, create };
}

describe('Documents on the voyage page', () => {
  beforeEach(() => {
    vi.useRealTimers();
  });

  describe('reading', () => {
    it('lists every document the current revision requires, and what has been presented', async () => {
      const document = replacedBy(aDocument(), { uploadedBy: brunoUploads, sizeBytes: 3_250_000 });
      servePage({ documents: [document] });
      const { user } = renderRoute(page);

      const item = await billOfLading();
      expect(item.getByText('Version 2')).toBeVisible();
      expect(item.getByText('Version 2: bill-of-lading-v2.pdf (3.1 MB)')).toBeVisible();
      expect(item.getByText(/by Bruno Lima \(Cerrado Grãos Exportadora S\.A\.\)/)).toBeVisible();
      expect(item.getByText(/SHA-256 c3ab8ff13720…/)).toBeVisible();
      await user.click(item.getByRole('button', { name: 'Earlier versions (1)' }));
      const earlier = within(
        item.getByRole('list', { name: 'Earlier versions of the bill of lading' }),
      );
      expect(earlier.getByText('Version 1: bill-of-lading.pdf (47.1 KB)')).toBeVisible();
      expect(
        earlier.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      ).toBeEnabled();

      const panel = within(screen.getByRole('listitem', { name: contractName }));
      const certificate = within(
        panel.getByRole('listitem', { name: 'Phytosanitary certificate' }),
      );
      expect(certificate.getByText('Not uploaded yet')).toBeVisible();
      expect(certificate.getByRole('button', { name: 'Upload' })).toBeDisabled();
    });

    it('shows the buyer what was presented, with downloads but no uploads', async () => {
      servePage({
        contracts: contractList(asBuyer),
        instructions: [{ ...anInstruction(), contract: asBuyer }],
        documents: [forBuyer(aDocument())],
      });
      renderRoute(page, { signedInAs: claire });

      const item = await billOfLading();
      expect(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      ).toBeEnabled();
      expect(item.queryByLabelText('PDF file for the bill of lading')).not.toBeInTheDocument();
      expect(
        screen.getByText(/What Cerrado Grãos Exportadora S\.A\. presents against revision 1/),
      ).toBeVisible();
      expect(screen.queryByText('An operator in your organization can upload it.')).toBeNull();
    });

    it('offers a viewer of the seller downloads, and says who can upload', async () => {
      servePage({ documents: [aDocument()] });
      renderRoute(page, { signedInAs: anaAsViewer });

      const item = await billOfLading();
      expect(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      ).toBeEnabled();
      expect(item.queryByLabelText('PDF file for the bill of lading')).not.toBeInTheDocument();
      expect(screen.getByText('An operator in your organization can upload it.')).toBeVisible();
    });

    it('keeps what was presented against an earlier revision, read-only', async () => {
      const revisionTwo = aRevision({
        number: 2,
        requirements: [{ document: 'CERTIFICATE_OF_ORIGIN', originals: 1, copies: 0 }],
      });
      servePage({
        instructions: [
          anInstruction({
            version: 2,
            currentRevision: revisionTwo,
            previousRevisions: [aRevision()],
          }),
        ],
        documents: [aDocument()],
      });
      const { user } = renderRoute(page);

      const panel = within(await screen.findByRole('listitem', { name: contractName }));
      expect(
        await panel.findByRole('listitem', { name: 'Certificate of origin' }),
      ).toBeInTheDocument();
      // The current revision no longer requires a bill of lading.
      expect(panel.queryByRole('listitem', { name: 'Bill of lading' })).not.toBeInTheDocument();
      await user.click(panel.getByRole('button', { name: 'Earlier revisions (1)' }));
      const earlier = within(
        panel.getByRole('region', { name: 'Documents presented against revision 1' }),
      );
      const item = within(earlier.getByRole('listitem', { name: 'Bill of lading' }));
      expect(item.getByText('Version 1: bill-of-lading.pdf (47.1 KB)')).toBeVisible();
      expect(item.queryByLabelText('PDF file for the bill of lading')).not.toBeInTheDocument();
    });

    it('keeps the instructions when documents cannot be loaded, and retries on request', async () => {
      let failing = true;
      const state = servePage({
        documents: [aDocument()],
        documentsResponse: () => (failing ? problemResponse(500, 'Boom') : undefined),
      });
      const { user } = renderRoute(page);

      expect(await screen.findByText('Documents could not be loaded')).toBeVisible();
      expect(screen.getByRole('region', { name: 'Revision 1' })).toBeVisible();
      const requests = state.documentRequests;
      failing = false;

      await user.click(screen.getByRole('button', { name: 'Retry' }));

      expect(await billOfLading()).toBeDefined();
      expect(state.documentRequests).toBe(requests + 1);
    });
  });

  describe('uploading, as the seller', () => {
    it('uploads the first version only if there is none (If-None-Match: *)', async () => {
      const state = servePage();
      const uploaded = aDocument({
        currentVersion: aDocumentVersion({ fileName: 'bl-signed.pdf' }),
      });
      const upload = serveUpload(() => {
        state.documents = [uploaded];
        return HttpResponse.json(uploaded, { status: 201 });
      });
      const { user } = renderRoute(page);
      const item = await billOfLading();
      const bytes = pdfBytes(4096);

      await chooseFile(user, item, aPdf('bl-signed.pdf', bytes));
      expect(item.getByText('bl-signed.pdf (4 KB)')).toBeVisible();
      await user.click(item.getByRole('button', { name: 'Upload' }));

      expect(
        await item.findByText('Version 1 of the bill of lading has been uploaded.'),
      ).toBeVisible();
      expect(upload.sent).toEqual([
        {
          fields: ['file'],
          name: 'bl-signed.pdf',
          type: 'application/pdf',
          bytes,
          ifMatch: null,
          ifNoneMatch: '*',
        },
      ]);
      expect(item.getByText('Version 1: bl-signed.pdf (47.1 KB)')).toBeVisible();
      expect(item.getByText('No file chosen')).toBeVisible();
    });

    it('replaces the current version, naming the one it replaces (If-Match)', async () => {
      const current = aDocument();
      const state = servePage({ documents: [current] });
      const upload = serveUpload(() => {
        state.documents = [replacedBy(current)];
        return HttpResponse.json(replacedBy(current), { status: 201 });
      });
      const { user } = renderRoute(page);
      const item = await billOfLading();

      await chooseFile(user, item, aPdf());
      await user.click(item.getByRole('button', { name: 'Upload as version 2' }));

      expect(
        await item.findByText('Version 2 of the bill of lading has been uploaded.'),
      ).toBeVisible();
      expect(upload.sent.map(({ ifMatch, ifNoneMatch }) => [ifMatch, ifNoneMatch])).toEqual([
        ['"1"', null],
      ]);
      expect(item.getByText('Version 2')).toBeVisible();
      expect(item.getByRole('button', { name: 'Earlier versions (1)' })).toBeVisible();
    });

    it.each<[string, File, string]>([
      [
        'a file that is not a PDF',
        new File(['GIF89a'], 'scan.gif', { type: 'image/gif' }),
        'Choose a PDF file',
      ],
      [
        'an empty file',
        new File([], 'empty.pdf', { type: 'application/pdf' }),
        'The file is empty',
      ],
      [
        'a file over 10 MiB',
        new File([new Uint8Array(MAX_DOCUMENT_BYTES + 1)], 'huge.pdf', { type: 'application/pdf' }),
        'The file is larger than 10 MiB',
      ],
    ])('checks the file before sending anything: %s', async (_case, file, message) => {
      servePage();
      const upload = serveUpload(() => HttpResponse.json(aDocument(), { status: 201 }));
      renderRoute(page);
      const item = await billOfLading();
      // A file picker's "All files" lets a user choose past the input's `accept` filter.
      const user = userEvent.setup({ applyAccept: false });

      await user.upload(item.getByLabelText('PDF file for the bill of lading'), file);

      expect(item.getByRole('alert')).toHaveTextContent(message);
      expect(item.getByRole('button', { name: 'Upload' })).toBeDisabled();
      expect(upload.sent).toEqual([]);
    });

    it.each<[string, () => Response, string]>([
      [
        'refuses the file',
        () =>
          problem(
            415,
            'Unsupported Media Type',
            'The file is not a PDF: a PDF file starts with "%PDF-".',
          ),
        'The file is not a PDF: a PDF file starts with "%PDF-".',
      ],
      [
        'finds it too large',
        () => problem(413, 'Payload Too Large', 'The file is larger than 10 MiB.'),
        'The file is larger than 10 MiB.',
      ],
      [
        'fails',
        () => problemResponse(500, 'An unexpected error occurred.'),
        'The file could not be uploaded. Please try again.',
      ],
      [
        'cannot be reached',
        () => HttpResponse.error(),
        'The file could not be uploaded. Please try again.',
      ],
    ])(
      'keeps the chosen file when the server %s, and sends it again only when asked',
      async (_case, respond, message) => {
        servePage();
        const upload = serveUpload(respond);
        const { user } = renderRoute(page);
        const item = await billOfLading();
        await chooseFile(user, item, aPdf('bl-signed.pdf'));

        await user.click(item.getByRole('button', { name: 'Upload' }));

        expect(await item.findByText(message)).toBeVisible();
        expect(item.getByText(/^bl-signed\.pdf/)).toBeVisible();
        expect(upload.sent).toHaveLength(1);
        // Nothing is sent again on its own.
        await new Promise((resolve) => setTimeout(resolve, 50));
        expect(upload.sent).toHaveLength(1);

        await user.click(item.getByRole('button', { name: 'Upload' }));
        await waitFor(() => {
          expect(upload.sent).toHaveLength(2);
        });
        expect(upload.sent[1]?.name).toBe('bl-signed.pdf');
      },
    );

    it('keeps the file on a 412, and replaces only once the user has seen the newer version', async () => {
      const state = servePage();
      const theirs = aDocument({ currentVersion: aDocumentVersion({ uploadedBy: brunoUploads }) });
      const mine = replacedBy(theirs, { fileName: 'bl-signed.pdf' });
      const upload = serveUpload(() =>
        upload.sent.length === 1
          ? problem(412, 'Precondition Failed', 'This document already has version 1.')
          : HttpResponse.json(mine, { status: 201 }),
      );
      const { user } = renderRoute(page);
      const item = await billOfLading();
      await chooseFile(user, item, aPdf('bl-signed.pdf'));
      // Bruno uploads version 1 meanwhile.
      state.documents = [theirs];

      await user.click(item.getByRole('button', { name: 'Upload' }));

      expect(await item.findByText('Not uploaded')).toBeVisible();
      expect(item.getByText(/^bl-signed\.pdf/)).toBeVisible();
      await user.click(item.getByRole('button', { name: 'Review the latest version' }));
      const latest = within(
        await item.findByRole('region', { name: 'Latest version of Bill of lading' }),
      );
      expect(latest.getByText(/uploaded by Bruno Lima/)).toBeVisible();
      expect(item.getByRole('button', { name: 'Upload' })).toBeDisabled();
      expect(upload.sent).toHaveLength(1);

      await user.click(latest.getByRole('button', { name: 'Replace version 1 with my file' }));
      await user.click(item.getByRole('button', { name: 'Upload as version 2' }));

      expect(
        await item.findByText('Version 2 of the bill of lading has been uploaded.'),
      ).toBeVisible();
      expect(upload.sent.map(({ ifMatch, ifNoneMatch }) => [ifMatch, ifNoneMatch])).toEqual([
        [null, '*'],
        ['"1"', null],
      ]);
    });

    it('shows a version a refresh brings in before anything is sent', async () => {
      const state = servePage();
      const upload = serveUpload(() => HttpResponse.json(aDocument(), { status: 201 }));
      const { user, queryClient } = renderRoute(page);
      const item = await billOfLading();
      await chooseFile(user, item, aPdf());

      state.documents = [
        aDocument({ currentVersion: aDocumentVersion({ uploadedBy: brunoUploads }) }),
      ];
      await queryClient.invalidateQueries({ queryKey: ['protected'] });

      expect(
        await item.findByRole('region', { name: 'Latest version of Bill of lading' }),
      ).toBeVisible();
      expect(item.getByRole('button', { name: 'Upload' })).toBeDisabled();
      expect(upload.sent).toEqual([]);
    });

    it('reports a revision superseded meanwhile and refreshes the instructions', async () => {
      const state = servePage();
      serveUpload(() =>
        problem(
          409,
          'Conflict',
          'Revision 1 has been superseded by revision 2; documents are presented against the current revision.',
        ),
      );
      const { user } = renderRoute(page);
      const item = await billOfLading();
      await chooseFile(user, item, aPdf());
      const instructionRequests = state.instructionRequests;

      await user.click(item.getByRole('button', { name: 'Upload' }));

      expect(
        await item.findByText(
          'Not uploaded: Revision 1 has been superseded by revision 2; documents are presented against the current revision.',
        ),
      ).toBeVisible();
      await waitFor(() => {
        expect(state.instructionRequests).toBeGreaterThan(instructionRequests);
      });
    });
  });

  describe('downloading', () => {
    it('fetches the bytes with the session and saves them under the uploaded name', async () => {
      servePage({ documents: [aDocument()] });
      const bytes = pdfBytes(1000);
      const content = serveDownload(1, bytes);
      const { saved } = watchSaves();
      const { user } = renderRoute(page);
      const item = await billOfLading();

      await user.click(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );

      await waitFor(() => {
        expect(saved).toHaveLength(1);
      });
      expect(saved[0]?.download).toBe('bill-of-lading.pdf');
      expect(new Uint8Array(await (saved[0]?.blob as Blob).arrayBuffer())).toEqual(bytes);
      expect(content.requests).toEqual([{ accept: 'application/pdf, application/problem+json' }]);
    });

    it('reports a download that is refused', async () => {
      servePage({ documents: [aDocument()] });
      server.use(
        http.get(`*/api/voyages/${voyage.id}${versionsPath}/1/content`, () =>
          problemResponse(404, 'Document was not found.'),
        ),
      );
      const { saved } = watchSaves();
      const { user } = renderRoute(page);
      const item = await billOfLading();

      await user.click(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );

      expect(
        await item.findByText(
          'The file could not be found. It may no longer be available to your organization.',
        ),
      ).toBeVisible();
      expect(saved).toEqual([]);
    });
  });

  describe('when the server answers 401', () => {
    it('ends the session an upload was sent under, and asks to sign in again', async () => {
      servePage();
      const upload = serveUpload(() => problemResponse(401, 'Authentication is required.'));
      const { router, user, session, queryClient } = renderRoute(page);
      const item = await billOfLading();
      await chooseFile(user, item, aPdf());
      session.current = null;

      await user.click(item.getByRole('button', { name: 'Upload' }));

      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
      expect(router.state.location.pathname).toBe('/sign-in');
      await waitFor(() => {
        expect(protectedQueries(queryClient)).toEqual([]);
      });
      expect(upload.sent).toHaveLength(1);
      expect(session.signOutRequests).toBe(0);
    });

    it('ends the session a download was asked under', async () => {
      servePage({ documents: [aDocument()] });
      server.use(
        http.get(`*/api/voyages/${voyage.id}${versionsPath}/1/content`, () =>
          problemResponse(401, 'Authentication is required.'),
        ),
      );
      const { saved } = watchSaves();
      const { user, session } = renderRoute(page);
      const item = await billOfLading();
      session.current = null;

      await user.click(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );

      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
      expect(saved).toEqual([]);
    });
  });

  describe('when the identity changes while a request is in flight', () => {
    it("lets an upload's response touch neither the next identity's cache nor its screen", async () => {
      const state = servePage();
      const upload = serveUpload(() => HttpResponse.json(aDocument(), { status: 201 }), {
        hold: true,
      });
      const { user, session, queryClient } = renderRoute(page, { accounts: [ana, claire] });
      const otherTab = anotherTab(queryClient);
      const item = await billOfLading();
      await chooseFile(user, item, aPdf());
      await user.click(item.getByRole('button', { name: 'Upload' }));
      await upload.received;

      // Another tab signs in as Claire, the buyer; this tab now shows her the same voyage.
      session.current = claire;
      state.instructions = [{ ...anInstruction(), contract: asBuyer }];
      server.use(
        http.get(`*/api/voyages/${voyage.id}/my-contracts`, () =>
          HttpResponse.json(contractList(asBuyer)),
        ),
      );
      otherTab.postMessage(SESSION_CHANGED);
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      expect(await billOfLading()).toBeDefined();
      const documentRequestsBefore = state.documentRequests;

      upload.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(screen.queryByText(/has been uploaded/)).not.toBeInTheDocument();
      expect(screen.queryByText('Version 1')).not.toBeInTheDocument();
      expect(state.documentRequests).toBe(documentRequestsBefore);
      const claireScope = `${claire.user.id}:${claire.organization.id}`;
      for (const query of protectedQueries(queryClient)) {
        expect(query.queryKey[1]).toBe(claireScope);
        expect(query.state.isInvalidated).toBe(false);
      }
    });

    it('lets an upload response write nothing after a sign-out', async () => {
      servePage();
      const upload = serveUpload(() => HttpResponse.json(aDocument(), { status: 201 }), {
        hold: true,
      });
      const { router, user, queryClient } = renderRoute(page);
      const item = await billOfLading();
      await chooseFile(user, item, aPdf());
      await user.click(item.getByRole('button', { name: 'Upload' }));
      await upload.received;

      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();

      upload.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(router.state.location.pathname).toBe('/sign-in');
      expect(protectedQueries(queryClient)).toEqual([]);
    });

    it('does not save a download that arrives after a sign-out', async () => {
      servePage({ documents: [aDocument()] });
      const content = serveDownload(1, pdfBytes(), { hold: true });
      const { saved, create } = watchSaves();
      const { user, queryClient } = renderRoute(page);
      const item = await billOfLading();
      await user.click(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );
      await content.received;

      await user.click(screen.getByRole('button', { name: 'Sign out' }));
      expect(await screen.findByRole('heading', { name: 'Sign in to TradeFlow' })).toBeVisible();
      content.release();
      await waitFor(() => {
        expect(settledMutations(queryClient)).toHaveLength(1);
      });

      expect(create).not.toHaveBeenCalled();
      expect(saved).toEqual([]);
    });
  });
  describe('when the session is replaced while a request is in flight, even by the same user', () => {
    /** Ana's document list in the session now current: what a stale response must not touch. */
    const anasDocuments = (queryClient: Rendered['queryClient']) =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ['protected', `${ana.user.id}:${ana.organization.id}`] })
        .filter((query) => query.queryKey.includes('documents'));

    it('does not save a download asked for before Ana signed out and back in', async () => {
      servePage({ documents: [aDocument()] });
      const content = serveDownload(1, pdfBytes(), { hold: true });
      const { saved, create } = watchSaves();
      const rendered = renderRoute(page);
      const { user, queryClient } = rendered;
      const item = await billOfLading();
      await user.click(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );
      await content.received;

      await signOut(user);
      await signIn(rendered, ana);
      expect(await billOfLading()).toBeDefined();
      content.release();
      await allAnswered(queryClient);

      expect(create).not.toHaveBeenCalled();
      expect(saved).toEqual([]);
    });

    it('lets an upload sent before Ana signed out and back in touch nothing of her new session', async () => {
      const state = servePage();
      const upload = serveUpload(() => HttpResponse.json(aDocument(), { status: 201 }), {
        hold: true,
      });
      const rendered = renderRoute(page);
      const { user, queryClient } = rendered;
      const before = await billOfLading();
      await chooseFile(user, before, aPdf());
      await user.click(before.getByRole('button', { name: 'Upload' }));
      await upload.received;

      await signOut(user);
      await signIn(rendered, ana);
      const item = await billOfLading();
      expect(item.getByText('Not uploaded yet')).toBeVisible();
      const documentRequests = state.documentRequests;
      const instructionRequests = state.instructionRequests;
      upload.release();
      await allAnswered(queryClient);

      expect(screen.queryByText(/has been uploaded/)).not.toBeInTheDocument();
      expect(item.getByText('Not uploaded yet')).toBeVisible();
      expect(state.documentRequests).toBe(documentRequests);
      expect(state.instructionRequests).toBe(instructionRequests);
      const [documents] = anasDocuments(queryClient);
      expect(documents?.state.data).toEqual({ items: [] });
      expect(documents?.state.isInvalidated).toBe(false);
    });

    it('lets a 409 sent before another tab went to Claire and back to Ana refresh nothing', async () => {
      const state = servePage();
      const upload = serveUpload(
        () => problem(409, 'Conflict', 'Revision 1 has been superseded by revision 2.'),
        { hold: true },
      );
      const rendered = renderRoute(page, { accounts: [ana, claire] });
      const { user, queryClient } = rendered;
      const otherTab = anotherTab(queryClient);
      const before = await billOfLading();
      await chooseFile(user, before, aPdf());
      await user.click(before.getByRole('button', { name: 'Upload' }));
      await upload.received;

      await anotherTabSignsInAs(otherTab, rendered, claire);
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      await anotherTabSignsInAs(otherTab, rendered, ana);
      expect(await screen.findByText('Ana Souza')).toBeInTheDocument();
      expect(await billOfLading()).toBeDefined();
      const documentRequests = state.documentRequests;
      const instructionRequests = state.instructionRequests;
      upload.release();
      await allAnswered(queryClient);

      expect(state.documentRequests).toBe(documentRequests);
      expect(state.instructionRequests).toBe(instructionRequests);
      for (const query of protectedQueries(queryClient)) {
        expect(query.state.isInvalidated).toBe(false);
      }
    });

    it('does not save a download asked for before Ana signed out, Claire signed in and another tab returned to Ana', async () => {
      servePage({ documents: [aDocument()] });
      const content = serveDownload(1, pdfBytes(), { hold: true });
      const { saved, create } = watchSaves();
      const rendered = renderRoute(page, { accounts: [ana, claire] });
      const { user, queryClient } = rendered;
      const otherTab = anotherTab(queryClient);
      const item = await billOfLading();
      await user.click(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );
      await content.received;

      await signOut(user);
      await signIn(rendered, claire);
      await anotherTabSignsInAs(otherTab, rendered, ana);
      expect(await screen.findByText('Ana Souza')).toBeInTheDocument();
      expect(await billOfLading()).toBeDefined();
      content.release();
      await allAnswered(queryClient);

      expect(create).not.toHaveBeenCalled();
      expect(saved).toEqual([]);
    });

    it('completes an upload when a session check only confirmed that Ana is still signed in', async () => {
      const state = servePage();
      const uploaded = aDocument({
        currentVersion: aDocumentVersion({ fileName: 'bl-signed.pdf' }),
      });
      const upload = serveUpload(
        () => {
          state.documents = [uploaded];
          return HttpResponse.json(uploaded, { status: 201 });
        },
        { hold: true },
      );
      const { user, session, queryClient } = renderRoute(page);
      const item = await billOfLading();
      await chooseFile(user, item, aPdf('bl-signed.pdf'));
      await user.click(item.getByRole('button', { name: 'Upload' }));
      await upload.received;

      const checks = session.meRequests;
      await queryClient.refetchQueries({ queryKey: ['session'] });
      expect(session.meRequests).toBe(checks + 1);
      expect(queryClient.getQueryData(['session'])).toEqual(ana);
      upload.release();

      expect(
        await item.findByText('Version 1 of the bill of lading has been uploaded.'),
      ).toBeVisible();
      expect(item.getByText('Version 1: bl-signed.pdf (47.1 KB)')).toBeVisible();
    });

    it('keeps to each download the session it was asked in, when they overlap', async () => {
      servePage({ documents: [replacedBy(aDocument())] });
      const first = serveDownload(1, pdfBytes(1000), { hold: true });
      const secondBytes = pdfBytes(2000);
      const second = serveDownload(2, secondBytes, { hold: true });
      const { saved } = watchSaves();
      const rendered = renderRoute(page);
      const { user, queryClient } = rendered;
      const before = await billOfLading();
      await user.click(before.getByRole('button', { name: 'Earlier versions (1)' }));
      await user.click(
        before.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );
      await first.received;

      await signOut(user);
      await signIn(rendered, ana);
      const item = await billOfLading();
      await user.click(
        item.getByRole('button', { name: 'Download version 2 of the bill of lading' }),
      );
      await second.received;
      // The older answer arrives while the newer request is still on its way, then the newer.
      first.release();
      await waitFor(() => {
        expect(pendingMutations(queryClient)).toHaveLength(1);
      });
      second.release();
      await allAnswered(queryClient);

      expect(saved.map(({ download }) => download)).toEqual(['bill-of-lading-v2.pdf']);
      expect(new Uint8Array(await (saved[0]?.blob as Blob).arrayBuffer())).toEqual(secondBytes);
    });
  });

  describe('when session checks alone go to Claire and back to Ana while a request is in flight', () => {
    const anasDocuments = (queryClient: Rendered['queryClient']) =>
      queryClient
        .getQueryCache()
        .findAll({ queryKey: ['protected', `${ana.user.id}:${ana.organization.id}`] })
        .filter((query) => query.queryKey.includes('documents'));

    it('does not save a download asked for before', async () => {
      servePage({ documents: [aDocument()] });
      const content = serveDownload(1, pdfBytes(), { hold: true });
      const { saved, create } = watchSaves();
      const rendered = renderRoute(page, { accounts: [ana, claire] });
      const item = await billOfLading();
      await rendered.user.click(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );
      await content.received;

      await sessionChecksGoToClaireAndBack(rendered);
      expect(await billOfLading()).toBeDefined();
      content.release();
      await allAnswered(rendered.queryClient);

      expect(create).not.toHaveBeenCalled();
      expect(saved).toEqual([]);
    });

    it.each<[string, () => Response]>([
      ['succeeds', () => HttpResponse.json(aDocument(), { status: 201 })],
      ['answers 409', () => problem(409, 'Conflict', 'Revision 1 has been superseded.')],
    ])(
      'lets an upload sent before, which %s, touch nothing of her session',
      async (_case, respond) => {
        const state = servePage();
        const upload = serveUpload(respond, { hold: true });
        const rendered = renderRoute(page, { accounts: [ana, claire] });
        const { user, queryClient } = rendered;
        const before = await billOfLading();
        await chooseFile(user, before, aPdf());
        await user.click(before.getByRole('button', { name: 'Upload' }));
        await upload.received;

        await sessionChecksGoToClaireAndBack(rendered);
        const item = await billOfLading();
        expect(await item.findByText('Not uploaded yet')).toBeVisible();
        const documentRequests = state.documentRequests;
        const instructionRequests = state.instructionRequests;
        upload.release();
        await allAnswered(queryClient);

        expect(screen.queryByText(/has been uploaded/)).not.toBeInTheDocument();
        expect(item.getByText('Not uploaded yet')).toBeVisible();
        expect(state.documentRequests).toBe(documentRequests);
        expect(state.instructionRequests).toBe(instructionRequests);
        const [documents] = anasDocuments(queryClient);
        expect(documents?.state.data).toEqual({ items: [] });
        for (const query of protectedQueries(queryClient)) {
          expect(query.state.isInvalidated).toBe(false);
        }
      },
    );

    it('keeps Ana signed in, with her data, when a 401 sent before answers', async () => {
      servePage({ documents: [aDocument()] });
      const upload = serveUpload(() => problemResponse(401, 'Authentication is required.'), {
        hold: true,
      });
      const rendered = renderRoute(page, { accounts: [ana, claire] });
      const { router, user, session, queryClient } = rendered;
      const before = await billOfLading();
      await chooseFile(user, before, aPdf());
      await user.click(before.getByRole('button', { name: 'Upload as version 2' }));
      await upload.received;

      await sessionChecksGoToClaireAndBack(rendered);
      const item = await billOfLading();
      expect(item.getByText('Version 1')).toBeVisible();
      upload.release();
      await allAnswered(queryClient);

      expect(queryClient.getQueryData(['session'])).toEqual(ana);
      expect(router.state.location.pathname).toBe(page);
      expect(screen.queryByRole('heading', { name: 'Sign in to TradeFlow' })).toBeNull();
      expect(item.getByText('Version 1')).toBeVisible();
      const [documents] = anasDocuments(queryClient);
      expect(documents?.state.data).toEqual({ items: [aDocument()] });
      expect(session.signOutRequests).toBe(0);
    });

    it('keeps Claire when a session check sent under Ana answers after a check adopted Claire', async () => {
      servePage();
      const rendered = renderRoute(page, { accounts: [ana, claire] });
      const { session, queryClient } = rendered;
      expect(await billOfLading()).toBeDefined();
      // A check already on its way under Ana, as a sign-in's reconciliation makes one.
      const held = session.holdNext('me');
      const olderCheck = checkSession(queryClient);
      await held.received;

      await aSessionCheckFinds(rendered, claire);
      expect(await screen.findByText('Claire Morel')).toBeInTheDocument();
      held.release();

      await expect(olderCheck).rejects.toBeInstanceOf(StaleSessionCheckError);
      expect(queryClient.getQueryData(['session'])).toEqual(claire);
      expect(screen.getByText('Claire Morel')).toBeInTheDocument();
      expect(screen.queryByText('Ana Souza')).toBeNull();
    });

    it('saves a download when a session check only confirmed that Ana is still signed in', async () => {
      servePage({ documents: [aDocument()] });
      const bytes = pdfBytes(1000);
      const content = serveDownload(1, bytes, { hold: true });
      const { saved } = watchSaves();
      const rendered = renderRoute(page);
      const item = await billOfLading();
      await rendered.user.click(
        item.getByRole('button', { name: 'Download version 1 of the bill of lading' }),
      );
      await content.received;

      const checks = rendered.session.meRequests;
      await aSessionCheckFinds(rendered, ana);
      expect(rendered.session.meRequests).toBe(checks + 1);
      content.release();
      await allAnswered(rendered.queryClient);

      expect(saved.map(({ download }) => download)).toEqual(['bill-of-lading.pdf']);
      expect(new Uint8Array(await (saved[0]?.blob as Blob).arrayBuffer())).toEqual(bytes);
    });
  });
});
