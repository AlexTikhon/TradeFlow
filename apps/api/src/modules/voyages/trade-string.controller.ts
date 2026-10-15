import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { type TradeString, VoyageIdParamSchema } from '@tradeflow/contracts';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { TradeStringService } from './trade-string.service.js';

@ApiTags('voyages')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@Controller('voyages/:voyageId/trade-string')
export class TradeStringController {
  constructor(private readonly tradeStrings: TradeStringService) {}

  @Get()
  @ApiOperation({
    summary: "Get a voyage's trade string: who sells to whom, in order",
    description:
      'Topology only (ADR 0010): the parties from exporter to final buyer and the sale ' +
      'contracts connecting them, by position. Every participant of the voyage may read it. ' +
      'Commercial terms and contract references are never part of this response. Both lists ' +
      'are empty while no contracts are recorded.',
  })
  @ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: schemaRef('TradeString') })
  @ApiNotFoundResponse({
    description: 'No such voyage, or your organization does not participate in it',
    schema: schemaRef('ProblemDetails'),
  })
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', new ZodValidationPipe(VoyageIdParamSchema)) voyageId: string,
  ): Promise<TradeString> {
    const tradeString = await this.tradeStrings.findForVoyage(principal, voyageId);
    if (!tradeString) {
      // The same answer as GET /voyages/:voyageId: existence is not disclosed.
      throw new NotFoundException('Voyage was not found.');
    }
    return tradeString;
  }
}
