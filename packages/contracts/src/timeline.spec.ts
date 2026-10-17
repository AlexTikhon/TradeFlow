import { describe, expect, it } from 'vitest';
import { TimelineEventSchema, VoyageTimelineQuerySchema } from './timeline.js';

const actor = {
  name: 'Ana Souza',
  organization: {
    id: '01990000-0000-7000-8001-000000000001',
    name: 'Cerrado Grãos Exportadora S.A.',
    countryCode: 'BR',
  },
};
const base = {
  id: '01990000-0000-7000-8010-000000000001',
  occurredAt: '2026-10-15T12:00:00.000Z',
  actor,
};
const contract = { id: '01990000-0000-7000-8007-000000000001', position: 1 };
const upload = {
  ...base,
  action: 'DOCUMENT_VERSION_UPLOADED',
  contract,
  documentId: '01990000-0000-7000-8011-000000000001',
  revisionNumber: 1,
  documentType: 'BILL_OF_LADING',
  versionNumber: 1,
  version: 1,
};

describe('VoyageTimelineQuerySchema', () => {
  it('accepts an empty query', () => {
    expect(VoyageTimelineQuerySchema.parse({})).toEqual({});
  });

  it('reads the limit as a number', () => {
    expect(VoyageTimelineQuerySchema.parse({ limit: '50' })).toEqual({ limit: 50 });
  });

  it.each(['0', '51', '-1', '1.5', '01', 'ten', ''])('rejects limit %j', (limit) => {
    expect(VoyageTimelineQuerySchema.safeParse({ limit }).success).toBe(false);
  });

  it.each(['', 'a+b', 'a/b', 'a=', 'x'.repeat(201)])('rejects cursor %j', (cursor) => {
    expect(VoyageTimelineQuerySchema.safeParse({ cursor }).success).toBe(false);
  });

  it('rejects a repeated parameter', () => {
    expect(VoyageTimelineQuerySchema.safeParse({ cursor: ['a', 'b'] }).success).toBe(false);
  });
});

describe('TimelineEventSchema', () => {
  it('accepts an upload recorded before document versions, with a null version', () => {
    expect(TimelineEventSchema.safeParse({ ...upload, version: null }).success).toBe(true);
  });

  it('requires a review to name its decision and the version it produced', () => {
    const review = { ...upload, action: 'DOCUMENT_VERSION_REVIEWED', decision: 'APPROVED' };
    expect(TimelineEventSchema.safeParse(review).success).toBe(true);
    expect(TimelineEventSchema.safeParse({ ...review, version: null }).success).toBe(false);
    expect(TimelineEventSchema.safeParse({ ...review, decision: undefined }).success).toBe(false);
  });

  it('requires a contract on every event but the creation', () => {
    expect(TimelineEventSchema.safeParse({ ...base, action: 'VOYAGE_CREATED' }).success).toBe(true);
    expect(
      TimelineEventSchema.safeParse({
        ...base,
        action: 'NOTICE_ISSUED',
        noticeId: '01990000-0000-7000-8009-000000000001',
      }).success,
    ).toBe(false);
  });

  it('drops anything beyond the event’s identifiers', () => {
    const parsed = TimelineEventSchema.parse({
      ...upload,
      fileName: 'secret.pdf',
      sha256: 'ab'.repeat(32),
    });
    expect(parsed).not.toHaveProperty('fileName');
    expect(parsed).not.toHaveProperty('sha256');
  });

  it('rejects an action it does not know', () => {
    expect(TimelineEventSchema.safeParse({ ...base, action: 'VOYAGE_DELETED' }).success).toBe(
      false,
    );
  });
});
