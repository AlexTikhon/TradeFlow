import { createHash } from 'node:crypto';
import { Transform, type TransformCallback } from 'node:stream';
import { DOCUMENT_FILE_NAME_MAX_LENGTH, MAX_DOCUMENT_BYTES } from '@tradeflow/contracts';

/*
 * MVP rules for document files (ADR 0013). Pure, apart from the stream that measures an upload
 * as it passes through.
 *
 * - PDF only, judged by the bytes: a PDF file starts with `%PDF-`. A file that only says it is a
 *   PDF (its name, its declared type) is not accepted. (Readers tolerate junk before the header;
 *   these rules do not.)
 * - 1 byte to 10 MiB.
 * - The client's file name is display text: reduced to a bare, printable name, and never used to
 *   name anything in storage.
 */

/** The 413 message for a file over the limit. */
export const DOCUMENT_TOO_LARGE = 'The file is larger than 10 MiB.';

/** The whole multipart body may exceed the file by this much framing (boundaries, part headers). */
const MULTIPART_OVERHEAD_BYTES = 64 * 1024;
export const MAX_UPLOAD_REQUEST_BYTES = MAX_DOCUMENT_BYTES + MULTIPART_OVERHEAD_BYTES;

const PDF_SIGNATURE = Buffer.from('%PDF-', 'latin1');

/** Whether `head`, the first bytes of a file, are those of a PDF. */
export const startsLikePdf = (head: Buffer): boolean =>
  head.subarray(0, PDF_SIGNATURE.length).equals(PDF_SIGNATURE);

/** The name shown for a file the client uploaded without a usable one. */
export const UNNAMED_FILE = 'document.pdf';

/**
 * Code points a displayed name must not contain: control characters (C0, DEL, C1) and the
 * invisible formatting characters that can disguise a name, namely zero-width characters and
 * directional marks (U+200B to U+200F), bidirectional embeddings and overrides (U+202A to
 * U+202E: "invoice", U+202E, "fdp.exe" reads as "invoiceexe.pdf"), isolates (U+2066 to U+2069)
 * and the byte-order mark (U+FEFF).
 */
const UNSAFE_RANGES: readonly (readonly [number, number])[] = [
  [0x00, 0x1f],
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x202a, 0x202e],
  [0x2066, 0x2069],
  [0xfeff, 0xfeff],
];

const isSafe = (character: string) => {
  const code = character.codePointAt(0) ?? 0;
  return !UNSAFE_RANGES.some(([from, to]) => code >= from && code <= to);
};

/**
 * The client's file name as it may be shown: its last path segment only (whichever separator the
 * client's system used), without control or disguising characters, trimmed, at most 255
 * characters (never splitting a character). Falls back to `document.pdf`.
 */
export function displayFileName(clientFileName: string): string {
  const lastSegment = clientFileName.normalize('NFC').split(/[/\\]/).pop() ?? '';
  const visible = Array.from(lastSegment).filter(isSafe).join('').trim();
  const bounded = Array.from(visible).slice(0, DOCUMENT_FILE_NAME_MAX_LENGTH).join('').trim();
  return bounded === '' || bounded === '.' || bounded === '..' ? UNNAMED_FILE : bounded;
}

/** How many leading bytes `UploadInspection` keeps, for the signature check. */
const HEAD_BYTES = 8;

/**
 * Passes bytes through unchanged while counting them, hashing them (SHA-256) and keeping the
 * first few. Fails with `tooLarge()` as soon as more than `maxBytes` have passed, so a limit holds
 * even where nothing upstream enforced it.
 */
export class UploadInspection extends Transform {
  size = 0;
  private readonly hash = createHash('sha256');
  private readonly headChunks: Buffer[] = [];
  private headLength = 0;

  constructor(
    private readonly maxBytes: number,
    private readonly tooLarge: () => Error,
  ) {
    super();
  }

  override _transform(chunk: Buffer, _encoding: BufferEncoding, done: TransformCallback): void {
    this.size += chunk.length;
    if (this.size > this.maxBytes) {
      done(this.tooLarge());
      return;
    }
    this.hash.update(chunk);
    if (this.headLength < HEAD_BYTES) {
      this.headChunks.push(chunk.subarray(0, HEAD_BYTES - this.headLength));
      this.headLength += Math.min(chunk.length, HEAD_BYTES - this.headLength);
    }
    done(null, chunk);
  }

  /** The first bytes seen. */
  get head(): Buffer {
    return Buffer.concat(this.headChunks);
  }

  /** The SHA-256 of everything that passed. Call once, after the stream has ended. */
  digest(): Buffer {
    return this.hash.digest();
  }
}
