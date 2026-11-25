import {
  type CommodityListResponse,
  CommodityListResponseSchema,
  type ContractDocument,
  ContractDocumentSchema,
  CounterpartyContractListResponseSchema,
  type CurrentUser,
  CurrentUserSchema,
  DOCUMENT_FILE_FIELD,
  DOCUMENT_MEDIA_TYPE,
  type DocumentaryInstructionContent,
  DocumentaryInstructionSchema,
  DocumentListResponseSchema,
  documentEntityTag,
  instructionEntityTag,
  OrganizationSearchResponseSchema,
  type PortListResponse,
  PortListResponseSchema,
  ProblemDetailsSchema,
  type RequiredDocumentType,
  type ReviewDocumentVersionRequest,
  TradeStringSchema,
  type VesselListResponse,
  VesselListResponseSchema,
  VoyageDetailSchema,
} from '@tradeflow/contracts';
import type { Party } from '../support/scenario.js';
import { ANA, WEI_LING } from './accounts.js';
import type { Preparation, PreparedApp } from './demo-run.js';
import { SHOWCASE_FILES, type ShowcaseFile } from './portfolio-files.js';

/*
 * The portfolio showcase (`pnpm demo:portfolio`): one more voyage on top of the unchanged demo
 * seed, between Ana Souza (Cerrado, seller) and Tan Wei Ling (Meridian, buyer), with a document
 * workflow already under way. It is built after the API is up, through the same authenticated
 * HTTP commands the web app sends, as those two users: sign-in with the production admission
 * defaults, every write conditional on the entity tag the writer last read, every answer checked
 * against the shared contracts. No row is written directly and no endpoint exists for it; the
 * API assigns every id, reference, version and timestamp, so only the meaning repeats between
 * runs:
 *
 *   revision 1 of the instructions, acknowledged by Ana, requires four documents:
 *   - commercial invoice:     not uploaded;
 *   - certificate of origin:  version 1 uploaded, awaiting Wei Ling's review;
 *   - weight certificate:     version 1 rejected, with a reason, awaiting Ana's replacement;
 *   - bill of lading:         version 1 rejected, version 2 uploaded and approved.
 *
 * Session tokens stay inside this module: they are sent as a Cookie header, never logged, and
 * both sessions are signed out at the end.
 */

/** The voyage the showcase built, as the browser addresses it. */
export interface Showcase {
  voyageId: string;
  reference: string;
}

export const SHOWCASE_CONSIGNEE = 'To order of Banco Austral Demo S.A.';
export const SHOWCASE_NOTIFY_PARTY = 'Meridian Agri Trading Pte. Ltd., Singapore';

/** The buyer's reasons, fictional, as the browser shows them. */
export const SHOWCASE_REASONS = {
  weightCertificate:
    'Net weight of 44,850.000 MT does not match the contract quantity of 45,000.000 MT. ' +
    'Please reissue the certificate with the final draft-survey figure.',
  billOfLading:
    `The consignee must read "${SHOWCASE_CONSIGNEE}" as instructed in revision 1; ` +
    'version 1 names Meridian directly.',
} as const;

const INSTRUCTIONS: DocumentaryInstructionContent = {
  consignee: SHOWCASE_CONSIGNEE,
  notifyParty: SHOWCASE_NOTIFY_PARTY,
  requirements: [
    { document: 'COMMERCIAL_INVOICE', originals: 1, copies: 3 },
    { document: 'CERTIFICATE_OF_ORIGIN', originals: 1, copies: 2 },
    { document: 'WEIGHT_CERTIFICATE', originals: 1, copies: 2 },
    { document: 'BILL_OF_LADING', originals: 3, copies: 2 },
  ],
};

/** Shipment facts, by the seeded reference data's natural keys. */
const SHIPMENT = {
  vesselImo: '9703253', // MV Baltic Grace
  commodityCode: 'SOYBEANS',
  loadPort: 'BRSSZ', // Santos
  dischargePort: 'CNDLC', // Dalian
  quantity: '45000',
  /** The laycan, in days from the day the showcase is prepared (UTC). */
  laycanDays: [21, 30],
} as const;

/** How long one request may take before preparation fails. */
const REQUEST_TIMEOUT_MS = 30_000;

// ── HTTP ───────────────────────────────────────────────────────────────────────────────────────

