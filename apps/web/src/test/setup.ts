import '@testing-library/jest-dom/vitest';
import { cleanup, configure } from '@testing-library/react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { server } from './msw-server';

// The first render of a page in each file loads the route tree and MUI; on a loaded machine that
// alone can outlast the default 1 s of `findBy*` and `waitFor`. Failing on timing, not behaviour,
// helps nobody; vite.config.ts raises the per-test timeout for the same reason.
configure({ asyncUtilTimeout: 5_000 });

// jsdom brings its own Blob, File and FormData, which Node's fetch (the one MSW intercepts)
// cannot send: an upload would fail in the test environment, never in a browser, where there is
// one implementation of each. Files, and forms built to be sent, use Node's classes instead.
// They are not globals here: Blob and File come from node:buffer (imported untyped, since this
// code is compiled without Node's types), and FormData is the class of a form Node's own Response
// parses. A FormData read from a <form> element stays jsdom's: only jsdom can read its fields.
const nodeBufferModule: string = 'node:buffer';
const nodeBuffer = (await import(nodeBufferModule)) as {
  Blob: typeof Blob;
  File: typeof File;
};
const NodeFormData = (
  await new Response('', {
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  }).formData()
).constructor as typeof FormData;
const JsdomFormData = globalThis.FormData;
const TestFormData = new Proxy(NodeFormData, {
  construct: (target, args: ConstructorParameters<typeof FormData>) =>
    args[0] === undefined ? new target() : new JsdomFormData(...args),
});
Object.assign(globalThis, {
  Blob: nodeBuffer.Blob,
  File: nodeBuffer.File,
  FormData: TestFormData,
});

// Any request without a handler is a test bug, not something to silently tolerate.
beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});
afterEach(() => {
  cleanup();
  server.resetHandlers();
});
afterAll(() => {
  server.close();
});
