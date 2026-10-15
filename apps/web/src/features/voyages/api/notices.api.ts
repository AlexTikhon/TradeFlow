import {
  type CounterpartyContractListResponse,
  CounterpartyContractListResponseSchema,
  type IssueNoticeRequest,
  type Notice,
  type NoticeListResponse,
  NoticeListResponseSchema,
  NoticeSchema,
} from '@tradeflow/contracts';
import { getJson, postJson } from '../../../shared/api/http-client';

const voyagePath = (voyageId: string) => `/voyages/${encodeURIComponent(voyageId)}`;

/** The voyage's contracts the signed-in organization is a party to, with their ids. */
export function fetchMyContracts(
  voyageId: string,
  signal?: AbortSignal,
): Promise<CounterpartyContractListResponse> {
  return getJson(`${voyagePath(voyageId)}/my-contracts`, CounterpartyContractListResponseSchema, {
    ...(signal && { signal }),
  });
}

/** The notices under the signed-in organization's contracts on the voyage. */
export function fetchNotices(voyageId: string, signal?: AbortSignal): Promise<NoticeListResponse> {
  return getJson(`${voyagePath(voyageId)}/notices`, NoticeListResponseSchema, {
    ...(signal && { signal }),
  });
}

/** Issues an ETA notice; the server decides the issuer and the time of issue. */
export function issueNotice(voyageId: string, request: IssueNoticeRequest): Promise<Notice> {
  return postJson(`${voyagePath(voyageId)}/notices`, request, NoticeSchema);
}

/** Acknowledges receipt; the server decides who acknowledged and when. */
export function acknowledgeNotice(voyageId: string, noticeId: string): Promise<Notice> {
  return postJson(
    `${voyagePath(voyageId)}/notices/${encodeURIComponent(noticeId)}/acknowledgement`,
    {},
    NoticeSchema,
  );
}
