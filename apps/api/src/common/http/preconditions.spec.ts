import { describe, expect, it } from 'vitest';
import {
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
