import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  NotFoundException,
  Param,
  Post,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiTags,
} from '@nestjs/swagger';
import {
  AcknowledgeNoticeRequestSchema,
  type IssueNoticeRequest,
  IssueNoticeRequestSchema,
  type Notice,
  NoticeIdParamSchema,
  type NoticeListResponse,
  VoyageIdParamSchema,
} from '@tradeflow/contracts';
import type { Response } from 'express';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { NoticesService } from './notices.service.js';

const voyageIdPipe = () => new ZodValidationPipe(VoyageIdParamSchema);
const noticeIdPipe = () => new ZodValidationPipe(NoticeIdParamSchema);

/** One answer for every notice the caller cannot see: existence is not disclosed. */
const NOTICE_NOT_FOUND = 'Notice was not found.';
const NOT_VISIBLE =
  'No such notice on this voyage, or it is under a contract your organization is not a party to';

@ApiTags('notices')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
@Controller('voyages/:voyageId/notices')
export class NoticesController {
  constructor(private readonly notices: NoticesService) {}

  @Get()
  @ApiOperation({
    summary: 'List the notices under your contracts on a voyage',
    description:
      'Only notices under contracts your organization is the seller or the buyer of. Other ' +
      'participants, service providers included, get an empty list. `overdue` is derived when ' +
      'the response is built.',
  })
  @ApiOkResponse({ schema: schemaRef('NoticeListResponse') })
  @ApiNotFoundResponse({
    description: 'No such voyage, or your organization does not participate in it',
    schema: schemaRef('ProblemDetails'),
  })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
  ): Promise<NoticeListResponse> {
    const notices = await this.notices.list(principal, voyageId);
    if (!notices) {
      throw new NotFoundException('Voyage was not found.');
    }
    return notices;
  }

  @Post()
  @ApiOperation({
    summary: 'Issue an ETA notice to the buyer under one of your contracts',
    description:
      "Operators of the contract's seller only. The notice starts ISSUED; the issuer, their " +
      'organization and the time of issue come from the session and the server. The ' +
      'acknowledgement deadline must be in the future and not after the estimated arrival. ' +
      'Issued content cannot be changed afterwards.',
  })
  @ApiBody({ schema: schemaRef('IssueNoticeRequest') })
  @ApiCreatedResponse({
    description: 'Issued. `Location` points at the new notice.',
    schema: schemaRef('Notice'),
  })
  @ApiForbiddenResponse({
    description:
      'Your role does not allow issuing notices, your organization is the buyer under this ' +
      'contract, or the request was cross-site',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiNotFoundResponse({
    description:
      'No such contract on this voyage, or your organization is not a party to it (or does not ' +
      'participate in the voyage)',
    schema: schemaRef('ProblemDetails'),
  })
  async issue(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Body(new ZodValidationPipe(IssueNoticeRequestSchema)) body: IssueNoticeRequest,
    @Res({ passthrough: true }) response: Response,
  ): Promise<Notice> {
    const notice = await this.notices.issue(principal, voyageId, body);
    if (!notice) {
      throw new NotFoundException('Contract was not found.');
    }
    response.location(`/api/voyages/${voyageId}/notices/${notice.id}`);
    return notice;
  }

  @Get(':noticeId')
  @ApiOperation({ summary: 'Get a notice under one of your contracts' })
  @ApiParam({ name: 'noticeId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: schemaRef('Notice') })
  @ApiNotFoundResponse({ description: NOT_VISIBLE, schema: schemaRef('ProblemDetails') })
  async getById(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Param('noticeId', noticeIdPipe()) noticeId: string,
  ): Promise<Notice> {
    const notice = await this.notices.findById(principal, voyageId, noticeId);
    if (!notice) {
      throw new NotFoundException(NOTICE_NOT_FOUND);
    }
    return notice;
  }

  @Post(':noticeId/acknowledgement')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge receipt of a notice under one of your contracts',
    description:
      "Operators of the contract's buyer only. Records receipt, not commercial acceptance. " +
      'Allowed after the deadline. Who acknowledged and when come from the session and the ' +
      'server; the body is empty or absent. A notice is acknowledged once: a second attempt, ' +
      'concurrent or later, gets 409.',
  })
  @ApiParam({ name: 'noticeId', schema: { type: 'string', format: 'uuid' } })
  @ApiBody({ schema: schemaRef('AcknowledgeNoticeRequest'), required: false })
  @ApiOkResponse({ description: 'Acknowledged.', schema: schemaRef('Notice') })
  @ApiForbiddenResponse({
    description:
      'Your role does not allow acknowledging notices, your organization is the seller under ' +
      'this contract, or the request was cross-site',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiNotFoundResponse({ description: NOT_VISIBLE, schema: schemaRef('ProblemDetails') })
  @ApiConflictResponse({
    description: 'The notice has already been acknowledged',
    schema: schemaRef('ProblemDetails'),
  })
  async acknowledge(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Param('noticeId', noticeIdPipe()) noticeId: string,
    // Validated only so that a body trying to set the actor or time is refused, not ignored.
    @Body(new ZodValidationPipe(AcknowledgeNoticeRequestSchema.optional())) _body: unknown,
  ): Promise<Notice> {
    const notice = await this.notices.acknowledge(principal, voyageId, noticeId);
    if (!notice) {
      throw new NotFoundException(NOTICE_NOT_FOUND);
    }
    return notice;
  }
}
