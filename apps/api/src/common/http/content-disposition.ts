/*
 * `Content-Disposition: attachment` (RFC 6266) for a file name that came from a client. The name
 * is display text: it is quoted, never interpreted, and offered twice, as an ASCII fallback in
 * `filename` and exactly in `filename*` (RFC 8187, UTF-8, percent-encoded).
 */

const FALLBACK_NAME = 'document';

/** RFC 8187 `value-chars`: what encodeURIComponent leaves alone, minus `'()*`. */
const encodeExtValue = (value: string) =>
  encodeURIComponent(value).replace(
    /['()*]/g,
    (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`,
  );

/**
 * Printable ASCII only, without the characters that end or escape a quoted string, or that some
 * browsers decode in `filename` (`%`).
 */
function asciiFallback(fileName: string): string {
  const ascii = fileName
    .normalize('NFKD')
    .replace(/[^\x20-\x7e]/g, '')
    .replace(/["\\%]/g, '_')
    .trim();
  return ascii === '' ? FALLBACK_NAME : ascii;
}

/** A download, never displayed inline, offered under `fileName`. */
export function attachmentDisposition(fileName: string): string {
  return `attachment; filename="${asciiFallback(fileName)}"; filename*=UTF-8''${encodeExtValue(fileName)}`;
}
