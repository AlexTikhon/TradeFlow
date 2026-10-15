import type { ArgumentMetadata, PipeTransform } from '@nestjs/common';
import type { z } from 'zod';
import { RequestValidationException } from './request-validation.exception.js';

/**
 * Validates and parses one request input (a param, the query object, or the body)
 * against a contract schema. Usage: `@Query(new ZodValidationPipe(Schema))`.
 */
export class ZodValidationPipe<TSchema extends z.ZodType> implements PipeTransform<
  unknown,
  z.output<TSchema>
> {
  constructor(private readonly schema: TSchema) {}

  transform(value: unknown, metadata: ArgumentMetadata): z.output<TSchema> {
    const result = this.schema.safeParse(value);
    if (result.success) {
      return result.data;
    }
    throw new RequestValidationException(
      result.error.issues.map((issue) => ({
        path: [metadata.type, metadata.data, ...issue.path].filter(Boolean).map(String).join('.'),
        message: issue.message,
      })),
    );
  }
}
