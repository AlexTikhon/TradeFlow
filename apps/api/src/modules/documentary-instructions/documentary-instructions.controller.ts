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
  Put,
  Res,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPreconditionFailedResponse,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  AcknowledgeRevisionRequestSchema,
  ContractIdParamSchema,
  type DocumentaryInstruction,
  type DocumentaryInstructionContent,
  DocumentaryInstructionContentSchema,
  type DocumentaryInstructionListResponse,
  instructionEntityTag,
  RevisionNumberParamSchema,
  VoyageIdParamSchema,
} from '@tradeflow/contracts';
import type { Response } from 'express';
import { schemaRef } from '../../common/http/openapi.js';
import {
  PreconditionRequiredException,
  versionsFromIfMatch,
  type WritePrecondition,
  writePrecondition,
} from '../../common/http/preconditions.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { DocumentaryInstructionsService } from './documentary-instructions.service.js';

const voyageIdPipe = () => new ZodValidationPipe(VoyageIdParamSchema);
const contractIdPipe = () => new ZodValidationPipe(ContractIdParamSchema);

/** One answer for every instruction the caller cannot see: existence is not disclosed. */
const INSTRUCTIONS_NOT_FOUND = 'Documentary instructions were not found.';
const NOT_VISIBLE =
  'No such contract on this voyage, your organization is not a party to it, or it has no ' +
  'documentary instructions yet';

const INSTRUCTION_PATH = 'contracts/:contractId/documentary-instructions';

const ETAG_HEADER = {
  ETag: {
    description: 'The entity tag of the version returned, e.g. `"3"`. Send it back in If-Match.',
    schema: { type: 'string' },
  },
} as const;

const PRECONDITION_REQUIRED = {
  status: HttpStatus.PRECONDITION_REQUIRED,
  description: 'The change does not name the version it is based on (no If-Match, or `*`)',
  schema: schemaRef('ProblemDetails'),
} as const;

/** The precondition of a PUT: create when nothing exists, or revise a named version. */
const putPrecondition = (
  ifMatch: string | undefined,
  ifNoneMatch: string | undefined,
): WritePrecondition =>
  writePrecondition(
    ifMatch,
    ifNoneMatch,
    'Send If-Match with the version your revision is based on, or If-None-Match: * to give ' +
      'the first instructions.',
  );

@ApiTags('documentary-instructions')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
@Controller('voyages/:voyageId')
export class DocumentaryInstructionsController {
  constructor(private readonly instructions: DocumentaryInstructionsService) {}

