import {
  DocumentVersionNumberParamSchema,
  type DocumentVersionTarget,
  DocumentVersionTargetSchema,
  type InstructionRevisionTarget,
  InstructionRevisionTargetSchema,
  type NoticeTarget,
  NoticeTargetSchema,
  RevisionNumberParamSchema,
} from '@tradeflow/contracts';

/*
 * Links into a voyage's page that name one exact record (ADR 0017): an ETA notice, a revision of
 * the documentary instructions, or one file version of a document. They carry the identifiers of
 * the shared target contracts, so a link survives a reload and can be shared, and the page can
 * say what became of the record since the link was made.
 *
 * Whatever arrives in the address is untrusted: it is parsed back into a target with the same
 * schemas the API's targets satisfy, and a link that does not parse names nothing. Opening a link
 * only locates and shows a record; it never sends a command.
 */

export type RecordTarget = NoticeTarget | InstructionRevisionTarget | DocumentVersionTarget;

/** The `open` parameter: which kind of record the link names. */
const OPEN: Record<RecordTarget['kind'], string> = {
  NOTICE: 'notice',
  INSTRUCTION_REVISION: 'instruction-revision',
  DOCUMENT_VERSION: 'document-version',
};

/** Every parameter a record link uses. Any of them in the address means a link was meant. */
const LINK_PARAMS = [
  'open',
  'contract',
  'notice',
  'instruction',
  'revision',
  'documentType',
  'document',
  'version',
] as const;

/** The path that opens `target` on its voyage's page. */
export function recordLinkPath(target: RecordTarget): string {
  const params = new URLSearchParams({ open: OPEN[target.kind], contract: target.contractId });
  switch (target.kind) {
    case 'NOTICE':
      params.set('notice', target.noticeId);
      break;
    case 'INSTRUCTION_REVISION':
      params.set('instruction', target.instructionId);
      params.set('revision', String(target.revisionNumber));
      break;
    case 'DOCUMENT_VERSION':
      params.set('revision', String(target.revisionNumber));
      params.set('documentType', target.documentType);
      params.set('document', target.documentId);
      params.set('version', String(target.versionNumber));
      break;
  }
  return `/voyages/${encodeURIComponent(target.voyageId)}?${params.toString()}`;
}

/** What the address asks the voyage page to open. */
export type RequestedRecord =
  /** No link: the page as usual. */
  | { status: 'none' }
  /** Some link parameters, but they do not name a record. */
  | { status: 'malformed' }
  /** `key` tells requests apart: the same record asked for again has the same key. */
  | { status: 'valid'; target: RecordTarget; key: string };

const NONE: RequestedRecord = { status: 'none' };
const MALFORMED: RequestedRecord = { status: 'malformed' };

/**
 * Reads the record link in `search`, on the page of voyage `voyageId` (already validated). Every
 * parameter must appear at most once; a repeated one makes the link ambiguous, so malformed.
 */
export function parseRecordLink(voyageId: string, search: URLSearchParams): RequestedRecord {
  if (!LINK_PARAMS.some((name) => search.has(name))) return NONE;
  if (LINK_PARAMS.some((name) => search.getAll(name).length > 1)) return MALFORMED;
  const param = (name: (typeof LINK_PARAMS)[number]) => search.get(name) ?? undefined;
  const revisionNumber = RevisionNumberParamSchema.safeParse(param('revision')).data;

  let parsed;
  switch (param('open')) {
    case OPEN.NOTICE:
      parsed = NoticeTargetSchema.safeParse({
        kind: 'NOTICE',
        voyageId,
        contractId: param('contract'),
        noticeId: param('notice'),
      });
      break;
    case OPEN.INSTRUCTION_REVISION:
      parsed = InstructionRevisionTargetSchema.safeParse({
        kind: 'INSTRUCTION_REVISION',
        voyageId,
        contractId: param('contract'),
        instructionId: param('instruction'),
        revisionNumber,
      });
      break;
    case OPEN.DOCUMENT_VERSION:
      parsed = DocumentVersionTargetSchema.safeParse({
        kind: 'DOCUMENT_VERSION',
        voyageId,
        contractId: param('contract'),
        revisionNumber,
        documentType: param('documentType'),
        documentId: param('document'),
        versionNumber: DocumentVersionNumberParamSchema.safeParse(param('version')).data,
      });
      break;
    default:
      return MALFORMED;
  }
  return parsed.success
    ? { status: 'valid', target: parsed.data, key: recordLinkPath(parsed.data) }
    : MALFORMED;
}
