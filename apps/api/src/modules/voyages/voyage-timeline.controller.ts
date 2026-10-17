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
  TIMELINE_CURSOR_MAX_LENGTH,
  TIMELINE_DEFAULT_PAGE_SIZE,
  TIMELINE_MAX_PAGE_SIZE,
  VoyageIdParamSchema,
  type VoyageTimelinePage,
  type VoyageTimelineQuery,
  VoyageTimelineQuerySchema,
} from '@tradeflow/contracts';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { VoyageTimelineService } from './voyage-timeline.service.js';

@ApiTags('voyages')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@Controller('voyages/:voyageId/timeline')
export class VoyageTimelineController {
  constructor(private readonly timelines: VoyageTimelineService) {}

  @Get()
  @ApiOperation({
    summary: "Read a voyage's timeline: who did what, and when, newest first",
    description:
      'Read-only audit events (ADR 0009), a page at a time. Every participant sees the ' +
      "voyage's creation; notice, instruction and document events are served only to the two " +
      'counterparties of the contract they happened under. Each event names who acted, for ' +
      'which organization, when, and identifiers of its subject, never the contents recorded. ' +
      'Pass `nextCursor` as `cursor` for the next, older page.',
  })
  @ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: {
      type: 'integer',
      minimum: 1,
      maximum: TIMELINE_MAX_PAGE_SIZE,
      default: TIMELINE_DEFAULT_PAGE_SIZE,
    },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'The `nextCursor` of the previous page, unchanged.',
    schema: { type: 'string', maxLength: TIMELINE_CURSOR_MAX_LENGTH },
  })
  @ApiOkResponse({ schema: schemaRef('VoyageTimelinePage') })
  @ApiNotFoundResponse({
    description: 'No such voyage, or your organization does not participate in it',
    schema: schemaRef('ProblemDetails'),
  })
  async page(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', new ZodValidationPipe(VoyageIdParamSchema)) voyageId: string,
    @Query(new ZodValidationPipe(VoyageTimelineQuerySchema)) query: VoyageTimelineQuery,
  ): Promise<VoyageTimelinePage> {
    const page = await this.timelines.page(principal, voyageId, query);
    if (!page) {
      // The same answer as GET /voyages/:voyageId: existence is not disclosed.
      throw new NotFoundException('Voyage was not found.');
    }
    return page;
  }
}
