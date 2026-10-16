import { createHash, randomBytes } from 'node:crypto';
import { Readable, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { describe, expect, it } from 'vitest';
import {
  displayFileName,
  startsLikePdf,
  UNNAMED_FILE,
  UploadInspection,
} from './document-rules.js';

describe('startsLikePdf', () => {
  it('accepts bytes that start with the PDF signature', () => {
    expect(startsLikePdf(Buffer.from('%PDF-1.7\n'))).toBe(true);
    expect(startsLikePdf(Buffer.from('%PDF-'))).toBe(true);
  });

  it.each([
    ['a PNG', Buffer.from([0x89, 0x50, 0x4e, 0x47])],
    ['text that mentions PDF later', Buffer.from(' %PDF-1.7')],
    ['a truncated signature', Buffer.from('%PDF')],
    ['nothing', Buffer.alloc(0)],
  ])('refuses %s', (_case, head) => {
    expect(startsLikePdf(head)).toBe(false);
  });
});

describe('displayFileName', () => {
  it.each<[string, string, string]>([
    ['a plain name', 'bill-of-lading.pdf', 'bill-of-lading.pdf'],
    ['a POSIX path', '../../etc/passwd.pdf', 'passwd.pdf'],
    ['a Windows path', 'C:\\Users\\ana\\Desktop\\BL 7.pdf', 'BL 7.pdf'],
    ['control characters', 'BL\r\n7\u0000.pdf', 'BL7.pdf'],
    ['a bidirectional override', 'invoice\u202Efdp.exe', 'invoicefdp.exe'],
    ['surrounding blanks', '  BL 7.pdf  ', 'BL 7.pdf'],
    ['decomposed accents, made composed', 'Gra\u0303os.pdf', 'Grãos.pdf'],
    ['nothing', '', UNNAMED_FILE],
    ['only a directory', 'scans/', UNNAMED_FILE],
    ['a dot-dot', '..', UNNAMED_FILE],
    ['only invisible characters', '\u200b\u202e', UNNAMED_FILE],
  ])('keeps %s displayable', (_case, raw, shown) => {
    expect(displayFileName(raw)).toBe(shown);
  });

  it('keeps at most 255 characters without splitting one', () => {
    const name = displayFileName(`${'😀'.repeat(300)}.pdf`);

    expect(Array.from(name)).toHaveLength(255);
    expect(name).toBe('😀'.repeat(255));
  });
});

describe('UploadInspection', () => {
  const run = async (inspection: UploadInspection, chunks: Buffer[]) => {
    const out: Buffer[] = [];
    await pipeline(
      Readable.from(chunks),
      inspection,
      new Writable({
        write(chunk: Buffer, _encoding, done) {
          out.push(chunk);
          done();
        },
      }),
    );
    return Buffer.concat(out);
  };

  it('passes bytes through unchanged, counting, hashing and keeping the first ones', async () => {
    const bytes = Buffer.concat([Buffer.from('%P'), Buffer.from('DF-1.7'), randomBytes(70_000)]);
    const inspection = new UploadInspection(1_000_000, () => new Error('too large'));

    const passed = await run(inspection, [
      bytes.subarray(0, 2),
      bytes.subarray(2, 8),
      bytes.subarray(8),
    ]);

    expect(passed.equals(bytes)).toBe(true);
    expect(inspection.size).toBe(bytes.length);
    expect(inspection.head.toString('latin1')).toBe('%PDF-1.7');
    expect(inspection.digest().equals(createHash('sha256').update(bytes).digest())).toBe(true);
  });

  it('fails as soon as the limit is passed', async () => {
    const inspection = new UploadInspection(10, () => new Error('too large'));

    await expect(run(inspection, [Buffer.alloc(6), Buffer.alloc(5)])).rejects.toThrow('too large');
    expect(inspection.size).toBe(11);
  });

  it('accepts exactly the limit', async () => {
    const inspection = new UploadInspection(10, () => new Error('too large'));

    await run(inspection, [Buffer.alloc(10)]);

    expect(inspection.size).toBe(10);
  });
});
