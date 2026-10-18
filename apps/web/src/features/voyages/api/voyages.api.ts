import {
  type ConfigureTradeStringRequest,
  type CreateVoyageRequest,
  type ListVoyagesQuery,
  type TradeString,
  TradeStringSchema,
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

/**
 * The shared contract plus the one cross-reference the visualization relies on: every edge
 * connects parties listed in the same response.
 */
const ConnectedTradeStringSchema = TradeStringSchema.refine(
  ({ parties, edges }) => {
    const listed = new Set(parties.map((party) => party.organization.id));
    return edges.every(
      (edge) => listed.has(edge.sellerOrganizationId) && listed.has(edge.buyerOrganizationId),
    );
  },
  { message: 'Every edge must connect listed parties' },
);

export function fetchTradeString(voyageId: string, signal?: AbortSignal): Promise<TradeString> {
  return getJson(
    `/voyages/${encodeURIComponent(voyageId)}/trade-string`,
    ConnectedTradeStringSchema,
    { ...(signal && { signal }) },
  );
}

/**
 * Sets up a new voyage's trade string, once (ADR 0016). A plain POST: no precondition header is
 * needed, and none is sent. The answer is the string as recorded.
 */
export function configureTradeString(
  voyageId: string,
  request: ConfigureTradeStringRequest,
): Promise<TradeString> {
  return postJson(
    `/voyages/${encodeURIComponent(voyageId)}/trade-string`,
    request,
    ConnectedTradeStringSchema,
  );
}

/** Creates a voyage for the signed-in organization; the server decides reference and parties. */
export function createVoyage(request: CreateVoyageRequest): Promise<VoyageDetail> {
  return postJson('/voyages', request, VoyageDetailSchema);
}
