import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { RequestValidationException } from './request-validation.exception.js';
import { ZodValidationPipe } from './zod-validation.pipe.js';

function fieldErrors(run: () => unknown) {
  try {
    run();
  } catch (error) {
    if (error instanceof RequestValidationException) return error.fieldErrors;
    throw error;
  }
  throw new Error('Expected a validation failure');
}

describe('ZodValidationPipe', () => {
  it('names each failing field by its full path, array index 0 included', () => {
    const pipe = new ZodValidationPipe(z.object({ items: z.array(z.object({ count: z.int() })) }));

    expect(
      fieldErrors(() =>
        pipe.transform({ items: [{ count: 'x' }, { count: 1.5 }] }, { type: 'body' }),
      ).map(({ path }) => path),
    ).toEqual(['body.items.0.count', 'body.items.1.count']);
  });

  it('prefixes a named parameter, and passes valid input through parsed', () => {
    const pipe = new ZodValidationPipe(z.uuid());

    expect(fieldErrors(() => pipe.transform('nope', { type: 'param', data: 'voyageId' }))).toEqual([
      { path: 'param.voyageId', message: expect.any(String) as string },
    ]);
    const id = '01990000-0000-7000-8006-000000000001';
    expect(pipe.transform(id, { type: 'param', data: 'voyageId' })).toBe(id);
  });
});
