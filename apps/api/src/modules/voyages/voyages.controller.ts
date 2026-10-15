import { Body, Controller, Get, NotFoundException, Param, Post, Query, Res } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  type CreateVoyageRequest,
  CreateVoyageRequestSchema,
  type ListVoyagesQuery,
  ListVoyagesQuerySchema,
  type VoyageDetail,
  VoyageIdParamSchema,
  type VoyageListResponse,
} from '@tradeflow/contracts';
import type { Response } from 'express';
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

  @Post()
  @ApiOperation({
    summary: 'Create a voyage; your organization becomes its exporter',
    description:
      'Operators only. The voyage starts PLANNED with a server-assigned reference, and your ' +
      'organization (from the session) is added as its EXPORTER participant. The body carries ' +
      'only shipment facts: fields such as organizationId, participants or status are rejected.',
  })
  @ApiBody({ schema: schemaRef('CreateVoyageRequest') })
  @ApiCreatedResponse({
    description: 'Created. `Location` points at the new voyage.',
    schema: schemaRef('VoyageDetail'),
  })
  @ApiForbiddenResponse({
    description: 'Your role does not allow creating voyages, or the request was cross-site',
    schema: schemaRef('ProblemDetails'),
  })
  async create(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(CreateVoyageRequestSchema)) body: CreateVoyageRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<VoyageDetail> {
    const voyage = await this.voyages.create(principal, body);
    response.location(`/api/voyages/${voyage.id}`);
    return voyage;
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
