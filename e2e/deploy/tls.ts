import { createHash, X509Certificate } from 'node:crypto';
import { connect } from 'node:tls';

/**
 * The SHA-256 of the mock edge's leaf public key, read only after Node verified the leaf against
 * this run's CA and the `localhost` hostname. Chromium is then told to accept exactly that key
 * (`--ignore-certificate-errors-spki-list`) for its own isolated instance; nothing else is trusted
 * and no system trust store changes. Local mock only: hosted targets use public trust.
 */
export function verifiedLeafSpki(baseURL: string, ca: Buffer | string): Promise<string> {
  return new Promise<Buffer>((resolve, reject) => {
    const socket = connect(
      { host: '127.0.0.1', port: Number(new URL(baseURL).port), servername: 'localhost', ca },
      () => {
        const certificate = socket.getPeerCertificate().raw;
        socket.end();
        resolve(certificate);
      },
    );
    socket.once('error', reject);
  }).then((certificate) => {
    const publicKey = new X509Certificate(certificate).publicKey.export({
      type: 'spki',
      format: 'der',
    });
    return createHash('sha256').update(publicKey).digest('base64');
  });
}