  @Get('documentary-instructions')
  @ApiOperation({
    summary: 'List the documentary instructions under your contracts on a voyage',
    description:
      'Only instructions under contracts your organization is the seller or the buyer of, in ' +
      'contract order, each with its version and every revision. Other participants, service ' +
      'providers included, get an empty list.',
  })
  @ApiOkResponse({ schema: schemaRef('DocumentaryInstructionListResponse') })
  @ApiNotFoundResponse({
    description: 'No such voyage, or your organization does not participate in it',
    schema: schemaRef('ProblemDetails'),
  })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
  ): Promise<DocumentaryInstructionListResponse> {
    const instructions = await this.instructions.list(principal, voyageId);
    if (!instructions) {
      throw new NotFoundException('Voyage was not found.');
    }
    return instructions;
  }

  @Get(INSTRUCTION_PATH)
  @ApiOperation({ summary: 'Get the documentary instructions under one of your contracts' })
  @ApiParam({ name: 'contractId', schema: { type: 'string', format: 'uuid' } })
  @ApiOkResponse({ schema: schemaRef('DocumentaryInstruction'), headers: ETAG_HEADER })
  @ApiNotFoundResponse({ description: NOT_VISIBLE, schema: schemaRef('ProblemDetails') })
  async get(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Param('contractId', contractIdPipe()) contractId: string,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DocumentaryInstruction> {
    const instruction = await this.instructions.findForContract(principal, voyageId, contractId);
    if (!instruction) {
      throw new NotFoundException(INSTRUCTIONS_NOT_FOUND);
    }
    response.setHeader('ETag', instructionEntityTag(instruction.version));
    return instruction;
  }

  @Put(INSTRUCTION_PATH)
  @ApiOperation({
    summary: 'Give or revise the documentary instructions under one of your contracts',
    description:
      "Operators of the contract's buyer only. The body is the full content of a new revision; " +
      'earlier revisions are kept unchanged. Conditional: send `If-None-Match: *` to give the ' +
      'first instructions (201), or `If-Match` with the entity tag of the version you revised ' +
      '(200). A new revision starts unacknowledged. The author and the time come from the ' +
      'session and the server.',
  })
  @ApiParam({ name: 'contractId', schema: { type: 'string', format: 'uuid' } })
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'The entity tag of the version this revision is based on, e.g. `"3"`.',
  })
  @ApiHeader({
    name: 'If-None-Match',
    required: false,
    description: '`*`: give the first instructions, only if there are none yet.',
  })
  @ApiBody({ schema: schemaRef('DocumentaryInstructionContent') })
  @ApiCreatedResponse({
    description: 'The first instructions were given. `Location` points at them.',
    schema: schemaRef('DocumentaryInstruction'),
    headers: ETAG_HEADER,
  })
  @ApiOkResponse({
    description: 'A new revision was written.',
    schema: schemaRef('DocumentaryInstruction'),
    headers: ETAG_HEADER,
  })
  @ApiForbiddenResponse({
    description:
      'Your role does not allow giving instructions, your organization is the seller under ' +
      'this contract, or the request was cross-site',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiNotFoundResponse({
    description:
      'No such contract on this voyage, or your organization is not a party to it (or does not ' +
      'participate in the voyage)',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiPreconditionFailedResponse({
    description:
      'The instructions changed since the version in If-Match, they do not exist yet, or ' +
      '(with If-None-Match: *) they already exist. Nothing was written.',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiResponse(PRECONDITION_REQUIRED)
  async put(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Param('contractId', contractIdPipe()) contractId: string,
    @Body(new ZodValidationPipe(DocumentaryInstructionContentSchema))
    body: DocumentaryInstructionContent,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DocumentaryInstruction> {
    const precondition = putPrecondition(ifMatch, ifNoneMatch);
    const result = await this.instructions.put(principal, voyageId, contractId, body, precondition);
    if (!result) {
      throw new NotFoundException('Contract was not found.');
    }
    if (result.created) {
      response.status(HttpStatus.CREATED);
      response.location(
        `/api/voyages/${voyageId}/contracts/${contractId}/documentary-instructions`,
      );
    }
    response.setHeader('ETag', instructionEntityTag(result.instruction.version));
    return result.instruction;
  }

  @Post(`${INSTRUCTION_PATH}/revisions/:revisionNumber/acknowledgement`)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Acknowledge receipt of one revision of the documentary instructions',
    description:
      "Operators of the contract's seller only. Records receipt of exactly this revision, not " +
      'commercial acceptance. Only the current revision, once. Conditional: `If-Match` must ' +
      'carry the entity tag of the version you read. Who acknowledged and when come from the ' +
      'session and the server; the body is empty or absent.',
  })
  @ApiParam({ name: 'contractId', schema: { type: 'string', format: 'uuid' } })
  @ApiParam({ name: 'revisionNumber', schema: { type: 'integer', minimum: 1 } })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'The entity tag of the version you read, e.g. `"3"`.',
  })
  @ApiBody({ schema: schemaRef('AcknowledgeRevisionRequest'), required: false })
  @ApiOkResponse({
    description: 'Acknowledged.',
    schema: schemaRef('DocumentaryInstruction'),
    headers: ETAG_HEADER,
  })
  @ApiForbiddenResponse({
    description:
      'Your role does not allow acknowledging instructions, your organization is the buyer ' +
      'under this contract, or the request was cross-site',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiNotFoundResponse({
    description: `${NOT_VISIBLE}, or no such revision`,
    schema: schemaRef('ProblemDetails'),
  })
  @ApiPreconditionFailedResponse({
    description: 'The instructions changed since the version in If-Match. Nothing was recorded.',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiConflictResponse({
    description: 'The revision has been superseded, or has already been acknowledged',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiResponse(PRECONDITION_REQUIRED)
  async acknowledge(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Param('contractId', contractIdPipe()) contractId: string,
    @Param('revisionNumber', new ZodValidationPipe(RevisionNumberParamSchema))
    revisionNumber: number,
    // Validated only so that a body trying to set the actor or time is refused, not ignored.
    @Body(new ZodValidationPipe(AcknowledgeRevisionRequestSchema.optional())) _body: unknown,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<DocumentaryInstruction> {
    const versions = versionsFromIfMatch(ifMatch);
    if (!versions) {
      throw new PreconditionRequiredException(
        'Send If-Match with the version you read before acknowledging.',
      );
    }
    const instruction = await this.instructions.acknowledge(
      principal,
      voyageId,
      contractId,
      revisionNumber,
      versions,
    );
    if (!instruction) {
      throw new NotFoundException(INSTRUCTIONS_NOT_FOUND);
    }
    response.setHeader('ETag', instructionEntityTag(instruction.version));
    return instruction;
  }
}
