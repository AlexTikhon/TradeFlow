import type { Commodity, Port, Vessel } from '@tradeflow/contracts';

/* Reference data as the lookup endpoints return it; ids match `aVoyageDetail()`. */

export const horizon: Vessel = {
  id: '01990000-0000-7000-8003-000000000001',
  name: 'MV Horizon',
  imoNumber: '9341237',
};

export const nordicHarvest: Vessel = {
  id: '01990000-0000-7000-8003-000000000002',
  name: 'MV Nordic Harvest',
  imoNumber: '9572812',
};

export const soybeans: Commodity = {
  id: '01990000-0000-7000-8004-000000000001',
  code: 'SOYBEANS',
  name: 'Soybeans',
};

export const santos: Port = {
  id: '01990000-0000-7000-8005-000000000001',
  unLocode: 'BRSSZ',
  name: 'Santos',
  countryCode: 'BR',
};

export const rotterdam: Port = {
  id: '01990000-0000-7000-8005-000000000005',
  unLocode: 'NLRTM',
  name: 'Rotterdam',
  countryCode: 'NL',
};
