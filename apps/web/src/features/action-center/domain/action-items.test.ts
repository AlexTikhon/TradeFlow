import { describe, expect, it } from 'vitest';
import { parseQueueFilters, queueSearch } from './action-items';

const parse = (search: string) => parseQueueFilters(new URLSearchParams(search));

describe('queue filters in the address', () => {
  it('reads valid filters', () => {
    expect(parse('')).toEqual({ filters: {}, ignored: [] });
    expect(parse('type=REPLACE_REJECTED_DOCUMENT')).toEqual({
      filters: { type: 'REPLACE_REJECTED_DOCUMENT' },
      ignored: [],
    });
    expect(parse('overdue=true&type=ACKNOWLEDGE_NOTICE')).toEqual({
      filters: { type: 'ACKNOWLEDGE_NOTICE', overdue: true },
      ignored: [],
    });
  });

  it.each([
    ['an unknown type', 'type=ESCALATE', ['type']],
    ['a type in another case', 'type=review_document', ['type']],
    ['an empty type', 'type=', ['type']],
    ['overdue other than true', 'overdue=1', ['overdue']],
    ['overdue=false', 'overdue=false', ['overdue']],
    ['a filter given twice', 'overdue=true&overdue=true', ['overdue']],
    ['both unknown', 'type=X&overdue=yes', ['type', 'overdue']],
  ])('ignores %s, and says so', (_case, search, ignored) => {
    expect(parse(search)).toEqual({ filters: {}, ignored });
  });

  it('keeps a valid filter beside an ignored one', () => {
    expect(parse('type=REVIEW_DOCUMENT&overdue=soon')).toEqual({
      filters: { type: 'REVIEW_DOCUMENT' },
      ignored: ['overdue'],
    });
  });

  it('writes only the filters it knows', () => {
    expect(queueSearch({}).toString()).toBe('');
    expect(queueSearch({ type: 'REVIEW_DOCUMENT', overdue: true }).toString()).toBe(
      'type=REVIEW_DOCUMENT&overdue=true',
    );
  });
});
