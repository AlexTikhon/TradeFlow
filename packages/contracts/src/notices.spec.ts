import { describe, expect, it } from 'vitest';
import {
  AcknowledgeNoticeRequestSchema,
  IssueNoticeRequestSchema,
  type Notice,
  NOTICE_MESSAGE_MAX_LENGTH,
  NoticeSchema,
} from './notices.js';

const CONTRACT_ID = '01990000-0000-7000-8008-000000000101';

const validRequest = {
  contractId: CONTRACT_ID,
  estimatedArrivalAt: '2026-10-25T14:00:00Z',
  acknowledgementDueAt: '2026-10-20T12:00:00Z',
  message: 'Vessel sailed Santos on 14 Oct.',
};

const seller = { id: '01990000-0000-7000-8001-000000000001', name: 'Seller', countryCode: 'BR' };
const buyer = { id: '01990000-0000-7000-8001-000000000004', name: 'Buyer', countryCode: 'CH' };

const issued: Notice = {
  id: '01990000-0000-7000-8009-000000000001',
  voyageId: '01990000-0000-7000-8006-000000000001',
  type: 'ETA',
  status: 'ISSUED',
  contract: { id: CONTRACT_ID, position: 1, side: 'BUYER', seller, buyer },
  estimatedArrivalAt: '2026-10-25T14:00:00.000Z',
  acknowledgementDueAt: '2026-10-20T12:00:00.000Z',
  message: null,
  issuedAt: '2026-10-15T09:00:00.000Z',
  issuedBy: { name: 'Ana Souza', organization: seller },
  acknowledgedAt: null,
  acknowledgedBy: null,
  overdue: false,
};

describe('IssueNoticeRequestSchema', () => {
  it('accepts a notice with and without a message', () => {
    expect(IssueNoticeRequestSchema.parse(validRequest)).toEqual(validRequest);
    const { message: _message, ...withoutMessage } = validRequest;
    expect(IssueNoticeRequestSchema.parse(withoutMessage)).toEqual(withoutMessage);
  });

  it('accepts instants with an offset, and a deadline equal to the arrival', () => {
    const request = {
      ...validRequest,
      estimatedArrivalAt: '2026-10-25T16:00:00+02:00',
      acknowledgementDueAt: '2026-10-25T14:00:00.000Z',
    };
    expect(IssueNoticeRequestSchema.safeParse(request).success).toBe(true);
  });

  it.each([
    ['without an offset', '2026-10-25T14:00:00'],
    ['without seconds', '2026-10-25T14:00Z'],
    ['as a calendar date', '2026-10-25'],
    ['as a number', 1792936800000],
  ])('rejects an arrival %s', (_case, estimatedArrivalAt) => {
    const result = IssueNoticeRequestSchema.safeParse({ ...validRequest, estimatedArrivalAt });
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([['estimatedArrivalAt']]);
  });

  it('rejects a deadline after the arrival', () => {
    const result = IssueNoticeRequestSchema.safeParse({
      ...validRequest,
      acknowledgementDueAt: '2026-10-25T14:00:00.001Z',
    });
    expect(result.error?.issues).toEqual([
      expect.objectContaining({
        path: ['acknowledgementDueAt'],
        message: 'The acknowledgement deadline must not be after the estimated arrival',
      }),
    ]);
  });

  it('trims the message and bounds it', () => {
    expect(IssueNoticeRequestSchema.parse({ ...validRequest, message: '  ETA firm  ' })).toEqual({
      ...validRequest,
      message: 'ETA firm',
    });
    for (const message of ['   ', 'x'.repeat(NOTICE_MESSAGE_MAX_LENGTH + 1)]) {
      const result = IssueNoticeRequestSchema.safeParse({ ...validRequest, message });
      expect(result.error?.issues.map((issue) => issue.path)).toEqual([['message']]);
    }
    const longest = 'x'.repeat(NOTICE_MESSAGE_MAX_LENGTH);
    expect(IssueNoticeRequestSchema.safeParse({ ...validRequest, message: longest }).success).toBe(
      true,
    );
  });

  it('rejects fields the server decides', () => {
    for (const field of ['issuedByUserId', 'issuedAt', 'status', 'type', 'voyageId']) {
      const result = IssueNoticeRequestSchema.safeParse({ ...validRequest, [field]: 'x' });
      expect(result.success).toBe(false);
    }
  });
});

describe('AcknowledgeNoticeRequestSchema', () => {
  it('accepts only an empty object', () => {
    expect(AcknowledgeNoticeRequestSchema.safeParse({}).success).toBe(true);
    expect(
      AcknowledgeNoticeRequestSchema.safeParse({ acknowledgedAt: '2026-10-15T09:00:00Z' }).success,
    ).toBe(false);
  });
});

describe('NoticeSchema', () => {
  it('accepts an issued and an acknowledged notice', () => {
    expect(NoticeSchema.parse(issued)).toEqual(issued);
    const acknowledged: Notice = {
      ...issued,
      status: 'ACKNOWLEDGED',
      acknowledgedAt: '2026-10-16T09:00:00.000Z',
      acknowledgedBy: { name: 'Claire Morel', organization: buyer },
    };
    expect(NoticeSchema.parse(acknowledged)).toEqual(acknowledged);
  });

  it('refuses an acknowledgement that does not match the status', () => {
    expect(NoticeSchema.safeParse({ ...issued, status: 'ACKNOWLEDGED' }).success).toBe(false);
    expect(
      NoticeSchema.safeParse({ ...issued, acknowledgedAt: '2026-10-16T09:00:00.000Z' }).success,
    ).toBe(false);
  });

  it('refuses an acknowledged notice marked overdue', () => {
    const notice = {
      ...issued,
      status: 'ACKNOWLEDGED',
      acknowledgedAt: '2026-10-21T09:00:00.000Z',
      acknowledgedBy: { name: 'Claire Morel', organization: buyer },
      overdue: true,
    };
    expect(NoticeSchema.safeParse(notice).success).toBe(false);
  });

  it('expects instants in UTC', () => {
    const notice = { ...issued, issuedAt: '2026-10-15T11:00:00+02:00' };
    expect(NoticeSchema.safeParse(notice).success).toBe(false);
  });
});