interface Schema<T> {
  parse(data: unknown): T;
}

function parse<T>(schema: Schema<T>, body: unknown, what: string): T {
  try {
    return schema.parse(body);
  } catch (error) {
    throw new Error(
      `${what} does not match the shared contract: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}

function check(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(`Showcase preparation: ${message}`);
}

interface Answer {
  headers: Headers;
  body: unknown;
}

interface RequestOptions {
  json?: unknown;
  form?: FormData;
  headers?: Record<string, string>;
  /** The only status accepted; any other fails preparation. */
  expected: number;
}

/** One signed-in user's session. Its cookie never leaves this class. */
class Session {
  private cookie: string | undefined;

  private constructor(
    private readonly apiUrl: string,
    private readonly signal: AbortSignal | undefined,
    readonly party: Party,
  ) {}

  /** Signs `party` in with their published demo password, as the sign-in form does. */
  static async signIn(context: PreparedApp, party: Party): Promise<[Session, CurrentUser]> {
    const session = new Session(context.apiUrl, context.signal, party);
    const { headers, body } = await session.send('POST', '/api/auth/sign-in', {
      json: { email: party.email, password: party.password },
      expected: 200,
    });
    // Only the cookie's name=value pair is kept, and only in memory.
    session.cookie = headers
      .getSetCookie()
      .map((cookie) => cookie.split(';')[0]?.trim() ?? '')
      .find((pair) => /^(__Host-)?tradeflow_session=./.test(pair));
    check(session.cookie !== undefined, `signing in ${party.fullName} set no session cookie`);
    const identity = parse(CurrentUserSchema, body, `${party.fullName}'s sign-in answer`);
    check(
      identity.user.email === party.email &&
        identity.organization.name === party.organizationName &&
        identity.user.role === 'OPERATOR',
      `${party.email} did not sign in as an operator of ${party.organizationName}`,
    );
    return [session, identity];
  }

  async send(method: string, path: string, options: RequestOptions): Promise<Answer> {
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(new URL(path, this.apiUrl), {
      method,
      headers: {
        accept: 'application/json',
        ...(options.json !== undefined && { 'content-type': 'application/json' }),
        ...(this.cookie !== undefined && { cookie: this.cookie }),
        ...options.headers,
      },
      ...(options.json !== undefined && { body: JSON.stringify(options.json) }),
      ...(options.form !== undefined && { body: options.form }),
      redirect: 'error',
      signal: this.signal ? AbortSignal.any([this.signal, timeout]) : timeout,
    });
    const text = await response.text();
    const body: unknown = text === '' ? undefined : JSON.parse(text);
    if (response.status !== options.expected) {
      const problem = ProblemDetailsSchema.safeParse(body);
      const said = problem.success
        ? `${problem.data.title}${problem.data.detail ? `: ${problem.data.detail}` : ''}`
        : text.slice(0, 300);
      throw new Error(
        `Showcase preparation: ${method} ${path} as ${this.party.fullName} answered ` +
          `${response.status}, expected ${options.expected}. ${said}`,
      );
    }
    return { headers: response.headers, body };
  }

  get(path: string): Promise<Answer> {
    return this.send('GET', path, { expected: 200 });
  }

  /** Revokes the session on the server; the cookie is forgotten either way. */
  async signOut(): Promise<void> {
    if (this.cookie === undefined) return;
    try {
      await this.send('POST', '/api/auth/sign-out', { expected: 204 });
    } finally {
      this.cookie = undefined;
    }
  }
}

/** The answer's entity tag, which must be the one its body's version gives. */
function expectEntityTag(headers: Headers, expected: string, what: string): void {
  const tag = headers.get('etag');
  check(tag === expected, `${what} answered ETag ${String(tag)}, expected ${expected}`);
}

// ── The showcase ───────────────────────────────────────────────────────────────────────────────

const isoDay = (daysFromNow: number) =>
  new Date(Date.now() + daysFromNow * 86_400_000).toISOString().slice(0, 10);

/**
 * Creates the showcase voyage and its document workflow through the API, and checks the result.
 * Throws on the first answer that is not what the scenario expects; the caller then discards the
 * whole environment.
 */
export async function preparePortfolioShowcase(context: PreparedApp): Promise<Showcase> {
  const sessions: Session[] = [];
  try {
    const [ana, anaIdentity] = await Session.signIn(context, ANA);
    sessions.push(ana);
    const [wei] = await Session.signIn(context, WEI_LING);
    sessions.push(wei);

    // ── Ana creates the voyage from the seeded reference data, and sets up its trade string.
    const vessels: VesselListResponse = parse(
      VesselListResponseSchema,
      (await ana.get('/api/vessels')).body,
      'The vessel list',
    );
    const commodities: CommodityListResponse = parse(
      CommodityListResponseSchema,
      (await ana.get('/api/commodities')).body,
      'The commodity list',
    );
    const ports: PortListResponse = parse(
      PortListResponseSchema,
      (await ana.get('/api/ports')).body,
      'The port list',
    );
    const vessel = vessels.items.find((item) => item.imoNumber === SHIPMENT.vesselImo);
    const commodity = commodities.items.find((item) => item.code === SHIPMENT.commodityCode);
    const loadPort = ports.items.find((item) => item.unLocode === SHIPMENT.loadPort);
    const dischargePort = ports.items.find((item) => item.unLocode === SHIPMENT.dischargePort);
    check(
      vessel !== undefined &&
        commodity !== undefined &&
        loadPort !== undefined &&
        dischargePort !== undefined,
      'the seeded vessel, commodity or ports are missing',
    );

    const created = await ana.send('POST', '/api/voyages', {
      json: {
        vesselId: vessel.id,
        commodityId: commodity.id,
        quantity: { amount: SHIPMENT.quantity, unit: 'MT' },
        loadPortId: loadPort.id,
        dischargePortId: dischargePort.id,
        laycan: { start: isoDay(SHIPMENT.laycanDays[0]), end: isoDay(SHIPMENT.laycanDays[1]) },
      },
      expected: 201,
    });
    const voyage = parse(VoyageDetailSchema, created.body, 'The created voyage');
    check(
      created.headers.get('location') === `/api/voyages/${voyage.id}`,
      'the created voyage has no Location',
    );
    check(
      voyage.status === 'PLANNED' && /^TF-\d{4}-\d{4,}$/.test(voyage.reference),
      `the voyage was created as ${voyage.status} ${voyage.reference}`,
    );
    const voyagePath = `/api/voyages/${voyage.id}`;

    const found = parse(
      OrganizationSearchResponseSchema,
      (await ana.get(`/api/organizations?search=${encodeURIComponent('Meridian')}`)).body,
      'The organization search',
    );
    const meridian = found.items.find((item) => item.name === WEI_LING.organizationName);
    check(meridian !== undefined, `${WEI_LING.organizationName} was not found`);

    // The trade string has no entity tag; the API documents that setup needs no precondition.
    const configured = await ana.send('POST', `${voyagePath}/trade-string`, {
      json: {
        parties: [{ organizationId: anaIdentity.organization.id }, { organizationId: meridian.id }],
      },
      expected: 200,
    });
    const tradeString = parse(TradeStringSchema, configured.body, 'The trade string');
    check(
      tradeString.edges.length === 1 &&
        tradeString.edges[0]?.sellerOrganizationId === anaIdentity.organization.id &&
        tradeString.edges[0].buyerOrganizationId === meridian.id,
      'the trade string is not Cerrado → Meridian',
    );

    // ── Wei Ling, now a participant, gives the instructions under her contract.
    const contracts = parse(
      CounterpartyContractListResponseSchema,
      (await wei.get(`${voyagePath}/my-contracts`)).body,
      "Wei Ling's contracts",
    );
    const [contract] = contracts.items;
    check(
      contracts.items.length === 1 && contract?.side === 'BUYER' && contract.position === 1,
      'Wei Ling is not the buyer under the only contract',
    );
    const instructionPath = `${voyagePath}/contracts/${contract.id}/documentary-instructions`;

    const given = await wei.send('PUT', instructionPath, {
      json: INSTRUCTIONS,
      headers: { 'if-none-match': '*' },
      expected: 201,
    });
    const instruction = parse(DocumentaryInstructionSchema, given.body, 'The given instructions');
    expectEntityTag(
      given.headers,
      instructionEntityTag(instruction.version),
      'Giving instructions',
    );
    check(
      instruction.currentRevision.number === 1 &&
        instruction.currentRevision.acknowledgement === null,
      'the instructions are not an unacknowledged revision 1',
    );

    // ── Ana reads them and acknowledges revision 1, on the version she read.
    const read = await ana.get(instructionPath);
    const seen = parse(DocumentaryInstructionSchema, read.body, "Ana's read of the instructions");
    const seenTag = instructionEntityTag(seen.version);
    expectEntityTag(read.headers, seenTag, 'Reading the instructions');
    const acknowledged = await ana.send(
      'POST',
      `${instructionPath}/revisions/${seen.currentRevision.number}/acknowledgement`,
      { json: {}, headers: { 'if-match': seenTag }, expected: 200 },
    );
    const afterAcknowledgement = parse(
      DocumentaryInstructionSchema,
      acknowledged.body,
      'The acknowledged instructions',
    );
    expectEntityTag(
      acknowledged.headers,
      instructionEntityTag(afterAcknowledgement.version),
      'Acknowledging',
    );
    check(
      afterAcknowledgement.currentRevision.acknowledgement?.acknowledgedBy.name === ANA.fullName,
      'revision 1 is not acknowledged by Ana',
    );

    // ── Documents against revision 1.
    const documentPath = (type: RequiredDocumentType) =>
      `${instructionPath}/revisions/1/documents/${type}`;

    /** The document of `type` as `session` reads it now: the basis of its next write. */
    const readDocument = async (session: Session, type: RequiredDocumentType) => {
      const list = parse(
        DocumentListResponseSchema,
        (await session.get(`${voyagePath}/documents`)).body,
        `${session.party.fullName}'s document list`,
      );
      const document = list.items.find(
        (item) =>
          item.contract.id === contract.id &&
          item.revisionNumber === 1 &&
          item.documentType === type,
      );
      check(document !== undefined, `${session.party.fullName} cannot read the ${type}`);
      return document;
    };

    /** Ana uploads `file` as file version `fileVersion`: the first, or a replacement. */
    const upload = async (type: RequiredDocumentType, file: ShowcaseFile, fileVersion: number) => {
      const basis = fileVersion === 1 ? null : await readDocument(ana, type);
      const form = new FormData();
      form.append(
        DOCUMENT_FILE_FIELD,
        new Blob([new Uint8Array(file.bytes)], { type: DOCUMENT_MEDIA_TYPE }),
        file.fileName,
      );
      const answer = await ana.send('POST', `${documentPath(type)}/versions`, {
        form,
        headers:
          basis === null
            ? { 'if-none-match': '*' }
            : { 'if-match': documentEntityTag(basis.version) },
        expected: 201,
      });
      const document = parse(ContractDocumentSchema, answer.body, `The uploaded ${type}`);
      const { currentVersion } = document;
      expectEntityTag(answer.headers, documentEntityTag(document.version), `Uploading the ${type}`);
      check(
        answer.headers.get('location') ===
          `${documentPath(type)}/versions/${currentVersion.number}/content`,
        `the uploaded ${type} has no Location`,
      );
      check(
        document.documentType === type &&
          currentVersion.number === fileVersion &&
          currentVersion.fileName === file.fileName &&
          currentVersion.sizeBytes === file.bytes.length &&
          currentVersion.sha256 === file.sha256 &&
          currentVersion.review === null,
        `${type} version ${fileVersion} was not stored as sent`,
      );
    };

    /** Wei Ling decides on the latest file of `type`, on the version she read. */
    const review = async (
      type: RequiredDocumentType,
      fileVersion: number,
      decision: ReviewDocumentVersionRequest,
    ) => {
      const basis = await readDocument(wei, type);
      check(
        basis.currentVersion.number === fileVersion && basis.currentVersion.review === null,
        `${type} version ${fileVersion} is not awaiting a decision`,
      );
      const answer = await wei.send(
        'POST',
        `${documentPath(type)}/versions/${fileVersion}/review`,
        {
          json: decision,
          headers: { 'if-match': documentEntityTag(basis.version) },
          expected: 200,
        },
      );
      const document = parse(ContractDocumentSchema, answer.body, `The reviewed ${type}`);
      expectEntityTag(answer.headers, documentEntityTag(document.version), `Reviewing the ${type}`);
      check(
        document.currentVersion.review?.decision === decision.decision,
        `${type} version ${fileVersion} was not ${decision.decision.toLowerCase()}`,
      );
    };

    await upload('CERTIFICATE_OF_ORIGIN', SHOWCASE_FILES.certificateOfOrigin, 1);
    await upload('WEIGHT_CERTIFICATE', SHOWCASE_FILES.weightCertificate, 1);
    await upload('BILL_OF_LADING', SHOWCASE_FILES.billOfLadingV1, 1);
    await review('WEIGHT_CERTIFICATE', 1, {
      decision: 'REJECTED',
      reason: SHOWCASE_REASONS.weightCertificate,
    });
    await review('BILL_OF_LADING', 1, {
      decision: 'REJECTED',
      reason: SHOWCASE_REASONS.billOfLading,
    });
    await upload('BILL_OF_LADING', SHOWCASE_FILES.billOfLadingV2, 2);
    await review('BILL_OF_LADING', 2, { decision: 'APPROVED' });

    // ── The result, as the buyer reads it.
    const final = parse(
      DocumentListResponseSchema,
      (await wei.get(`${voyagePath}/documents`)).body,
      'The final document list',
    );
    expectShowcaseDocuments(final.items);

    return { voyageId: voyage.id, reference: voyage.reference };
  } finally {
    // Best effort: the environment is discarded with its sessions anyway.
    for (const session of sessions) await session.signOut().catch(() => undefined);
  }
}

/**
 * The web app's portfolio onboarding (apps/web/src/features/portfolio-demo): switched on only by
 * this build mode, and pointed at the showcase by this file in the run's own web build. The web
 * app reads the file with a schema of its own, kept in step with this one by the verification,
 * which follows the guide's link to this voyage.
 */
export const PORTFOLIO_WEB_MODE = 'portfolio-demo';
export const SHOWCASE_METADATA_FILE = 'portfolio-demo.json';

/** What the web app may know of the showcase: where it is, nothing that grants anything. */
export const showcaseMetadata = (showcase: Showcase) => ({
  schemaVersion: 1,
  showcase: { voyageId: showcase.voyageId, reference: showcase.reference },
});

/**
 * The portfolio profile: the web app built with its onboarding, and the showcase as the demo's
 * last startup step (demo-run.ts), published to the web app as metadata.
 */
export const PORTFOLIO_PROFILE: Preparation<Showcase> = {
  step: 'Preparing the portfolio showcase voyage through the API, as Ana Souza and Tan Wei Ling',
  webMode: PORTFOLIO_WEB_MODE,
  run: preparePortfolioShowcase,
  webMetadata: (showcase) => ({
    fileName: SHOWCASE_METADATA_FILE,
    content: showcaseMetadata(showcase),
  }),
};

/** The four states the showcase promises, checked on the API's own answer. */
function expectShowcaseDocuments(documents: ContractDocument[]): void {
  const byType = new Map(documents.map((document) => [document.documentType, document]));
  check(documents.length === 3, `expected 3 documents, found ${documents.length}`);
  check(!byType.has('COMMERCIAL_INVOICE'), 'the commercial invoice was uploaded');

  const origin = byType.get('CERTIFICATE_OF_ORIGIN');
  check(
    origin?.currentVersion.number === 1 &&
      origin.previousVersions.length === 0 &&
      origin.currentVersion.review === null,
    'the certificate of origin is not version 1 awaiting review',
  );

  const weight = byType.get('WEIGHT_CERTIFICATE');
  check(
    weight?.currentVersion.number === 1 &&
      weight.currentVersion.review?.decision === 'REJECTED' &&
      weight.currentVersion.review.reason === SHOWCASE_REASONS.weightCertificate,
    'the weight certificate is not version 1, rejected with its reason',
  );

  const bill = byType.get('BILL_OF_LADING');
  const [first] = bill?.previousVersions ?? [];
  check(
    bill?.currentVersion.number === 2 &&
      bill.currentVersion.review?.decision === 'APPROVED' &&
      bill.currentVersion.sha256 === SHOWCASE_FILES.billOfLadingV2.sha256 &&
      bill.previousVersions.length === 1 &&
      first?.number === 1 &&
      first.review?.decision === 'REJECTED' &&
      first.review.reason === SHOWCASE_REASONS.billOfLading &&
      first.sha256 === SHOWCASE_FILES.billOfLadingV1.sha256,
    'the bill of lading is not version 2 approved over version 1 rejected',
  );
}
