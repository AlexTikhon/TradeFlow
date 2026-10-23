import type {
  ContractDocument,
  CounterpartyContract,
  DocumentaryInstruction,
  DocumentaryInstructionRevision,
  DocumentVersion,
  Notice,
} from '@tradeflow/contracts';
import type { RecordTarget, RequestedRecord } from './record-link';

/** The record a link named, as the organization reads it now. */
export type LinkedRecord =
  | { kind: 'NOTICE'; contract: CounterpartyContract; notice: Notice }
  | {
      kind: 'INSTRUCTION_REVISION';
      contract: CounterpartyContract;
      instruction: DocumentaryInstruction;
      revision: DocumentaryInstructionRevision;
      /** Whether it is still the revision in force. */
      current: boolean;
    }
  | {
      kind: 'DOCUMENT_VERSION';
      contract: CounterpartyContract;
      instruction: DocumentaryInstruction;
      document: ContractDocument;
      version: DocumentVersion;
      /** Whether the document answers the revision in force. */
      revisionCurrent: boolean;
      /** Whether the version is still the document's latest file. */
      latest: boolean;
    };

/** Where a link stands against the records the page has. */
export type LinkResolution =
  | { status: 'none' }
  | { status: 'malformed' }
  /** Something it needs is still on its way. */
  | { status: 'loading' }
  /** Something it needs could not be loaded; the page's own sections offer a retry. */
  | { status: 'failed' }
  /** Nothing the organization can read on this voyage matches every identifier. */
  | { status: 'unavailable' }
  | { status: 'resolved'; record: LinkedRecord };

/** A query's state, as far as resolution needs it. */
interface Source<T> {
  data: T | undefined;
  error: Error | null;
}

export interface LinkSources {
  voyage: Source<unknown>;
  contracts: Source<{ items: CounterpartyContract[] }>;
  notices: Source<{ items: Notice[] }>;
  instructions: Source<{ items: DocumentaryInstruction[] }>;
  documents: Source<{ items: ContractDocument[] }>;
}

const LOADING: LinkResolution = { status: 'loading' };
const FAILED: LinkResolution = { status: 'failed' };
const UNAVAILABLE: LinkResolution = { status: 'unavailable' };

/** What a link needs loaded before it can be located: never more than its kind reads. */
const NEEDS: Record<RecordTarget['kind'], readonly (keyof LinkSources)[]> = {
  NOTICE: ['voyage', 'contracts', 'notices'],
  INSTRUCTION_REVISION: ['voyage', 'contracts', 'instructions'],
  DOCUMENT_VERSION: ['voyage', 'contracts', 'instructions', 'documents'],
};

/**
 * Locates the record `requested` names among what the organization can read on the voyage. Every
 * identifier in the link must match the record found (its contract, and for a document its
 * revision and type too); a record that differs in any is not the one the link meant, and none
 * other stands in for it. A record that has moved on (acknowledged, decided, superseded,
 * replaced) is still the one named, and is returned as it is now.
 */
export function resolveRecordLink(
  requested: RequestedRecord,
  sources: LinkSources,
): LinkResolution {
  if (requested.status !== 'valid') return requested;
  const { target } = requested;

  const needed = NEEDS[target.kind].map((name) => sources[name]);
  if (needed.some((source) => source.data === undefined)) {
    return needed.some((source) => source.data === undefined && source.error) ? FAILED : LOADING;
  }

  const contract = sources.contracts.data?.items.find(({ id }) => id === target.contractId);
  if (!contract) return UNAVAILABLE;

  if (target.kind === 'NOTICE') {
    const notice = sources.notices.data?.items.find(
      ({ id, contract: { id: contractId } }) =>
        id === target.noticeId && contractId === target.contractId,
    );
    return notice
      ? { status: 'resolved', record: { kind: 'NOTICE', contract, notice } }
      : UNAVAILABLE;
  }

  const instruction = sources.instructions.data?.items.find(
    ({ contract: { id: contractId } }) => contractId === target.contractId,
  );
  if (!instruction) return UNAVAILABLE;
  const current = instruction.currentRevision.number;

  if (target.kind === 'INSTRUCTION_REVISION') {
    const revision = [instruction.currentRevision, ...instruction.previousRevisions].find(
      ({ number }) => number === target.revisionNumber,
    );
    if (instruction.id !== target.instructionId || !revision) return UNAVAILABLE;
    return {
      status: 'resolved',
      record: {
        kind: 'INSTRUCTION_REVISION',
        contract,
        instruction,
        revision,
        current: revision.number === current,
      },
    };
  }

  const document = sources.documents.data?.items.find(
    (candidate) =>
      candidate.id === target.documentId &&
      candidate.contract.id === target.contractId &&
      candidate.revisionNumber === target.revisionNumber &&
      candidate.documentType === target.documentType,
  );
  const version =
    document &&
    [document.currentVersion, ...document.previousVersions].find(
      ({ number }) => number === target.versionNumber,
    );
  if (!document || !version) return UNAVAILABLE;
  return {
    status: 'resolved',
    record: {
      kind: 'DOCUMENT_VERSION',
      contract,
      instruction,
      document,
      version,
      revisionCurrent: document.revisionNumber === current,
      latest: version.number === document.currentVersion.number,
    },
  };
}
