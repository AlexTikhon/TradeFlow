import {
  type CommodityListResponse,
  CommodityListResponseSchema,
  type PortListResponse,
  PortListResponseSchema,
  type VesselListResponse,
  VesselListResponseSchema,
} from '@tradeflow/contracts';
import { getJson } from '../../../shared/api/http-client';

export function fetchVessels(signal?: AbortSignal): Promise<VesselListResponse> {
  return getJson('/vessels', VesselListResponseSchema, { ...(signal && { signal }) });
}

export function fetchCommodities(signal?: AbortSignal): Promise<CommodityListResponse> {
  return getJson('/commodities', CommodityListResponseSchema, { ...(signal && { signal }) });
}

export function fetchPorts(signal?: AbortSignal): Promise<PortListResponse> {
  return getJson('/ports', PortListResponseSchema, { ...(signal && { signal }) });
}
