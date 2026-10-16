import { describe, expect, it } from 'vitest';
import { attachmentDisposition } from './content-disposition.js';

describe('attachmentDisposition', () => {
  it('offers a plain name as it is', () => {
    expect(attachmentDisposition('bill-of-lading.pdf')).toBe(
      `attachment; filename="bill-of-lading.pdf"; filename*=UTF-8''bill-of-lading.pdf`,
    );
  });

  it('keeps the exact name in filename* and an ASCII fallback in filename', () => {
    expect(attachmentDisposition('Conhecimento de embarque nº 7 – Grãos.pdf')).toBe(
      `attachment; filename="Conhecimento de embarque no 7  Graos.pdf"; ` +
        `filename*=UTF-8''Conhecimento%20de%20embarque%20n%C2%BA%207%20%E2%80%93%20Gr%C3%A3os.pdf`,
    );
  });

  it('cannot be broken out of: quotes, backslashes and parameters stay inside the value', () => {
    const header = attachmentDisposition('a"; filename=evil.html; x="\\.pdf');

    expect(header).toBe(
      `attachment; filename="a_; filename=evil.html; x=__.pdf"; ` +
        `filename*=UTF-8''a%22%3B%20filename%3Devil.html%3B%20x%3D%22%5C.pdf`,
    );
  });

  it('percent-encodes the characters RFC 8187 does not allow bare', () => {
    expect(attachmentDisposition("it's (final)*.pdf")).toContain(
      `filename*=UTF-8''it%27s%20%28final%29%2A.pdf`,
    );
  });

  it('falls back to a neutral name when nothing ASCII is left', () => {
    expect(attachmentDisposition('合同.pdf')).toMatch(/^attachment; filename="\.pdf";/);
    expect(attachmentDisposition('合同')).toMatch(/^attachment; filename="document";/);
  });
});
