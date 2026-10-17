import { describe, expect, it } from 'vitest';
import { VoyageStreamMessageSchema } from './voyage-events.js';

describe('VoyageStreamMessageSchema', () => {
  it.each(['READY', 'NOTICE_ISSUED', 'NOTICE_ACKNOWLEDGED'])('accepts %s', (type) => {
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
  });

  it.each([
    { type: 'VOYAGE_CREATED' },
    { type: 'DOCUMENT_VERSION_UPLOADED' },
    { type: 'notice_issued' },
    {},
    null,
  ])('rejects %j', (message) => {
    expect(VoyageStreamMessageSchema.safeParse(message).success).toBe(false);
  });
});
