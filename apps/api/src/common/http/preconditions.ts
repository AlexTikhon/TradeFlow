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
