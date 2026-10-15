import { Controller, Get, NotFoundException, Param, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  type ListVoyagesQuery,
  ListVoyagesQuerySchema,
  type VoyageDetail,
  VoyageIdParamSchema,
  type VoyageListResponse,
} from '@tradeflow/contracts';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { VoyagesService } from './voyages.service.js';

@ApiTags('voyages')
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@Controller('voyages')
export class VoyagesController {
  constructor(private readonly voyages: VoyagesService) {}

  @Get()
  @ApiOperation({ summary: 'List voyages' })
  @ApiQuery({ name: 'status', required: false, schema: schemaRef('VoyageStatus') })
  @ApiOkResponse({ schema: schemaRef('VoyageListResponse') })
  list(
    @Query(new ZodValidationPipe(ListVoyagesQuerySchema)) query: ListVoyagesQuery,
  ): Promise<VoyageListResponse> {
    return this.voyages.list(query);
  }

  @Get(':voyageId')
  @ApiOperation({ summary: 'Get a voyage with its participants' })
  @ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: schemaRef('VoyageDetail') })
  @ApiNotFoundResponse({ description: 'Voyage not found', schema: schemaRef('ProblemDetails') })
  async getById(
    @Param('voyageId', new ZodValidationPipe(VoyageIdParamSchema)) voyageId: string,
  ): Promise<VoyageDetail> {
    const voyage = await this.voyages.findById(voyageId);
    if (!voyage) {
      throw new NotFoundException(`Voyage ${voyageId} was not found.`);
    }
    return voyage;
  }
}
