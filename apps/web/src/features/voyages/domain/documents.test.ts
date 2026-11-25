import type {
  ContractDocument,
  DocumentaryInstructionRevision,
  RequiredDocumentType,
} from '@tradeflow/contracts';
import { describe, expect, it } from 'vitest';
import { aRevision } from '../../../test/fixtures/documentary-instructions';
import { aDocument, replacedBy, reviewedAs } from '../../../test/fixtures/documents';
import { aCounterpartyContract, lacustraSellsToNordlys } from '../../../test/fixtures/notices';
import { summarizeDocumentSet } from './documents';

const contract = aCounterpartyContract();

/** Revision `number`, requiring each of `types` (one original, two copies unless stated). */
const requiring = (
  types: RequiredDocumentType[],
  number = 1,
  counts = { originals: 1, copies: 2 },
): DocumentaryInstructionRevision =>
  aRevision({ number, requirements: types.map((document) => ({ document, ...counts })) });

/** A first file of `type` presented against revision `revisionNumber` of contract 1. */
const presented = (type: RequiredDocumentType, revisionNumber = 1): ContractDocument =>
  aDocument({
    id: `${type}-${revisionNumber}`,
    documentType: type,
    revisionNumber,
  });

const approved = (document: ContractDocument) => reviewedAs(document);
const rejected = (document: ContractDocument) =>
  reviewedAs(document, { decision: 'REJECTED', reason: 'Wrong consignee.' });

const summary = (documents: ContractDocument[], revision: DocumentaryInstructionRevision) =>
  summarizeDocumentSet(documents, contract.id, revision);

const FOUR: RequiredDocumentType[] = [
  'COMMERCIAL_INVOICE',
  'CERTIFICATE_OF_ORIGIN',
  'WEIGHT_CERTIFICATE',
  'BILL_OF_LADING',
];

describe('summarizeDocumentSet', () => {
  it('classifies the portfolio scenario: one missing, pending, rejected and approved; 1 of 4', () => {
    const documents = [
      presented('CERTIFICATE_OF_ORIGIN'),
      rejected(presented('WEIGHT_CERTIFICATE')),
      approved(replacedBy(rejected(presented('BILL_OF_LADING')))),
    ];

    expect(summary(documents, requiring(FOUR))).toEqual({
      required: 4,
      missing: 1,
      pending: 1,
      rejected: 1,
      approved: 1,
      allApproved: false,
    });
  });

  it('counts every required document as missing when nothing was presented', () => {
    expect(summary([], requiring(FOUR))).toEqual({
      required: 4,
      missing: 4,
      pending: 0,
      rejected: 0,
      approved: 0,
      allApproved: false,
    });
  });

  it('is all approved only when every latest file is approved', () => {
    const documents = FOUR.map((type) => approved(presented(type)));
    expect(summary(documents, requiring(FOUR))).toMatchObject({
      required: 4,
      approved: 4,
      allApproved: true,
    });
    expect(summary(documents.slice(1), requiring(FOUR))).toMatchObject({
      missing: 1,
      approved: 3,
      allApproved: false,
    });
  });

  it('turns an approved document pending when its file is replaced', () => {
    const revision = requiring(['BILL_OF_LADING']);
    const first = approved(presented('BILL_OF_LADING'));
    expect(summary([first], revision)).toMatchObject({ approved: 1, allApproved: true });

    expect(summary([replacedBy(first)], revision)).toEqual({
      required: 1,
      missing: 0,
      pending: 1,
      rejected: 0,
      approved: 0,
      allApproved: false,
    });
  });

  it('follows a rejection, a replacement and a later approval', () => {
    const revision = requiring(['BILL_OF_LADING']);
    const first = rejected(presented('BILL_OF_LADING'));
    const second = replacedBy(first);

    expect(summary([first], revision)).toMatchObject({ rejected: 1, allApproved: false });
    expect(summary([second], revision)).toMatchObject({ rejected: 0, pending: 1 });
    expect(summary([approved(second)], revision)).toMatchObject({
      rejected: 0,
      pending: 0,
      approved: 1,
      allApproved: true,
    });
  });

  it('lets only the latest file decide, whatever earlier files were decided', () => {
    const revision = requiring(['BILL_OF_LADING']);
    // Version 1 approved, version 2 rejected: the approval below it does not count.
    const document = rejected(replacedBy(approved(presented('BILL_OF_LADING'))));
    expect(summary([document], revision)).toMatchObject({ approved: 0, rejected: 1 });
  });

  it('ignores other contracts, other revisions and types the revision does not require', () => {
    const revision = requiring(['BILL_OF_LADING', 'CERTIFICATE_OF_ORIGIN']);
    const documents = [
      // Under another contract on the voyage.
      { ...approved(presented('BILL_OF_LADING')), contract: lacustraSellsToNordlys() },
      // Against another revision of these instructions.
      approved(presented('CERTIFICATE_OF_ORIGIN', 2)),
      // Not required by this revision.
      approved(presented('WEIGHT_CERTIFICATE')),
    ];

    expect(summary(documents, revision)).toEqual({
      required: 2,
      missing: 2,
      pending: 0,
      rejected: 0,
      approved: 0,
      allApproved: false,
    });
  });

  it('starts a new revision with a document set of its own', () => {
    const documents = [approved(presented('BILL_OF_LADING', 1))];
    expect(summary(documents, requiring(['BILL_OF_LADING'], 1))).toMatchObject({
      allApproved: true,
    });

    const revisionTwo = requiring(['BILL_OF_LADING', 'PHYTOSANITARY_CERTIFICATE'], 2);
    expect(summary(documents, revisionTwo)).toMatchObject({
      required: 2,
      missing: 2,
      approved: 0,
      allApproved: false,
    });
    expect(summary([...documents, presented('BILL_OF_LADING', 2)], revisionTwo)).toMatchObject({
      missing: 1,
      pending: 1,
      approved: 0,
    });
  });

  it('counts each required type once, however many originals and copies it asks for', () => {
    const revision = requiring(['BILL_OF_LADING'], 1, { originals: 3, copies: 10 });
    expect(summary([approved(presented('BILL_OF_LADING'))], revision)).toMatchObject({
      required: 1,
      approved: 1,
    });
    // A requirement listed twice (the contract forbids it) still counts once.
    const twice: DocumentaryInstructionRevision = {
      ...revision,
      requirements: [...revision.requirements, ...revision.requirements],
    };
    expect(summary([], twice)).toMatchObject({ required: 1, missing: 1 });
  });

  it('is never complete when nothing is required', () => {
    const none: DocumentaryInstructionRevision = { ...aRevision(), requirements: [] };
    expect(summary([], none)).toEqual({
      required: 0,
      missing: 0,
      pending: 0,
      rejected: 0,
      approved: 0,
      allApproved: false,
    });
  });
});
