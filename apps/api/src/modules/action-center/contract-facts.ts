import type { CurrentRevision } from '../documentary-instructions/current-revisions.js';
import type { LatestDocumentVersion } from '../documents/latest-document-versions.js';
import type { IssuedNotice } from '../notices/issued-notices.js';
import type { ContractInScope } from '../voyages/counterparty-contracts.js';
import type { ContractFacts } from './action-items.js';

/*
 * What the owning modules' readers return, assembled into the facts the rules take
 * (`action-items.ts`). The readers speak their own modules' terms and know nothing of actions;
 * this is the one place that translates. Each reader already left out history (acknowledged
 * notices, earlier revisions, earlier files), so every instruction carries exactly its current
 * revision and every document exactly its latest file.
 */

export interface ActionSources {
  contracts: readonly ContractInScope[];
  notices: readonly IssuedNotice[];
  revisions: readonly CurrentRevision[];
  documents: readonly LatestDocumentVersion[];
}

/** One `ContractFacts` per contract in scope; facts under any other contract are ignored. */
export function toContractFacts({
  contracts,
  notices,
  revisions,
  documents,
}: ActionSources): ContractFacts[] {
  const noticesOf = groupByContract(notices);
  const revisionOf = new Map(revisions.map((revision) => [revision.contractId, revision]));
  const documentsOf = groupByContract(documents);

  return contracts.map((contract) => {
    const revision = revisionOf.get(contract.id);
    return {
      id: contract.id,
      position: contract.position,
      voyage: contract.voyage,
      seller: contract.seller,
      buyer: contract.buyer,
      notices: (noticesOf.get(contract.id) ?? []).map((notice) => ({
        id: notice.id,
        status: 'ISSUED',
        issuedAt: notice.issuedAt,
        acknowledgementDueAt: notice.acknowledgementDueAt,
      })),
      instruction: revision
        ? {
            id: revision.instructionId,
            currentRevisionNumber: revision.revisionNumber,
            revisions: [
              {
                number: revision.revisionNumber,
                createdAt: revision.createdAt,
                acknowledgedAt: revision.acknowledgedAt,
              },
            ],
          }
        : null,
      documents: (documentsOf.get(contract.id) ?? []).map((document) => ({
        id: document.documentId,
        revisionNumber: document.revisionNumber,
        documentType: document.documentType,
        currentVersionNumber: document.versionNumber,
        versions: [
          {
            number: document.versionNumber,
            uploadedAt: document.uploadedAt,
            review: document.review,
          },
        ],
      })),
    };
  });
}

function groupByContract<T extends { contractId: string }>(rows: readonly T[]): Map<string, T[]> {
  const groups = new Map<string, T[]>();
  for (const row of rows) {
    const group = groups.get(row.contractId);
    if (group) group.push(row);
    else groups.set(row.contractId, [row]);
  }
  return groups;
}
