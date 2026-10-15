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
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { VoyagesService } from './voyages.service.js';

@ApiTags('voyages')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@Controller('voyages')
export class VoyagesController {
  constructor(private readonly voyages: VoyagesService) {}

  @Get()
  @ApiOperation({ summary: 'List the voyages your organization participates in' })
  @ApiQuery({ name: 'status', required: false, schema: schemaRef('VoyageStatus') })
  @ApiOkResponse({ schema: schemaRef('VoyageListResponse') })
  list(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(ListVoyagesQuerySchema)) query: ListVoyagesQuery,
  ): Promise<VoyageListResponse> {
    return this.voyages.list(principal, query);
  }

  @Get(':voyageId')
  @ApiOperation({
    summary: 'Get a voyage your organization participates in, with its participants',
  })
  @ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: schemaRef('VoyageDetail') })
  @ApiNotFoundResponse({
    description: 'No such voyage, or your organization does not participate in it',
    schema: schemaRef('ProblemDetails'),
  })
  async getById(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', new ZodValidationPipe(VoyageIdParamSchema)) voyageId: string,
  ): Promise<VoyageDetail> {
    const voyage = await this.voyages.findById(principal, voyageId);
    if (!voyage) {
      // Deliberately identical for "missing" and "not yours": existence is not disclosed.
      throw new NotFoundException('Voyage was not found.');
    }
    return voyage;
  }
}
