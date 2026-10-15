import {
  type CreateVoyageRequest,
  type ListVoyagesQuery,
  type VoyageDetail,
  VoyageDetailSchema,
  type VoyageListResponse,
  VoyageListResponseSchema,
} from '@tradeflow/contracts';
import { getJson, postJson } from '../../../shared/api/http-client';

export function fetchVoyages(
  query: ListVoyagesQuery,
  signal?: AbortSignal,
): Promise<VoyageListResponse> {
  return getJson('/voyages', VoyageListResponseSchema, {
    query: { status: query.status },
    ...(signal && { signal }),
  });
}

export function fetchVoyage(voyageId: string, signal?: AbortSignal): Promise<VoyageDetail> {
  return getJson(`/voyages/${encodeURIComponent(voyageId)}`, VoyageDetailSchema, {
    ...(signal && { signal }),
  });
}

/** Creates a voyage for the signed-in organization; the server decides reference and parties. */
export function createVoyage(request: CreateVoyageRequest): Promise<VoyageDetail> {
  return postJson('/voyages', request, VoyageDetailSchema);
}
