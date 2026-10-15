import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import type {
  CommodityListResponse,
  PortListResponse,
  VesselListResponse,
} from '@tradeflow/contracts';
import { schemaRef } from '../../common/http/openapi.js';
import { ApiSessionAuth } from '../auth/auth.decorators.js';
import { ReferenceDataService } from './reference-data.service.js';

/** Lookups for forms. Shared by all organizations, but only for signed-in users. */
@ApiTags('reference data')
@ApiSessionAuth()
@Controller()
export class ReferenceDataController {
  constructor(private readonly referenceData: ReferenceDataService) {}

  @Get('vessels')
  @ApiOperation({ summary: 'List vessels, by name' })
  @ApiOkResponse({ schema: schemaRef('VesselListResponse') })
  listVessels(): Promise<VesselListResponse> {
    return this.referenceData.listVessels();
  }

  @Get('commodities')
  @ApiOperation({ summary: 'List commodities, by name' })
  @ApiOkResponse({ schema: schemaRef('CommodityListResponse') })
  listCommodities(): Promise<CommodityListResponse> {
    return this.referenceData.listCommodities();
  }

  @Get('ports')
  @ApiOperation({ summary: 'List ports, by name' })
  @ApiOkResponse({ schema: schemaRef('PortListResponse') })
  listPorts(): Promise<PortListResponse> {
    return this.referenceData.listPorts();
  }
}
