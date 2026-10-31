/* global console */
import { readFileSync } from 'node:fs';

// Legacy deploy localizes workspace links. Refuse any registry package/version that was not
// already in the reviewed workspace lockfile, even if a future pnpm deploy re-resolves peers.
function packages(path) {
  const text = readFileSync(path, 'utf8').replaceAll('\r\n', '\n');
  const section = text.split('\npackages:\n')[1]?.split('\nsnapshots:\n')[0];
  if (!section) throw new Error(`Missing packages section: ${path}`);
  return [...section.matchAll(/^ {2}(.+):$/gm)].map((match) =>
    match[1].replace(/^['"]|['"]$/g, ''),
  );
}
const locked = new Set(packages('/workspace/pnpm-lock.yaml'));
const deployed = packages('/runtime/api/node_modules/.pnpm/lock.yaml');
for (const name of deployed) {
  if (!locked.has(name) && name !== '@tradeflow/contracts@file:packages/contracts') {
    throw new Error(`Unreviewed runtime dependency: ${name}`);
  }
}
console.log(`Runtime lock verified: ${deployed.length} package entries`);
