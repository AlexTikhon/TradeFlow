import { describe, expect, it } from 'vitest';
import {
  aNoticeAction,
  anInstructionsAction,
  aReviewAction,
} from '../../../test/fixtures/action-items';
import { parseRecordLink, recordLinkPath, type RecordTarget } from './record-link';

const notice = aNoticeAction().target;
const revision = anInstructionsAction().target;
const document = aReviewAction().target;
const voyageId = notice.voyageId;

/** The link's query, as the voyage page reads it. */
const searchOf = (path: string) => new URL(path, 'http://localhost').searchParams;
const parse = (search: string) => parseRecordLink(voyageId, new URLSearchParams(search));

describe('record links', () => {
  it.each<[string, RecordTarget]>([
    ['a notice', notice],
    ['an instruction revision', revision],
    ['a document version', document],
  ])('round-trips %s through the address', (_kind, target) => {
    const path = recordLinkPath(target);

    expect(new URL(path, 'http://localhost').pathname).toBe(`/voyages/${target.voyageId}`);
    expect(parseRecordLink(target.voyageId, searchOf(path))).toEqual({
      status: 'valid',
      target,
      key: path,
    });
  });

  it('names nothing when the address has none of its parameters', () => {
    expect(parse('')).toEqual({ status: 'none' });
    expect(parse('tab=documents')).toEqual({ status: 'none' });
  });

  it.each([
    ['an unknown kind', 'open=invoice&contract=x'],
    ['no kind', `contract=${notice.contractId}&notice=${notice.noticeId}`],
    ['an id that is not a UUID', `open=notice&contract=${notice.contractId}&notice=42`],
    ['a missing contract', `open=notice&notice=${notice.noticeId}`],
    [
      'a revision that is not a number',
      `open=instruction-revision&contract=${revision.contractId}&instruction=${revision.instructionId}&revision=two`,
    ],
    [
      'a revision with a leading zero',
      `open=instruction-revision&contract=${revision.contractId}&instruction=${revision.instructionId}&revision=02`,
    ],
    [
      'an unknown document type',
      `open=document-version&contract=${document.contractId}&revision=1&documentType=MANIFEST&document=${document.documentId}&version=2`,
    ],
    [
      'a version of 0',
      `open=document-version&contract=${document.contractId}&revision=1&documentType=BILL_OF_LADING&document=${document.documentId}&version=0`,
    ],
    [
      'a parameter given twice',
      `open=notice&contract=${notice.contractId}&notice=${notice.noticeId}&notice=${notice.noticeId}`,
    ],
  ])('treats a link with %s as malformed', (_case, search) => {
    expect(parse(search)).toEqual({ status: 'malformed' });
  });

  it('takes the voyage from the page, never from the query', () => {
    const otherVoyage = '01990000-0000-7000-8006-000000000002';
    const parsed = parseRecordLink(otherVoyage, searchOf(recordLinkPath(notice)));

    expect(parsed).toMatchObject({ status: 'valid', target: { ...notice, voyageId: otherVoyage } });
  });
});
