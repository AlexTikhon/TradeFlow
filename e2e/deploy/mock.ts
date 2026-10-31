import { createInterface } from 'node:readline';
import { startMock } from './mock-run.js';

const controller = new AbortController();
let requestStop: () => void = () => undefined;
const stopped = new Promise<void>((resolve) => {
  requestStop = resolve;
});
const shutdown = () => {
  controller.abort();
  requestStop();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
const run = await startMock((message) => {
  console.log(`[mock] ${message}`);
}, controller.signal);
console.log(
  `Local AWS mock: ${run.baseURL}\nProject: ${run.project}\nRecovery environment: ${run.recoveryFile}\nFictional accounts: docs/demo.md, password tradeflow-demo.\nCertificate: ${run.root}/root.crt (mock CA only).\nPress Ctrl+C or q + Enter to remove this run's containers, volumes and temporary files.`,
);
const input = createInterface({ input: process.stdin });
input.on('line', (line) => {
  if (line.trim().toLowerCase() === 'q') requestStop();
});
await stopped;
input.close();
await run.stop();
console.log('[mock] Stopped and cleaned');
