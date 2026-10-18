import { describe, expect, it } from 'vitest';
import {
  entityTagCondition,
  isIfNoneMatchAny,
  PreconditionRequiredException,
  versionsFromIfMatch,
  writePrecondition,
} from './preconditions.js';
import { RequestValidationException } from './request-validation.exception.js';

describe('versionsFromIfMatch', () => {
  it('is undefined without the header', () => {
    expect(versionsFromIfMatch(undefined)).toBeUndefined();
  });

  it('reads one or several strong entity tags', () => {
    expect(versionsFromIfMatch('"3"')).toEqual([3]);
    expect(versionsFromIfMatch(' "3" , "12"')).toEqual([3, 12]);
  });

  it('leaves out tags that can never match: weak ones and those that are not versions', () => {
    expect(versionsFromIfMatch('W/"3"')).toEqual([]);
    expect(versionsFromIfMatch('"abc", "0", "03", "-1", "1.5", ""')).toEqual([]);
    expect(versionsFromIfMatch('W/"3", "4"')).toEqual([4]);
  });

  it('refuses "*", which would make the change unconditional', () => {
    expect(() => versionsFromIfMatch('*')).toThrow(PreconditionRequiredException);
    expect(() => versionsFromIfMatch(' * ')).toThrow(PreconditionRequiredException);
  });

  it.each(['3', '"3', 'W/3', '"3" "4"', '', ',', '"3",'])(
    'refuses a malformed header: %j',
    (header) => {
      expect(() => versionsFromIfMatch(header)).toThrow(RequestValidationException);
    },
  );
});

describe('isIfNoneMatchAny', () => {
  it('is true only for "*"', () => {
    expect(isIfNoneMatchAny('*')).toBe(true);
    expect(isIfNoneMatchAny(' * ')).toBe(true);
    expect(isIfNoneMatchAny(undefined)).toBe(false);
    expect(isIfNoneMatchAny('"1"')).toBe(false);
  });
});

describe('writePrecondition', () => {
  const missing = 'Name the version.';

  it('reads a creation or a replacement', () => {
    expect(writePrecondition(undefined, '*', missing)).toEqual({ kind: 'absent' });
    expect(writePrecondition('"2", "3"', undefined, missing)).toEqual({
      kind: 'version',
      versions: [2, 3],
    });
  });

  it('is 428 with the given message when the write names nothing', () => {
    expect(() => writePrecondition(undefined, undefined, missing)).toThrow(
      new PreconditionRequiredException(missing),
    );
  });

  it.each<[string | undefined, string | undefined]>([
    ['"1"', '*'],
    [undefined, '"1"'],
    ['3', undefined],
  ])('refuses If-Match %j with If-None-Match %j as malformed', (ifMatch, ifNoneMatch) => {
    expect(() => writePrecondition(ifMatch, ifNoneMatch, missing)).toThrow(
      RequestValidationException,
    );
  });
});

describe('entityTagCondition', () => {
  it('is undefined without the header', () => {
    expect(entityTagCondition(undefined, 'if-match')).toBeUndefined();
  });

  const tags = (header: string) => entityTagCondition(header, 'if-match');

  it('reads a standalone "*", with optional whitespace around it', () => {
    expect(entityTagCondition(' * ', 'if-none-match')).toEqual({ kind: 'any' });
    expect(entityTagCondition('\t*', 'if-none-match')).toEqual({ kind: 'any' });
  });

  it('reads a quoted "*" as an ordinary entity tag', () => {
    expect(tags('"*"')).toEqual({ kind: 'tags', tags: ['"*"'] });
    expect(tags('"*", W/"*"')).toEqual({ kind: 'tags', tags: ['"*"', 'W/"*"'] });
  });

  it('keeps every entity tag as sent, weak ones and foreign ones included', () => {
    expect(tags('"3", W/"4" ,"abc"')).toEqual({ kind: 'tags', tags: ['"3"', 'W/"4"', '"abc"'] });
  });

  it('reads a comma inside an opaque tag as content, not as a separator', () => {
    expect(tags('"a,b"')).toEqual({ kind: 'tags', tags: ['"a,b"'] });
    expect(tags('W/",", "x,y,z" ,"3"')).toEqual({
      kind: 'tags',
      tags: ['W/","', '"x,y,z"', '"3"'],
    });
  });

  it('keeps empty opaque tags, weak or not', () => {
    expect(tags('""')).toEqual({ kind: 'tags', tags: ['""'] });
    expect(tags('W/"", ""')).toEqual({ kind: 'tags', tags: ['W/""', '""'] });
  });

  it('accepts every allowed opaque character: visible ASCII but DQUOTE, and obs-text', () => {
    const visible = Array.from({ length: 0x7e - 0x21 + 1 }, (_, index) =>
      String.fromCharCode(0x21 + index),
    )
      .filter((character) => character !== '"')
      .join('');
    expect(tags(`"${visible}"`)).toEqual({ kind: 'tags', tags: [`"${visible}"`] });
    expect(tags('"café\u0080ÿ"')).toEqual({
      kind: 'tags',
      tags: ['"café\u0080ÿ"'],
    });
  });

  it('ignores empty list elements, as HTTP list syntax requires', () => {
    expect(tags('"a", , "b"')).toEqual({ kind: 'tags', tags: ['"a"', '"b"'] });
    expect(tags(',"a",')).toEqual({ kind: 'tags', tags: ['"a"'] });
    expect(tags('"a" ,\t, "b"')).toEqual({ kind: 'tags', tags: ['"a"', '"b"'] });
  });

  it('reads a header with no element at all as an empty list', () => {
    for (const header of ['', ' ', ',', ' , ,\t']) {
      expect(tags(header)).toEqual({ kind: 'tags', tags: [] });
    }
  });

  it.each([
    ['an unquoted tag', '3'],
    ['an unterminated tag', '"3'],
    ['an unterminated tag after a comma', '"a,b'],
    ['a space inside a tag', '"a b"'],
    ['a tab inside a tag', '"a\tb"'],
    ['a quote inside a tag', '"a"b"'],
    ['a control character inside a tag', '"a\u0001b"'],
    ['a character beyond obs-text', '"aĀ"'],
    ['a lowercase weak prefix', 'w/"3"'],
    ['a space inside the weak prefix', 'W/ "3"'],
    ['two tags without a comma', '"a" "b"'],
    ['text after a tag', '"a"b'],
    ['"*" combined with tags', '*, "3"'],
    ['"*" after tags', '"3", *'],
    ['"*" twice', '*, *'],
  ])('refuses %s (%j)', (_case, header) => {
    expect(() => entityTagCondition(header, 'if-none-match')).toThrow(RequestValidationException);
  });

  it('names the header in the field error', () => {
    try {
      entityTagCondition('"a b"', 'if-none-match');
      expect.unreachable();
    } catch (error) {
      expect((error as RequestValidationException).fieldErrors).toEqual([
        { path: 'header.if-none-match', message: 'Expected * or a list of entity tags, e.g. "3"' },
      ]);
    }
  });
});
