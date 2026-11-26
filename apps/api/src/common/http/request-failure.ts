import type { RequestFailure } from './request-context.js';

/** Class names as code declares them. */
const CLASS_NAME = /^[A-Za-z_$][\w$]{0,63}$/;
/** Library codes: `ECONNREFUSED`, `UNABLE_TO_GET_ISSUER_CERT_LOCALLY`, `P2002`, `23505`. */
const ERROR_CODE = /^[A-Za-z0-9_]{1,64}$/;
/**
 * One V8 stack frame naming a code location: an optional function name, then a module path or
 * URL with line and column. Anything else (a frame-shaped line inside a message included, see
 * `stackFrames`) is dropped.
 */
const STACK_FRAME =
  /^ {4}at (?:(?:async |new )?[\w$.<>[\]]{1,120} )?\(?(?:node:|file:\/\/\/(?:[A-Za-z]:)?|\/|[A-Za-z]:\\)[\w/\\.@+-]{1,240}:\d{1,7}:\d{1,7}\)?$/;
const MAX_FRAMES = 5;

/**
 * The bounded, allowlisted description of `error` that diagnostics may record: its class name,
 * a library code and the first validated stack frames. Its message, properties and cause are
 * never read: they can carry SQL parameters, request content, file names or provider payloads.
 */
export function describeFailure(source: RequestFailure['source'], error: unknown): RequestFailure {
  const failure: RequestFailure = { source, name: className(error) };
  const code = errorCode(error);
  if (code !== undefined) failure.code = code;
  const frames = stackFrames(error);
  if (frames.length) failure.frames = frames;
  return failure;
}

/** Reads what could be a getter or a proxy trap without letting it fail the caller. */
function attempt<T>(read: () => T): T | undefined {
  try {
    return read();
  } catch {
    return undefined;
  }
}

function className(error: unknown): string {
  if (typeof error !== 'object' || error === null) return 'NonError';
  // The constructor's name is the code's; `error.name` can be assigned anything.
  const name = attempt(() => (Object.getPrototypeOf(error) as object | null)?.constructor.name);
  return typeof name === 'string' && CLASS_NAME.test(name) ? name : 'Error';
}

function errorCode(error: unknown): string | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const code = attempt(() => (error as { code?: unknown }).code);
  return typeof code === 'string' && ERROR_CODE.test(code) ? code : undefined;
}

/**
 * The first frames of `error`'s stack. V8 starts a stack with `String(error)`, the name and the
 * message, which can span lines that look like frames; frames are read only after that header,
 * and only when the header is exactly where it is expected (no frames otherwise).
 */
function stackFrames(error: unknown): string[] {
  // `instanceof` itself can throw (a proxy's getPrototypeOf trap).
  if (!attempt(() => error instanceof Error)) return [];
  const stack = attempt(() => (error as Error).stack);
  const header = attempt(() => String(error));
  if (typeof stack !== 'string' || header === undefined || !stack.startsWith(`${header}\n`)) {
    return [];
  }
  return stack
    .slice(header.length + 1)
    .split('\n')
    .filter((line) => STACK_FRAME.test(line))
    .slice(0, MAX_FRAMES)
    .map((line) => line.trim());
}
