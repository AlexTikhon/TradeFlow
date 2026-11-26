import { describe, expect, it } from 'vitest';
import { describeFailure } from './request-failure.js';

const CANARY = 'canary-7f3e1a';

class StorageUnavailableError extends Error {}

describe('describeFailure', () => {
  it('keeps the class name, a library code and code locations, and nothing of the data', () => {
    const error = Object.assign(
      new StorageUnavailableError(`cannot read ${CANARY}.pdf for password=${CANARY}`, {
        cause: new Error(CANARY),
      }),
      {
        code: 'EACCES',
        query: `SELECT * FROM users WHERE token = '${CANARY}'`,
        meta: { connectionString: `postgresql://u:${CANARY}@db/t` },
      },
    );
    const failure = describeFailure('exception', error);
    expect(failure).toMatchObject({ source: 'exception', name: 'StorageUnavailableError' });
    expect(failure.code).toBe('EACCES');
    expect(failure.frames?.length).toBeGreaterThan(0);
    expect(failure.frames?.length).toBeLessThanOrEqual(5);
    for (const frame of failure.frames ?? []) expect(frame).toMatch(/^at .+:\d+:\d+\)?$/);
    expect(JSON.stringify(failure)).not.toContain(CANARY);
  });

  it('names the class from code, never from the assignable `name`', () => {
    const error = new Error('x');
    error.name = `Forged ${CANARY}`;
    expect(describeFailure('exception', error).name).toBe('Error');
    expect(JSON.stringify(describeFailure('exception', error))).not.toContain(CANARY);
  });

  it('keeps only code-shaped codes', () => {
    const codeOf = (code: unknown) =>
      describeFailure('exception', Object.assign(new Error('x'), { code })).code;
    expect(codeOf('UNABLE_TO_GET_ISSUER_CERT_LOCALLY')).toBe('UNABLE_TO_GET_ISSUER_CERT_LOCALLY');
    expect(codeOf('P2002')).toBe('P2002');
    expect(codeOf('23505')).toBe('23505');
    for (const code of [`bad ${CANARY}`, 'a\nb', 'x'.repeat(65), 42, { CANARY }, '']) {
      expect(codeOf(code)).toBeUndefined();
    }
  });

  it('never reads frame-shaped lines of a message as frames', () => {
    const forged = `failed\n    at ${CANARY} (/srv/${CANARY}.js:1:1)`;
    const error = new Error(forged);
    expect(JSON.stringify(describeFailure('exception', error))).not.toContain(CANARY);
    // V8 formats the stack when it is first read, so a message changed before then is still
    // its header, and skipped.
    const late = new Error('original');
    late.message = forged;
    expect(JSON.stringify(describeFailure('exception', late))).not.toContain(CANARY);
    // Changed after the stack was formatted: the header no longer matches, so no frames at all.
    const changed = new Error('original');
    expect(changed.stack).toContain('original');
    changed.message = forged;
    expect(describeFailure('exception', changed).frames).toBeUndefined();
  });

  it('describes thrown non-errors and hostile objects without failing', () => {
    expect(describeFailure('exception', `thrown ${CANARY}`)).toEqual({
      source: 'exception',
      name: 'NonError',
    });
    expect(describeFailure('exception', null).name).toBe('NonError');
    const hostile = new Proxy(
      {},
      {
        get() {
          throw new Error(CANARY);
        },
        getPrototypeOf() {
          throw new Error(CANARY);
        },
      },
    );
    expect(describeFailure('event_stream', hostile)).toEqual({
      source: 'event_stream',
      name: 'Error',
    });
  });
});
