import { HttpException, HttpStatus } from '@nestjs/common';
import { RequestValidationException } from './request-validation.exception.js';

/*
 * Conditional requests (RFC 9110, section 13) for aggregates guarded by an integer version. The
 * entity tag of version `n` is the strong tag `"n"` (`instructionEntityTag` in the contracts
 * package). These helpers only read the headers; the comparison itself happens in the database
 * write that the precondition guards, never in application code that reads first.
 */

/** 428: the change must name the version it was based on. */
export class PreconditionRequiredException extends HttpException {
  constructor(message: string) {
    super(message, HttpStatus.PRECONDITION_REQUIRED);
  }
}

const ENTITY_TAG = /^\s*(W\/)?"([^"]*)"\s*$/;
const VERSION = /^[1-9]\d{0,8}$/;

/**
 * The versions an `If-Match` header accepts, or undefined when the header is absent. Weak tags
 * never match (If-Match uses the strong comparison) and tags that are not versions of ours cannot
 * match either, so both are left out: a header that names none of our versions fails like a stale
 * one. `*` is refused: it would turn the change unconditional. A header that is not a list of
 * entity tags is a malformed request.
 */
export function versionsFromIfMatch(header: string | undefined): number[] | undefined {
  if (header === undefined) {
    return undefined;
  }
  if (header.trim() === '*') {
    throw new PreconditionRequiredException(
      'If-Match must name the version your change is based on; "*" is not accepted.',
    );
  }
  const versions: number[] = [];
  for (const part of header.split(',')) {
    const match = ENTITY_TAG.exec(part);
    if (!match) {
      throw new RequestValidationException([
        { path: 'header.if-match', message: 'Expected a list of entity tags, e.g. "3"' },
      ]);
    }
    const [, weak, opaque = ''] = match;
    if (!weak && VERSION.test(opaque)) {
      versions.push(Number(opaque));
    }
  }
  return versions;
}

/** Whether an `If-None-Match` header is exactly `*`: create only if nothing exists yet. */
export function isIfNoneMatchAny(header: string | undefined): boolean {
  return header?.trim() === '*';
}

/** What a create-or-replace write is conditional on, from its precondition headers. */
export type WritePrecondition =
  /** `If-None-Match: *`: only if nothing exists yet. */
  | { kind: 'absent' }
  /** `If-Match`: only if the aggregate is at one of these versions. */
  | { kind: 'version'; versions: number[] };

/**
 * The precondition of a write that either creates the first version (`If-None-Match: *`) or
 * replaces a named one (`If-Match`). Neither is 428 with `missing` as its message; both at
 * once, or an `If-None-Match` other than `*`, is a malformed request.
 */
export function writePrecondition(
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
  missing: string,
): WritePrecondition {
  const versions = versionsFromIfMatch(ifMatch);
  if (versions && ifNoneMatch !== undefined) {
    throw new RequestValidationException([
      { path: 'header', message: 'Send either If-Match or If-None-Match: *, not both' },
    ]);
  }
  if (versions) {
    return { kind: 'version', versions };
  }
  if (isIfNoneMatchAny(ifNoneMatch)) {
    return { kind: 'absent' };
  }
  if (ifNoneMatch !== undefined) {
    throw new RequestValidationException([
      { path: 'header.if-none-match', message: 'Only If-None-Match: * is accepted' },
    ]);
  }
  throw new PreconditionRequiredException(missing);
}

/** An `If-Match` or `If-None-Match` header as sent: `*`, or a list of entity tags. */
export type EntityTagCondition = { kind: 'any' } | { kind: 'tags'; tags: string[] };

/**
 * Parses an `If-Match` or `If-None-Match` header without interpreting it, or undefined when the
 * header is absent. Tags are kept as sent (`"a,b"`, `W/"x"`, `""`). A header that is neither `*`
 * nor a list of entity tags is a malformed request (400).
 */
export function entityTagCondition(
  header: string | undefined,
  name: 'if-match' | 'if-none-match',
): EntityTagCondition | undefined {
  if (header === undefined) {
    return undefined;
  }
  // `*` stands alone: `If-Match = "*" / #entity-tag`. A quoted `"*"` is an ordinary tag.
  if (trimOws(header) === '*') {
    return { kind: 'any' };
  }
  const tags = entityTagList(header);
  if (!tags) {
    throw new RequestValidationException([
      { path: `header.${name}`, message: 'Expected * or a list of entity tags, e.g. "3"' },
    ]);
  }
  return { kind: 'tags', tags };
}

const isOws = (character: string) => character === ' ' || character === '\t';

const trimOws = (value: string) => value.replace(/^[ \t]+|[ \t]+$/g, '');

/**
 * `etagc = %x21 / %x23-7E / obs-text`: any visible character but `"`, and `obs-text` (%x80-FF,
 * which Node hands over as latin1). Commas are content; spaces and tabs are not allowed.
 */
const isEtagc = (character: string) => {
  const code = character.charCodeAt(0);
  return code === 0x21 || (code >= 0x23 && code <= 0x7e) || (code >= 0x80 && code <= 0xff);
};

/**
 * Reads `#entity-tag` (RFC 9110, sections 5.6.1 and 8.8.3) left to right, so a comma inside an
 * opaque tag is part of it rather than a separator. Each tag is returned as sent, `W/` included;
 * an empty opaque tag (`""`) is a tag like any other. Empty list elements (`"a", , "b"`, or a
 * leading or trailing comma) are ignored, as the list syntax requires, so a header holding no
 * element is an empty list. Returns null for anything else.
 */
function entityTagList(value: string): string[] | null {
  const tags: string[] = [];
  let at = 0;
  const skipOws = () => {
    while (at < value.length && isOws(value.charAt(at))) at++;
  };
  for (;;) {
    skipOws();
    if (at >= value.length) return tags;
    if (value.charAt(at) === ',') {
      at++;
      continue;
    }
    // weak = %s"W/" (case-sensitive), then opaque-tag = DQUOTE *etagc DQUOTE.
    const start = at;
    if (value.startsWith('W/', at)) at += 2;
    if (value.charAt(at) !== '"') return null;
    at++;
    while (at < value.length && isEtagc(value.charAt(at))) at++;
    if (value.charAt(at) !== '"') return null;
    at++;
    tags.push(value.slice(start, at));
    // After a tag: optional whitespace, then the end or the next comma.
    skipOws();
    if (at < value.length && value.charAt(at) !== ',') return null;
  }
}
