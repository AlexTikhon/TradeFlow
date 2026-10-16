import { createHash } from 'node:crypto';
import type { Readable } from 'node:stream';
import {
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  PayloadTooLargeException,
  PreconditionFailedException,
  UnauthorizedException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import {
  type ContractDocument,
  type CounterpartyContract,
  DOCUMENT_MEDIA_TYPE,
  type DocumentListResponse,
  MAX_DOCUMENT_BYTES,
  type RequiredDocumentType,
} from '@tradeflow/contracts';
import type { FileConsumer, FilePart } from '../../common/http/multipart-file.js';
import type { WritePrecondition } from '../../common/http/preconditions.js';
import { RequestValidationException } from '../../common/http/request-validation.exception.js';
import { Prisma } from '../../generated/prisma/client.js';
import { PrismaService } from '../../infrastructure/prisma/prisma.service.js';
import {
  DocumentStorage,
  type StagedObject,
} from '../../infrastructure/storage/document-storage.js';
import { AuditTrail } from '../audit/audit-trail.js';
import type { Principal } from '../auth/principal.js';
import { SessionPrincipals } from '../auth/session-principals.js';
import { requireOperator } from '../auth/user-permissions.js';
import {
  InstructionRevisions,
  type RevisionForDocuments,
} from '../documentary-instructions/instruction-revisions.js';
import { CounterpartyContracts } from '../voyages/counterparty-contracts.js';
import {
  DOCUMENT_TOO_LARGE,
  displayFileName,
  startsLikePdf,
  UploadInspection,
} from './document-rules.js';
import { byRevisionThenType, documentSelect, toDocument } from './document.read-model.js';
import { advanceDocumentVersion, createDocument, type DocumentKey } from './document.writes.js';

/** One document: a document type required by one revision of a contract's instructions. */
export interface DocumentTarget {
  voyageId: string;
  contractId: string;
  revisionNumber: number;
  documentType: RequiredDocumentType;
}

/** How the service receives the file of an upload: the HTTP layer streams it to `consumer`. */
export interface IncomingFile {
  receive<T>(consumer: FileConsumer<T>): Promise<T>;
}

/** A version's bytes, opened for download after they were checked against their checksum. */
export interface OpenedVersion {
  fileName: string;
  sizeBytes: number;
  sha256: Buffer;
  content: Readable;
}

/** The upload, received into staging and checked, not yet kept. */
interface ReceivedPdf {
  staged: StagedObject;
  fileName: string;
  sizeBytes: number;
  sha256: Buffer;
}

export const CONTRACT_NOT_FOUND = 'Contract was not found.';

/**
 * Document use cases (ADR 0013). Each takes the acting principal. Reads are scoped in the
 * database exactly as for documentary instructions: documents are loaded only under contracts
 * the voyages module resolved for the principal's organization as a counterparty.
 *
 * An upload crosses two stores that cannot commit together, so it runs in steps:
 *
 * 1. **Check** everything that can be checked before the bytes arrive (role, contract, side,
 *    revision, document type, precondition), so a refused upload is refused before it is read.
 * 2. **Receive** the bytes into storage's staging area, outside any database transaction,
 *    measuring and hashing them on the way, then check that they are a PDF.
 * 3. **Keep** them under a new server-generated key.
 * 4. **Commit** the version in one transaction, checking everything again (the session, the
 *    contract, and the revision, now share-locked), with one conditional write and the audit
 *    event. This is where a superseded revision or a lost race is finally decided.
 *
 * Whatever fails after step 2 is compensated: staged bytes are discarded, kept bytes removed
 * once the transaction has certainly rolled back. A crash between steps 3 and 4 leaves an object
 * no row names; the architecture describes how such orphans are found and removed.
 */
@Injectable()
export class DocumentsService {
  private readonly logger = new Logger(DocumentsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly contracts: CounterpartyContracts,
    private readonly revisions: InstructionRevisions,
    private readonly sessions: SessionPrincipals,
    private readonly storage: DocumentStorage,
    private readonly audit: AuditTrail,
  ) {}

  /**
   * The documents under the principal's organization's contracts on the voyage, in contract
   * order, newest revision first. Null when the voyage does not exist or the organization does
   * not participate in it; empty for a participant that is a party to no contract.
   */
  async list(principal: Principal, voyageId: string): Promise<DocumentListResponse | null> {
    // One snapshot for the contracts and every document and version (see the instructions).
    return this.prisma.$transaction(
      async (tx) => {
        const contracts = await this.contracts.listForVoyage(principal, voyageId, tx);
        if (!contracts) {
          return null;
        }
        const rows =
          contracts.length === 0
            ? []
            : await tx.document.findMany({
                where: { voyageId, tradeContractId: { in: contracts.map(({ id }) => id) } },
                select: documentSelect,
              });
        return {
          items: contracts.flatMap((contract) =>
            rows
              .filter((row) => row.tradeContractId === contract.id)
              .sort(byRevisionThenType)
              .map((row) => toDocument(row, contract)),
          ),
        };
      },
      { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
    );
  }

  /**
   * Adds a version: the first one (creating the document) when the precondition is `absent`,
   * the next one when it names the current version. Only an operator of the contract's seller
   * may, and only for the current revision of the instructions, for a document type it requires.
   * Null when the contract cannot be found for the principal's organization. The uploader and
   * time come from the session and the server's clock.
   */
  async upload(
    principal: Principal,
    target: DocumentTarget,
    precondition: WritePrecondition,
    incoming: IncomingFile,
  ): Promise<ContractDocument | null> {
    requireOperator(principal, 'upload documents');
    const contract = await this.contracts.findForVoyage(
      principal,
      target.voyageId,
      target.contractId,
    );
    if (!contract) {
      return null;
    }
    requireSeller(contract);
    checkOpen(await this.revisions.find(contract.id, target.revisionNumber), target);
    await this.checkPrecondition(key(contract, target), precondition);

    const received = await incoming.receive<ReceivedPdf>({
      accept: (part) => this.receivePdf(part),
      discard: (pdf) => this.storage.discard(pdf.staged),
    });
    let storageKey: string;
    try {
      storageKey = await this.storage.promote(received.staged);
    } catch (error) {
      await this.storage.discard(received.staged).catch((discardError: unknown) => {
        this.logger.error('Could not discard a staged upload', stack(discardError));
      });
      throw error;
    }
    return this.commit(principal, target, precondition, { ...received, storageKey });
  }

  /**
   * Version `versionNumber` of the document, opened for reading, if the principal's organization
   * is a party to its contract. Null alike for a contract, document or version that does not
   * exist and for one the organization may not see. The bytes are read once to check them
   * against their size and checksum before they are served: bytes that do not match what was
   * uploaded are a data error, never a download.
   */
  async openVersion(
    principal: Principal,
    target: DocumentTarget,
    versionNumber: number,
  ): Promise<OpenedVersion | null> {
    const contract = await this.contracts.findForVoyage(
      principal,
      target.voyageId,
      target.contractId,
    );
    if (!contract) {
      return null;
    }
    const version = await this.prisma.documentVersion.findFirst({
      where: {
        versionNumber,
        document: {
          tradeContractId: contract.id,
          revisionNumber: target.revisionNumber,
          documentType: target.documentType,
        },
      },
      select: { id: true, storageKey: true, fileName: true, sizeBytes: true, sha256: true },
    });
    if (!version) {
      return null;
    }
    const sha256 = Buffer.from(version.sha256);
    const stored = await measure(await this.storage.read(version.storageKey));
    if (stored.size !== version.sizeBytes || !stored.sha256.equals(sha256)) {
      throw new Error(`Stored bytes of document version ${version.id} do not match its checksum`);
    }
    return {
      fileName: version.fileName,
      sizeBytes: version.sizeBytes,
      sha256,
      content: await this.storage.read(version.storageKey),
    };
  }

  /** Receives the file into staging, then keeps it there only if it is a non-empty PDF. */
  private async receivePdf(part: FilePart): Promise<ReceivedPdf> {
    if (part.mediaType !== DOCUMENT_MEDIA_TYPE) {
      throw new UnsupportedMediaTypeException('Only PDF files are accepted.');
    }
    const inspection = new UploadInspection(
      MAX_DOCUMENT_BYTES,
      () => new PayloadTooLargeException(DOCUMENT_TOO_LARGE),
    );
    // Staging reports the inspection's errors while it runs; once it is done, a request that
    // fails later can still destroy the part, and with it the inspection, with nobody listening.
    inspection.on('error', () => undefined);
    // `pipe` does not pass errors on: a failed request must fail the staging too.
    const forward = (error: Error) => {
      inspection.destroy(error);
    };
    part.stream.once('error', forward);
    let staged: StagedObject;
    try {
      staged = await this.storage.stage(part.stream.pipe(inspection));
    } finally {
      part.stream.off('error', forward);
    }

    const refusal =
      inspection.size === 0
        ? new RequestValidationException([{ path: 'body.file', message: 'The file is empty.' }])
        : !startsLikePdf(inspection.head)
          ? new UnsupportedMediaTypeException(
              'The file is not a PDF: a PDF file starts with "%PDF-".',
            )
          : undefined;
    if (refusal) {
      await this.storage.discard(staged);
      throw refusal;
    }
    return {
      staged,
      fileName: displayFileName(part.fileName),
      sizeBytes: inspection.size,
      sha256: inspection.digest(),
    };
  }

  /**
   * Records the kept bytes as the document's next version, deciding everything again inside the
   * transaction. If the transaction fails, the kept bytes are removed, unless it failed while
   * committing, when it may have committed after all: those bytes stay, for reconciliation.
   */
  private async commit(
    principal: Principal,
    target: DocumentTarget,
    precondition: WritePrecondition,
    file: Omit<ReceivedPdf, 'staged'> & { storageKey: string },
  ): Promise<ContractDocument> {
    let committing = false;
    try {
      return await this.prisma.$transaction(async (tx) => {
        // The upload took time: act as the session is now, not as it was when the request came.
        const actor = await this.sessions.refresh(principal, tx);
        if (!actor) {
          throw new UnauthorizedException(
            'Your session ended before the upload completed. Sign in and upload the file again.',
          );
        }
        requireOperator(actor, 'upload documents');
        const contract = await this.contracts.findForVoyage(
          actor,
          target.voyageId,
          target.contractId,
          tx,
        );
        if (!contract) {
          throw new NotFoundException(CONTRACT_NOT_FOUND);
        }
        requireSeller(contract);
        // Share-locked until commit: no revision can supersede this one meanwhile.
        const revision = checkOpen(
          await this.revisions.lock(tx, contract.id, target.revisionNumber),
          target,
        );

        const at = new Date();
        const documentKey = key(contract, target);
        const document =
          precondition.kind === 'absent'
            ? await createDocument(tx, {
                ...documentKey,
                voyageId: target.voyageId,
                instructionId: revision.instructionId,
                at,
              })
            : await advanceDocumentVersion(tx, {
                ...documentKey,
                expectedVersions: precondition.versions,
                at,
              });
        if (!document) {
          // Read only to explain the refusal; the conditional write already decided it.
          throw new PreconditionFailedException(
            whyStale(precondition, await currentVersionOf(tx, documentKey)),
          );
        }

        const versionNumber = document.currentVersionNumber;
        await tx.documentVersion.create({
          data: {
            documentId: document.id,
            versionNumber,
            storageKey: file.storageKey,
            fileName: file.fileName,
            mediaType: DOCUMENT_MEDIA_TYPE,
            sizeBytes: file.sizeBytes,
            sha256: new Uint8Array(file.sha256),
            uploadedByUserId: actor.userId,
            uploadedByOrganizationId: actor.organizationId,
            uploadedAt: at,
          },
          select: { id: true },
        });
        await this.audit.record(tx, {
          action: 'DOCUMENT_VERSION_UPLOADED',
          actor,
          voyageId: target.voyageId,
          payload: {
            documentId: document.id,
            contractId: contract.id,
            instructionId: revision.instructionId,
            revisionNumber: target.revisionNumber,
            documentType: target.documentType,
            versionNumber,
            fileName: file.fileName,
            mediaType: DOCUMENT_MEDIA_TYPE,
            sizeBytes: file.sizeBytes,
            sha256: file.sha256.toString('hex'),
            uploadedAt: at.toISOString(),
          },
        });
        const written = await tx.document.findUniqueOrThrow({
          where: { id: document.id },
          select: documentSelect,
        });
        const response = toDocument(written, contract);
        // Everything above failed, if at all, before COMMIT was sent: a certain rollback.
        committing = true;
        return response;
      });
    } catch (error) {
      await this.compensate(file.storageKey, committing);
      throw error;
    }
  }

  private async compensate(storageKey: string, committing: boolean): Promise<void> {
    if (committing) {
      this.logger.error(
        `An upload failed while committing; its outcome is unknown, so object ${storageKey} is ` +
          'kept. If no document version names it, it is an orphan to reconcile.',
      );
      return;
    }
    try {
      await this.storage.remove(storageKey);
    } catch (error) {
      this.logger.error(
        `Could not remove object ${storageKey} after its upload was rolled back: it is an orphan ` +
          'to reconcile.',
        stack(error),
      );
    }
  }

  /** The precondition, judged against the document as it is now: fails early, decides nothing. */
  private async checkPrecondition(
    documentKey: DocumentKey,
    precondition: WritePrecondition,
  ): Promise<void> {
    const current = await currentVersionOf(this.prisma, documentKey);
    const holds =
      precondition.kind === 'absent'
        ? current === null
        : current !== null && precondition.versions.includes(current);
    if (!holds) {
      throw new PreconditionFailedException(whyStale(precondition, current));
    }
  }
}

const key = (contract: CounterpartyContract, target: DocumentTarget): DocumentKey => ({
  contractId: contract.id,
  revisionNumber: target.revisionNumber,
  documentType: target.documentType,
});

function requireSeller(contract: CounterpartyContract): void {
  if (contract.side !== 'SELLER') {
    throw new ForbiddenException('Only the seller under a contract may upload its documents.');
  }
}

/**
 * The revision, if it accepts documents of the target's type: it exists, it is the current
 * revision, and it requires that type.
 */
function checkOpen(
  revision: RevisionForDocuments | null,
  target: DocumentTarget,
): RevisionForDocuments {
  if (!revision) {
    throw new NotFoundException('Revision was not found.');
  }
  if (revision.revisionNumber < revision.currentRevisionNumber) {
    throw new ConflictException(
      `Revision ${revision.revisionNumber} has been superseded by revision ` +
        `${revision.currentRevisionNumber}; documents are presented against the current revision.`,
    );
  }
  if (!revision.requiredDocuments.includes(target.documentType)) {
    throw new NotFoundException(
      `Revision ${revision.revisionNumber} does not require a document of type ${target.documentType}.`,
    );
  }
  return revision;
}

async function currentVersionOf(
  db: Prisma.TransactionClient,
  { contractId, revisionNumber, documentType }: DocumentKey,
): Promise<number | null> {
  const document = await db.document.findUnique({
    where: {
      tradeContractId_revisionNumber_documentType: {
        tradeContractId: contractId,
        revisionNumber,
        documentType,
      },
    },
    select: { currentVersionNumber: true },
  });
  return document?.currentVersionNumber ?? null;
}

function whyStale(precondition: WritePrecondition, current: number | null): string {
  if (precondition.kind === 'absent') {
    return current === null
      ? 'The document could not be created.'
      : `This document already has version ${current}. Review it, then upload a replacement with If-Match: "${current}".`;
  }
  return current === null
    ? 'This document has no version yet. Upload the first one with If-None-Match: *.'
    : `The document has changed since the version you sent; it is now at version ${current}. Review the latest version before replacing it.`;
}

/** Size and SHA-256 of everything `content` yields. */
async function measure(content: Readable): Promise<{ size: number; sha256: Buffer }> {
  const hash = createHash('sha256');
  let size = 0;
  for await (const chunk of content) {
    const bytes = chunk as Buffer;
    size += bytes.length;
    hash.update(bytes);
  }
  return { size, sha256: hash.digest() };
}

const stack = (error: unknown) => (error instanceof Error ? error.stack : String(error));
