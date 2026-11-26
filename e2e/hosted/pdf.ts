import { randomBytes } from 'node:crypto';

/**
 * A small, valid, obviously fictional one-page PDF, padded with an unreferenced binary stream
 * object to `paddingBytes` so that the upload crosses the S3 adapter's 5 MiB multipart part
 * size. The padding is random, so every run uploads different bytes (and a different SHA-256).
 * The bytes live only in memory; they are never written to disk.
 */
export function fictionalPdf(label: string, paddingBytes: number): Buffer {
  const text = (value: string) => value.replace(/[^A-Za-z0-9 .,:-]/g, '');
  const content = Buffer.from(
    `BT /F1 14 Tf 72 770 Td (TradeFlow hosted verification: fictional bill of lading) Tj ` +
      `0 -22 Td (${text(label)}) Tj 0 -22 Td (Not a real document. No real parties.) Tj ET\n`,
  );
  const objects: Buffer[] = [
    Buffer.from('<< /Type /Catalog /Pages 2 0 R >>'),
    Buffer.from('<< /Type /Pages /Kids [3 0 R] /Count 1 >>'),
    Buffer.from(
      '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] ' +
        '/Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    ),
    Buffer.concat([
      Buffer.from(`<< /Length ${content.length} >>\nstream\n`),
      content,
      Buffer.from('endstream'),
    ]),
    Buffer.from('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>'),
    Buffer.concat([
      Buffer.from(`<< /Length ${paddingBytes} >>\nstream\n`),
      randomBytes(paddingBytes),
      Buffer.from('\nendstream'),
    ]),
  ];
  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [];
  let length = parts[0]?.length ?? 0;
  objects.forEach((body, index) => {
    offsets.push(length);
    const object = Buffer.concat([
      Buffer.from(`${index + 1} 0 obj\n`),
      body,
      Buffer.from('\nendobj\n'),
    ]);
    parts.push(object);
    length += object.length;
  });
  const xref =
    `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` +
    offsets.map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${length}\n%%EOF\n`;
  parts.push(Buffer.from(xref));
  return Buffer.concat(parts);
}
