import type { IncomingMessage, ServerResponse } from 'node:http';

/*
 * An error can be answered before the request's body has been read: a guard refuses an upload
 * (401, 403), or a service does before receiving the file (404, 409, 412), or the upload fails
 * part-way. Node then resets the connection under a client that is still sending, and the client
 * sees a network error instead of the answer. So the rest of the body is read and thrown away
 * first, up to a bound; beyond it, the connection is closed after the answer instead.
 */

/** More than any body the API accepts (an upload is 10 MiB plus multipart framing). */
export const UNREAD_BODY_LIMIT_BYTES = 16 * 1024 * 1024;

/**
 * Resolves once what is left of `request`'s body has been read and discarded, the client has gone,
 * or `limitBytes` have been read (then the connection is marked to close after the answer). A body
 * already read, or one declared over the limit, is left alone.
 */
export function discardUnreadBody(
  request: IncomingMessage,
  response: ServerResponse,
  limitBytes = UNREAD_BODY_LIMIT_BYTES,
): Promise<void> {
  if (request.complete || request.destroyed || response.getHeader('connection') === 'close') {
    return Promise.resolve();
  }
  const declared = Number(request.headers['content-length']);
  if (Number.isFinite(declared) && declared > limitBytes) {
    response.setHeader('Connection', 'close');
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    let read = 0;
    const finish = () => {
      request.off('data', onData);
      request.off('end', finish);
      request.off('close', finish);
      resolve();
    };
    const onData = (chunk: Buffer) => {
      read += chunk.length;
      if (read > limitBytes) {
        response.setHeader('Connection', 'close');
        finish();
      }
    };
    request.on('data', onData);
    request.on('end', finish);
    request.on('close', finish);
    request.resume();
  });
}
