import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPreconditionFailedResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  type ConfigureTradeStringRequest,
  ConfigureTradeStringRequestSchema,
  type TradeString,
  VoyageIdParamSchema,
} from '@tradeflow/contracts';
import { schemaRef } from '../../common/http/openapi.js';
import { entityTagCondition } from '../../common/http/preconditions.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { TradeStringService } from './trade-string.service.js';

const NOT_VISIBLE = 'No such voyage, or your organization does not participate in it';

@ApiTags('voyages')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
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
  @ApiOkResponse({ schema: schemaRef('TradeString') })
  @ApiNotFoundResponse({ description: NOT_VISIBLE, schema: schemaRef('ProblemDetails') })
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

  @Post()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: "Set up a new voyage's trade string, once",
    description:
      "Operators of the voyage's exporter only (ADR 0016). Names the organizations the cargo " +
      'is sold through, in order, the exporter first; the server derives their roles (the last ' +
      'is the final buyer, those between are traders), adds them as participants, records the ' +
      'contracts between them and one audit event, all or nothing. Every organization named ' +
      'gains access to the voyage at once; this records no acceptance by them. Only a PLANNED ' +
      'voyage with no contracts and no participant but its exporter can be set up, and only ' +
      'once: a recorded chain cannot be changed through the API. No version header is needed. ' +
      'If-Match and If-None-Match, when sent, are evaluated against the trade string, which ' +
      'always exists (empty before setup) and has no entity tag: `If-Match: *` holds, a ' +
      'list of tags fails (412); `If-None-Match: *` fails (412), a list of tags holds. ' +
      'If-Unmodified-Since is ignored, the trade string having no modification date.',
  })
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'Optional. `*` holds; entity tags never match (412).',
  })
  @ApiHeader({
    name: 'If-None-Match',
    required: false,
    description: 'Optional. `*` never holds (412); entity tags always do.',
  })
  @ApiBody({ schema: schemaRef('ConfigureTradeStringRequest') })
  @ApiOkResponse({
    description: 'Set up. The trade string as recorded, as GET answers from now on.',
    schema: schemaRef('TradeString'),
  })
  @ApiForbiddenResponse({
    description:
      "Your role does not allow setting up trade strings, your organization is not the voyage's " +
      'exporter, or the request was cross-site',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiNotFoundResponse({ description: NOT_VISIBLE, schema: schemaRef('ProblemDetails') })
  @ApiConflictResponse({
    description:
      'The trade string is already set up (also when a competing request set it up first), the ' +
      'voyage is not PLANNED, or it has participants other than its exporter. Nothing was written.',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiPreconditionFailedResponse({
    description: 'A precondition sent with the request does not hold. Nothing was written.',
    schema: schemaRef('ProblemDetails'),
  })
  configure(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', new ZodValidationPipe(VoyageIdParamSchema)) voyageId: string,
    @Body(new ZodValidationPipe(ConfigureTradeStringRequestSchema))
    body: ConfigureTradeStringRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
  ): Promise<TradeString> {
    return this.tradeStrings.configure(principal, voyageId, body, {
      ifMatch: entityTagCondition(ifMatch, 'if-match'),
      ifNoneMatch: entityTagCondition(ifNoneMatch, 'if-none-match'),
    });
  }
}
