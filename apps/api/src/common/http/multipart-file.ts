import { PassThrough, type Readable } from 'node:stream';
import {
  BadRequestException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import busboy from 'busboy';
import type { Request } from 'express';
import { RequestValidationException } from './request-validation.exception.js';

/*
 * Receives a `multipart/form-data` request that carries exactly one file, streaming it to a
 * consumer instead of buffering it. Limits are enforced while the bytes arrive: the declared
 * length, the bytes actually received, the file's own size, and the parts allowed. Every way the
 * request can fail becomes one classified error, so the consumer only ever sees the reason it
 * should report, never a parser's internals:
 *
 * - the client went away before sending everything: `UploadAbortedError`;
 * - the file or the request is too large: 413;
 * - not multipart: 415; anything else in the form, no file, or a malformed body: 400.
 *
 * On failure the consumer's stream is destroyed with that error, so it can clean up what it
 * wrote; if the consumer had already finished, its result is handed to `discard`. The rest of
 * the body is left for the error response to read and discard first (`unread-body.ts`), so that
 * the answer reaches a client that is still sending.
 */

/** The file part, as the client sent it. Both names are the client's: never trust them. */
export interface FilePart {
  /** The part's bytes. Ends with the part; destroyed with the failure if the request fails. */
  stream: Readable;
  /** The part's `filename`, possibly empty. Display text at most. */
  fileName: string;
  /** The part's declared `Content-Type`. */
  mediaType: string;
}

export interface FileConsumer<T> {
  /**
   * Consumes the file part, for example into staging. It must read `stream` to its end or reject.
   * A rejection stops the request and is reported as the request's failure.
   */
  accept(part: FilePart): Promise<T>;
  /** Undoes what `accept` produced, when the request turns out to be invalid after it. */
  discard(result: T): Promise<void>;
}

export interface SingleFileLimits {
  /** The form field that carries the file. */
  field: string;
  /** Most bytes of the file itself. */
  maxFileBytes: number;
  /** Most bytes of the whole body (file plus multipart framing). */
  maxRequestBytes: number;
  /** The 413 message, e.g. "The file is larger than 10 MiB." */
  tooLarge: string;
}

/**
 * The client closed the connection before the request was complete. Nobody is left to read the
 * answer; it is a 400 so that it is not reported as a failure of the server.
 */
export class UploadAbortedError extends BadRequestException {
  constructor() {
    super('The upload was aborted before it was complete.');
  }
}

const invalid = (path: string, message: string) =>
  new RequestValidationException([{ path, message }]);

/**
 * What can be refused from the headers alone, before any of the body is read: a body that is not
 * multipart (415), or one that says it is too large (413). The connection is then closed rather
 * than read to its end just to refuse it.
 */
export function checkFileRequest(request: Request, limits: SingleFileLimits): void {
  if (!request.is('multipart/form-data')) {
    throw new UnsupportedMediaTypeException(
      `Send the file as multipart/form-data, in a field named "${limits.field}".`,
    );
  }
  const declared = Number(request.get('content-length'));
  if (Number.isFinite(declared) && declared > limits.maxRequestBytes) {
    request.res?.setHeader('Connection', 'close');
    throw new PayloadTooLargeException(limits.tooLarge);
  }
}

/**
 * Streams the one file of a `multipart/form-data` request to `consumer` (see above). Resolves
 * with what the consumer produced, once the whole body has been read and found valid.
 */
export async function receiveSingleFile<T>(
  request: Request,
  limits: SingleFileLimits,
  consumer: FileConsumer<T>,
): Promise<T> {
  checkFileRequest(request, limits);
  if (request.destroyed && !request.complete) {
    // Gone while earlier checks ran: no 'close' is coming any more to tell.
    throw new UploadAbortedError();
  }

  let parser: busboy.Busboy;
  try {
    parser = busboy({
      headers: request.headers,
      // File names arrive as UTF-8 from browsers; busboy's default would read them as Latin-1.
      defParamCharset: 'utf8',
      // busboy signals a limit when it is *reached*, and from then on silently skips. So each is
      // one more than allowed, and reaching it is the refusal: a file one byte over the maximum,
      // a second part, a second file. One field is let through only to be refused by its name.
      limits: {
        fileSize: limits.maxFileBytes + 1,
        parts: 2,
        files: 1,
        fields: 1,
        fieldSize: 1024,
        headerPairs: 16,
      },
    });
  } catch {
    throw invalid('header.content-type', 'The multipart boundary is missing or malformed.');
  }

  return new Promise<T>((resolve, reject) => {
    let failure: Error | undefined;
    let source: Readable | undefined;
    let part: PassThrough | undefined;
    let accepted: Promise<{ ok: true; value: T } | { ok: false; error: unknown }> | undefined;
    let parsed = false;
    let settled = false;
    let received = 0;

    /** Answers once the consumer is done with the part, whichever event got here first. */
    const settle = async () => {
      const outcome = await accepted;
      if (settled) return;
      settled = true;
      if (failure) {
        if (outcome?.ok) await consumer.discard(outcome.value).catch(() => undefined);
        reject(failure);
      } else if (outcome?.ok) {
        resolve(outcome.value);
      } else if (outcome) {
        reject(outcome.error instanceof Error ? outcome.error : new Error(String(outcome.error)));
      }
    };

    const fail = (error: unknown) => {
      if (failure) return;
      failure = error instanceof Error ? error : new Error(String(error));
      source?.unpipe();
      source?.resume();
      part?.destroy(failure);
      request.unpipe(parser);
      parser.removeAllListeners('file');
      void settle();
    };

    // Every failure is reported through `fail`; these keep late events from being unhandled.
    parser.on('error', () => {
      fail(invalid('body', 'The multipart body is malformed or incomplete.'));
    });

    request.on('data', (chunk: Buffer) => {
      received += chunk.length;
      if (received > limits.maxRequestBytes) {
        fail(new PayloadTooLargeException(limits.tooLarge));
      }
    });
    request.on('close', () => {
      if (!request.complete) fail(new UploadAbortedError());
    });

    parser.on('file', (name, stream, info) => {
      if (name !== limits.field) {
        stream.resume();
        fail(invalid(`body.${name}`, `Unexpected file field: send the file as "${limits.field}".`));
        return;
      }
      // The consumer reads this copy, so it only ever sees the errors classified here.
      source = stream;
      part = new PassThrough();
      // The failure is reported through the promise. The consumer may have stopped listening
      // (finished, or refused the part before reading it) by the time `fail` destroys this.
      part.on('error', () => undefined);
      stream.on('error', () => {
        fail(invalid('body', 'The multipart body is malformed or incomplete.'));
      });
      stream.on('limit', () => {
        fail(new PayloadTooLargeException(limits.tooLarge));
      });
      stream.pipe(part);
      accepted = consumer
        .accept({ stream: part, fileName: info.filename, mediaType: info.mimeType })
        .then(
          (value) => ({ ok: true as const, value }),
          (error: unknown) => {
            // The consumer refused the file (or could not store it): stop reading the request.
            fail(error);
            return { ok: false as const, error };
          },
        );
      if (parsed) void settle();
    });
    parser.on('field', (name) => {
      fail(invalid(`body.${name}`, `Unexpected field: send only the file, as "${limits.field}".`));
    });
    for (const limit of ['partsLimit', 'filesLimit', 'fieldsLimit'] as const) {
      parser.on(limit, () => {
        fail(invalid('body', `Send exactly one part: the file, as "${limits.field}".`));
      });
    }
    parser.on('close', () => {
      parsed = true;
      if (failure) return;
      if (!accepted) {
        fail(invalid(`body.${limits.field}`, `Attach the file as "${limits.field}".`));
        return;
      }
      void settle();
    });

    request.pipe(parser);
  });
}
