import { createHash, X509Certificate } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { connect } from 'node:tls';
import { startMock } from './mock-run.js';

export default async function setup() {
  const run = await startMock((message) => {
    console.log(`[deploy] ${message}`);
  });
  try {
    const certificate = await new Promise<Buffer>((resolve, reject) => {
      const socket = connect(
        {
          host: '127.0.0.1',
          port: Number(new URL(run.baseURL).port),
          servername: 'localhost',
          ca: run.ca,
        },
        () => {
          const certificate = socket.getPeerCertificate().raw;
          socket.end();
          resolve(certificate);
        },
      );
      socket.once('error', reject);
    });
    const publicKey = new X509Certificate(certificate).publicKey.export({
      type: 'spki',
      format: 'der',
    });
    const spki = createHash('sha256').update(publicKey).digest('base64');
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
      await run.stop();
      console.log("[deploy] Removed this run's containers, volumes and temporary files");
    };
  } catch (error) {
    await run.stop();
    throw error;
  }
}
