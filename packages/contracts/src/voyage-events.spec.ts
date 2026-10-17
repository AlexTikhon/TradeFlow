import { describe, expect, it } from 'vitest';
import { VoyageStreamMessageSchema } from './voyage-events.js';

describe('VoyageStreamMessageSchema', () => {
  it.each([
    'READY',
    'NOTICE_ISSUED',
    'NOTICE_ACKNOWLEDGED',
    'DOCUMENTARY_INSTRUCTION_REVISED',
    'DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED',
    'DOCUMENT_VERSION_UPLOADED',
    'DOCUMENT_VERSION_REVIEWED',
  ])('accepts %s', (type) => {
    expect(VoyageStreamMessageSchema.parse({ type })).toEqual({ type });
  });

  it('keeps only the type, whatever else a message carries', () => {
    expect(
      VoyageStreamMessageSchema.parse({
        type: 'NOTICE_ISSUED',
        noticeId: '01990000-0000-7000-8009-000000000001',
        payload: { message: 'secret' },
      }),
    ).toEqual({ type: 'NOTICE_ISSUED' });
    expect(
      VoyageStreamMessageSchema.parse({
        type: 'DOCUMENTARY_INSTRUCTION_REVISED',
        instructionId: '01990000-0000-7000-800a-000000000001',
        version: 2,
        consignee: 'To order of a confidential bank',
      }),
    ).toEqual({ type: 'DOCUMENTARY_INSTRUCTION_REVISED' });
    expect(
      VoyageStreamMessageSchema.parse({
        type: 'DOCUMENT_VERSION_UPLOADED',
        documentId: '01990000-0000-7000-800b-000000000001',
        fileName: 'confidential-bill-of-lading.pdf',
        sha256: '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08',
        storageKey: '01990000-0000-7000-800c-000000000001',
      }),
    ).toEqual({ type: 'DOCUMENT_VERSION_UPLOADED' });
    expect(
      VoyageStreamMessageSchema.parse({
        type: 'DOCUMENT_VERSION_REVIEWED',
        versionNumber: 2,
        decision: 'REJECTED',
        reason: 'The consignee does not match.',
      }),
    ).toEqual({ type: 'DOCUMENT_VERSION_REVIEWED' });
  });

  it.each([
    { type: 'VOYAGE_CREATED' },
    { type: 'DOCUMENT_DELETED' },
    { type: 'notice_issued' },
    {},
    null,
  ])('rejects %j', (message) => {
    expect(VoyageStreamMessageSchema.safeParse(message).success).toBe(false);
  });
});
