import { Controller, Get, Query } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
} from '@nestjs/swagger';
import {
  ACTION_ITEM_TYPES,
  ACTION_ITEMS_CURSOR_MAX_LENGTH,
  ACTION_ITEMS_DEFAULT_PAGE_SIZE,
  ACTION_ITEMS_MAX_PAGE_SIZE,
  type ActionItemPage,
  type ActionItemsQuery,
  ActionItemsQuerySchema,
} from '@tradeflow/contracts';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { ActionCenterService } from './action-center.service.js';

@ApiTags('action-center')
@ApiSessionAuth()
@Controller('action-items')
export class ActionCenterController {
  constructor(private readonly actionCenter: ActionCenterService) {}

  @Get()
  @ApiOperation({
    summary: 'List what your organization has to do next, across every voyage',
    description:
      'Open actions under the sale contracts your organization is the seller or the buyer of, ' +
      'on voyages it participates in, derived from the records on every request (ADR 0017): ' +
      'notices to acknowledge (buyer), instruction revisions to acknowledge (seller), files to ' +
      'review (buyer) and rejected files to replace (seller). Nothing is stored; an action is ' +
      'gone once the command that answers it commits, and that command decides who may run ' +
      'it. Viewers and operators read the same queue. Notices first, earliest deadline first; ' +
      'then the rest, longest waiting first. Pass `nextCursor` as `cursor`, with the same ' +
      'filters, for the next page. Each page is read afresh: see ADR 0017 for what changes ' +
      'between pages. No total is served.',
  })
  @ApiQuery({
    name: 'type',
    required: false,
    description: 'Only actions of this type.',
    schema: { type: 'string', enum: [...ACTION_ITEM_TYPES] },
  })
  @ApiQuery({
    name: 'overdue',
    required: false,
    description: '`true`: only overdue actions (only notices can be). Leave it out for all.',
    schema: { type: 'string', enum: ['true'] },
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: {
      type: 'integer',
      minimum: 1,
      maximum: ACTION_ITEMS_MAX_PAGE_SIZE,
      default: ACTION_ITEMS_DEFAULT_PAGE_SIZE,
    },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'The `nextCursor` of the previous page, unchanged.',
    schema: { type: 'string', maxLength: ACTION_ITEMS_CURSOR_MAX_LENGTH },
  })
  @ApiOkResponse({ schema: schemaRef('ActionItemPage') })
  @ApiBadRequestResponse({
    description: 'Invalid filters or limit, or a cursor the API did not issue',
    schema: schemaRef('ProblemDetails'),
  })
  page(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(ActionItemsQuerySchema)) query: ActionItemsQuery,
  ): Promise<ActionItemPage> {
    return this.actionCenter.page(principal, query);
  }
}
