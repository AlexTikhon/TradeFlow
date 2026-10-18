import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiForbiddenResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ORGANIZATION_SEARCH_MAX_LENGTH,
  ORGANIZATION_SEARCH_MAX_RESULTS,
  ORGANIZATION_SEARCH_MIN_LENGTH,
  type OrganizationSearchQuery,
  OrganizationSearchQuerySchema,
  type OrganizationSearchResponse,
} from '@tradeflow/contracts';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { OrganizationsService } from './organizations.service.js';

@ApiTags('organizations')
@ApiSessionAuth()
@Controller('organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  @ApiOperation({
    summary: 'Find organizations by part of their name, to name in a trade string',
    description:
      `Operators only. At most ${ORGANIZATION_SEARCH_MAX_RESULTS} organizations, by name, each ` +
      'as its id, name and country only; never your own organization. There is no listing ' +
      'without a search text.',
  })
  @ApiQuery({
    name: 'search',
    required: true,
    description: 'Part of the name, matched case-insensitively.',
    schema: {
      type: 'string',
      minLength: ORGANIZATION_SEARCH_MIN_LENGTH,
      maxLength: ORGANIZATION_SEARCH_MAX_LENGTH,
    },
  })
  @ApiOkResponse({ schema: schemaRef('OrganizationSearchResponse') })
  @ApiBadRequestResponse({
    description: 'No search text, or one too short or too long',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiForbiddenResponse({
    description: 'Your role does not allow searching organizations',
    schema: schemaRef('ProblemDetails'),
  })
  search(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(OrganizationSearchQuerySchema)) query: OrganizationSearchQuery,
  ): Promise<OrganizationSearchResponse> {
    return this.organizations.search(principal, query);
  }
}
