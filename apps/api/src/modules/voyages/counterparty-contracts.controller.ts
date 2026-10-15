import { Controller, Get, NotFoundException, Param } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import { type CounterpartyContractListResponse, VoyageIdParamSchema } from '@tradeflow/contracts';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { CounterpartyContracts } from './counterparty-contracts.js';

@ApiTags('voyages')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@Controller('voyages/:voyageId/my-contracts')
export class CounterpartyContractsController {
  constructor(private readonly contracts: CounterpartyContracts) {}

  @Get()
  @ApiOperation({
    summary: 'List the sale contracts your organization is a party to on a voyage',
    description:
      'Only contracts under which your organization is the seller or the buyer, with their ids, ' +
      'for choosing a contract to act under (ADR 0011). Empty for a participant that is a party ' +
      'to no contract, such as a surveyor. The shared trade string never carries contract ids.',
  })
  @ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: schemaRef('CounterpartyContractListResponse') })
  @ApiNotFoundResponse({
    description: 'No such voyage, or your organization does not participate in it',
    schema: schemaRef('ProblemDetails'),
  })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', new ZodValidationPipe(VoyageIdParamSchema)) voyageId: string,
  ): Promise<CounterpartyContractListResponse> {
    const items = await this.contracts.listForVoyage(principal, voyageId);
    if (!items) {
      // The same answer as GET /voyages/:voyageId: existence is not disclosed.
      throw new NotFoundException('Voyage was not found.');
    }
    return { items };
  }
}
