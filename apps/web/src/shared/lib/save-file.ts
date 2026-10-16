/** How long a download's object URL stays valid: long enough for any browser to start saving. */
const OBJECT_URL_LIFETIME_MS = 30_000;

/**
 * Hands `blob` to the browser as a download named `fileName`, the way a link with `download`
 * would. The bytes were fetched with the session already, so the browser need not ask the server
 * again, and a 401 was handled before this point.
 */
export function saveFile(blob: Blob, fileName: string): void {
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName;
  link.rel = 'noopener';
  link.hidden = true;
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, OBJECT_URL_LIFETIME_MS);
}
