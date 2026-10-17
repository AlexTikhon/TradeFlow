import {
  Controller,
  Get,
  NotFoundException,
  Param,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiServiceUnavailableResponse,
  ApiTags,
} from '@nestjs/swagger';
import { VoyageIdParamSchema } from '@tradeflow/contracts';
import type { Response } from 'express';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { DEFAULT_VOYAGE_EVENT_STREAM_OPTIONS, VoyageEventStreams } from './voyage-event-streams.js';

const RECHECK_SECONDS = DEFAULT_VOYAGE_EVENT_STREAM_OPTIONS.recheckIntervalMs / 1000;

@ApiTags('voyages')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@Controller('voyages/:voyageId/events')
export class VoyageEventsController {
  constructor(private readonly streams: VoyageEventStreams) {}

  @Get()
  @ApiOperation({
    summary: 'Stream signals that something on a voyage changed (server-sent events)',
    description:
      'A `text/event-stream`. The first event is `READY`, sent once changes are being ' +
      'listened for: read what you display again after it, on every (re)connection. Then one ' +
      'event per change, only to the two counterparties of the contract it happened under ' +
      '(today `NOTICE_ISSUED`, `NOTICE_ACKNOWLEDGED`, `DOCUMENTARY_INSTRUCTION_REVISED` and ' +
      '`DOCUMENTARY_INSTRUCTION_ACKNOWLEDGED`), carrying its type and nothing else: ' +
      'read the data through the REST endpoints. The session and participation are checked ' +
      `again before every event and at least every ${RECHECK_SECONDS} s; the stream ends ` +
      'when either is gone. Best effort: no ids, no replay, and only changes made through ' +
      'this API instance.',
  })
  @ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({
    description: 'An open stream; each event’s `data` is a `VoyageStreamMessage` as JSON.',
    content: { 'text/event-stream': { schema: schemaRef('VoyageStreamMessage') } },
  })
  @ApiNotFoundResponse({
    description: 'No such voyage, or your organization does not participate in it',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiServiceUnavailableResponse({
    description: 'The server is shutting down; connect again later',
    schema: schemaRef('ProblemDetails'),
  })
  async stream(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', new ZodValidationPipe(VoyageIdParamSchema)) voyageId: string,
    @Res() response: Response,
  ): Promise<void> {
    switch (await this.streams.open(principal, voyageId, response)) {
      case 'not-found':
        // The same answer as GET /voyages/:voyageId: existence is not disclosed.
        throw new NotFoundException('Voyage was not found.');
      case 'shutting-down':
        // The browser gives up on this stream and the page connects again later.
        throw new ServiceUnavailableException('The server is shutting down.');
      case 'streaming':
      case 'client-gone':
        return;
    }
  }
}
