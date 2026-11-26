import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PASSED_MARKER } from './diagnostics.js';
import { startMock } from './mock-run.js';
import { verifiedLeafSpki } from './tls.js';

export default async function setup() {
  const run = await startMock((message) => {
    console.log(`[deploy] ${message}`);
  });
  try {
    const spki = await verifiedLeafSpki(run.baseURL, run.ca);
    // Only non-secret run coordinates and its ephemeral CA. Never serialize browser auth state.
    const metadata = join(run.root, 'run.json');
    await writeFile(
      metadata,
      JSON.stringify({
        baseURL: run.baseURL,
        httpURL: run.httpURL,
        project: run.project,
        ca: run.ca.toString(),
        spki,
      }),
      { mode: 0o600 },
    );
    process.env.DEPLOY_MOCK_METADATA = metadata;
    return async () => {
      // The scenario writes this marker only after its last step. A failure, timeout or crashed
      // worker leaves it absent, so log tails are kept before the containers are removed.
      if (!existsSync(join(run.root, PASSED_MARKER)))
        await run.collectDiagnostics('The deployment scenario did not pass');
      await run.stop();
      console.log("[deploy] Removed this run's containers, volumes and temporary files");
    };
  } catch (error) {
    await run.collectDiagnostics(
      `Setup failed after startup: ${error instanceof Error ? error.message.slice(0, 2_000) : 'unknown error'}`,
    );
    await run.stop();
    throw error;
  }
}
