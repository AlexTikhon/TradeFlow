import { STATUS_CODES } from 'node:http';
import {
  type ArgumentsHost,
  Catch,
  type ExceptionFilter,
  HttpException,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { PROBLEM_CONTENT_TYPE, type ProblemDetails, ProblemTypes } from '@tradeflow/contracts';
import type { Request, Response } from 'express';
import { RequestValidationException } from './request-validation.exception.js';

/**
 * Renders every error as RFC 9457 Problem Details so clients handle one error shape.
 * Unexpected errors are logged in full but never leak internals to the client.
 */
@Catch()
export class ProblemDetailsFilter implements ExceptionFilter {
  private readonly logger = new Logger(ProblemDetailsFilter.name);

  catch(exception: unknown, host: ArgumentsHost): void {
    const http = host.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();

    const problem = toProblemDetails(exception, request.originalUrl);
    if (problem.status >= 500) {
      this.logger.error(
        `${request.method} ${request.originalUrl} failed`,
        exception instanceof Error ? exception.stack : String(exception),
      );
    }

    response.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
  }
}

export function toProblemDetails(exception: unknown, instance: string): ProblemDetails {
  if (exception instanceof RequestValidationException) {
    return {
      type: ProblemTypes.ValidationFailed,
      title: 'Request validation failed',
      status: HttpStatus.BAD_REQUEST,
      detail: exception.message,
      instance,
      errors: exception.fieldErrors,
    };
  }

  if (exception instanceof HttpException && exception.getStatus() < 500) {
    const status = exception.getStatus();
    return {
      type: ProblemTypes.Generic,
      title: STATUS_CODES[status] ?? 'Error',
      status,
      detail: exception.message,
      instance,
    };
  }

  const status =
    exception instanceof HttpException ? exception.getStatus() : HttpStatus.INTERNAL_SERVER_ERROR;
  return {
    type: ProblemTypes.Generic,
    title: STATUS_CODES[status] ?? 'Internal Server Error',
    status,
    detail: 'An unexpected error occurred.',
    instance,
  };
}
