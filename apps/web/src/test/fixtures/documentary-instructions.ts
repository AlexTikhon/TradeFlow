import type {
  DocumentaryInstruction,
  DocumentaryInstructionRevision,
  InstructionActor,
} from '@tradeflow/contracts';
import { aCounterpartyContract } from './notices';
import { aVoyageDetail, tradeParties } from './voyages';

const { cerrado, lacustra } = tradeParties;

/** Claire operates for Lacustra, the buyer under contract 1; Ana for Cerrado, its seller. */
export const claireGives: InstructionActor = {
  name: 'Claire Morel',
  organization: lacustra.organization,
};
export const anaAcknowledges: InstructionActor = {
  name: 'Ana Souza',
  organization: cerrado.organization,
};

/** Typed against the shared contract, so fixtures cannot drift from what the API returns. */
export function aRevision(
  overrides: Partial<DocumentaryInstructionRevision> = {},
): DocumentaryInstructionRevision {
  return {
    number: 1,
    consignee: 'To order of Banco Exemplo S.A.',
    notifyParty: 'Lacustra Commodities SA\nRue du Rhône 1, Geneva',
    requirements: [
      { document: 'BILL_OF_LADING', originals: 3, copies: 3 },
      { document: 'PHYTOSANITARY_CERTIFICATE', originals: 1, copies: 0 },
    ],
    createdAt: '2030-10-15T12:00:00.000Z',
    createdBy: claireGives,
    acknowledgement: null,
    ...overrides,
  };
}

/** Instructions under contract 1 (Cerrado sells to Lacustra), as Cerrado, the seller, sees them. */
export function anInstruction(
  overrides: Partial<DocumentaryInstruction> = {},
): DocumentaryInstruction {
  return {
    id: '01990000-0000-7000-800a-000000000001',
    voyageId: aVoyageDetail().id,
    contract: aCounterpartyContract(),
    version: 1,
    currentRevision: aRevision(),
    previousRevisions: [],
    ...overrides,
  };
}

/** `revision` as acknowledged by `by` at `at`. */
export const acknowledgedRevision = (
  revision: DocumentaryInstructionRevision,
  by: InstructionActor = anaAcknowledges,
  at = '2030-10-16T13:30:00.000Z',
): DocumentaryInstructionRevision => ({
  ...revision,
  acknowledgement: { acknowledgedAt: at, acknowledgedBy: by },
});
