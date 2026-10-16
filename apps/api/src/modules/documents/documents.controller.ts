import {
  applyDecorators,
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Logger,
  NotFoundException,
  Param,
  Post,
  Req,
  Res,
  StreamableFile,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiConflictResponse,
  ApiConsumes,
  ApiCreatedResponse,
  ApiForbiddenResponse,
  ApiHeader,
  ApiNotFoundResponse,
  ApiOkResponse,
  ApiOperation,
  ApiParam,
  ApiPayloadTooLargeResponse,
  ApiPreconditionFailedResponse,
  ApiProduces,
  ApiResponse,
  ApiTags,
  ApiUnsupportedMediaTypeResponse,
} from '@nestjs/swagger';
import {
  type ContractDocument,
  ContractIdParamSchema,
  DOCUMENT_FILE_FIELD,
  DOCUMENT_MEDIA_TYPE,
  type DocumentListResponse,
  documentEntityTag,
  DocumentTypeParamSchema,
  DocumentVersionNumberParamSchema,
  MAX_DOCUMENT_BYTES,
  PROBLEM_CONTENT_TYPE,
  RevisionNumberParamSchema,
  type RequiredDocumentType,
  REQUIRED_DOCUMENT_TYPES,
  type ReviewDocumentVersionRequest,
  ReviewDocumentVersionRequestSchema,
  VoyageIdParamSchema,
} from '@tradeflow/contracts';
import type { Request, Response } from 'express';
import { attachmentDisposition } from '../../common/http/content-disposition.js';
import {
  checkFileRequest,
  receiveSingleFile,
  type SingleFileLimits,
} from '../../common/http/multipart-file.js';
import { schemaRef } from '../../common/http/openapi.js';
import {
  PreconditionRequiredException,
  versionsFromIfMatch,
  writePrecondition,
} from '../../common/http/preconditions.js';
import { toProblemDetails } from '../../common/http/problem-details.filter.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal } from '../auth/auth.decorators.js';
import type { Principal } from '../auth/principal.js';
import { DOCUMENT_TOO_LARGE, MAX_UPLOAD_REQUEST_BYTES } from './document-rules.js';
import { CONTRACT_NOT_FOUND, type DocumentTarget, DocumentsService } from './documents.service.js';

const voyageIdPipe = () => new ZodValidationPipe(VoyageIdParamSchema);
const contractIdPipe = () => new ZodValidationPipe(ContractIdParamSchema);
const revisionNumberPipe = () => new ZodValidationPipe(RevisionNumberParamSchema);
const documentTypePipe = () => new ZodValidationPipe(DocumentTypeParamSchema);
const versionNumberPipe = () => new ZodValidationPipe(DocumentVersionNumberParamSchema);

const ETAG_HEADER = {
  ETag: {
    description:
      'The document’s new version, e.g. `"4"`: it counts uploads and reviews. Send it back in ' +
      'If-Match with the next replacement or review.',
    schema: { type: 'string' },
  },
} as const;

const DOCUMENT_PATH =
  'contracts/:contractId/documentary-instructions/revisions/:revisionNumber/documents/:documentType';

const UPLOAD_LIMITS: SingleFileLimits = {
  field: DOCUMENT_FILE_FIELD,
  maxFileBytes: MAX_DOCUMENT_BYTES,
  maxRequestBytes: MAX_UPLOAD_REQUEST_BYTES,
  tooLarge: DOCUMENT_TOO_LARGE,
};

const contentPath = (target: DocumentTarget, versionNumber: number) =>
  `/api/voyages/${target.voyageId}/contracts/${target.contractId}/documentary-instructions/` +
  `revisions/${target.revisionNumber}/documents/${target.documentType}/versions/${versionNumber}/content`;

/** The path parameters that name one document. */
const ApiDocumentParams = () =>
  applyDecorators(
    ApiParam({ name: 'contractId', schema: { type: 'string', format: 'uuid' } }),
    ApiParam({ name: 'revisionNumber', schema: { type: 'integer', minimum: 1 } }),
    ApiParam({
      name: 'documentType',
      schema: { type: 'string', enum: [...REQUIRED_DOCUMENT_TYPES] },
    }),
  );

const NOT_VISIBLE =
  'No such contract on this voyage, or your organization is not a party to it (or does not ' +
  'participate in the voyage)';

@ApiTags('documents')
@ApiSessionAuth()
@ApiBadRequestResponse({ description: 'Invalid request', schema: schemaRef('ProblemDetails') })
@ApiParam({ name: 'voyageId', schema: { type: 'string', format: 'uuid' } })
@Controller('voyages/:voyageId')
export class DocumentsController {
  private readonly logger = new Logger(DocumentsController.name);

  constructor(private readonly documents: DocumentsService) {}

  @Get('documents')
  @ApiOperation({
    summary: 'List the documents under your contracts on a voyage',
    description:
      'Only documents under contracts your organization is the seller or the buyer of, viewers ' +
      'included: in contract order, newest instruction revision first, each with its version ' +
      'and every file version with the decision made on it. Documents of superseded revisions ' +
      'are included. Other participants get an empty list.',
  })
  @ApiOkResponse({ schema: schemaRef('DocumentListResponse') })
  @ApiNotFoundResponse({
    description: 'No such voyage, or your organization does not participate in it',
    schema: schemaRef('ProblemDetails'),
  })
  async list(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
  ): Promise<DocumentListResponse> {
    const documents = await this.documents.list(principal, voyageId);
    if (!documents) {
      throw new NotFoundException('Voyage was not found.');
    }
    return documents;
  }

  @Post(`${DOCUMENT_PATH}/versions`)
  @ApiOperation({
    summary: 'Upload a version of a document required by the current instructions',
    description:
      "Operators of the contract's seller only, for a document type the current revision of the " +
      'documentary instructions requires. The body is `multipart/form-data` with exactly one ' +
      `part, the PDF in \`${DOCUMENT_FILE_FIELD}\`: at most 10 MiB, and it must start like a PDF ` +
      'file whatever its name or declared type. Conditional: `If-None-Match: *` for the first ' +
      'version, `If-Match` with the document’s version (which counts uploads and reviews) to ' +
      'replace it. Every version is kept, with the decision made on it; the new one starts ' +
      'pending review. The uploader and the time come from the session and the server; the ' +
      "storage location is the server's and never derived from the file name.",
  })
  @ApiDocumentParams()
  @ApiHeader({
    name: 'If-Match',
    required: false,
    description: 'The entity tag of the document version this upload is based on, e.g. `"3"`.',
  })
  @ApiHeader({
    name: 'If-None-Match',
    required: false,
    description: '`*`: upload the first version, only if there is none yet.',
  })
  @ApiConsumes('multipart/form-data')
  @ApiBody({
    schema: {
      type: 'object',
      required: [DOCUMENT_FILE_FIELD],
      additionalProperties: false,
      properties: {
        [DOCUMENT_FILE_FIELD]: {
          type: 'string',
          format: 'binary',
          description: `The PDF, sent with Content-Type ${DOCUMENT_MEDIA_TYPE}. At most 10 MiB.`,
        },
      },
    },
  })
  @ApiCreatedResponse({
    description:
      'The version was stored. `Location` points at its content; `ETag` is the document’s new ' +
      'version, for the next replacement or review.',
    schema: schemaRef('ContractDocument'),
    headers: {
      ...ETAG_HEADER,
      Location: { description: 'The new version’s content.', schema: { type: 'string' } },
    },
  })
  @ApiForbiddenResponse({
    description:
      'Your role does not allow uploading documents, your organization is the buyer under this ' +
      'contract, or the request was cross-site',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiNotFoundResponse({
    description: `${NOT_VISIBLE}, no such revision, or the revision does not require this document`,
    schema: schemaRef('ProblemDetails'),
  })
  @ApiConflictResponse({
    description:
      'The revision has been superseded: documents are presented against the current revision',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiPreconditionFailedResponse({
    description:
      'The document changed (a new file or a decision) since the version in If-Match, has no ' +
      'version yet, or (with If-None-Match: *) already has one. Nothing was stored.',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiPayloadTooLargeResponse({
    description: 'The file is larger than 10 MiB',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiUnsupportedMediaTypeResponse({
    description: 'The body is not multipart/form-data, or the file is not a PDF',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiResponse({
    status: HttpStatus.PRECONDITION_REQUIRED,
    description: 'The upload names neither If-Match nor If-None-Match: *',
    schema: schemaRef('ProblemDetails'),
  })
  async upload(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Param('contractId', contractIdPipe()) contractId: string,
    @Param('revisionNumber', revisionNumberPipe()) revisionNumber: number,
    @Param('documentType', documentTypePipe()) documentType: RequiredDocumentType,
    @Headers('if-match') ifMatch: string | undefined,
    @Headers('if-none-match') ifNoneMatch: string | undefined,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ContractDocument> {
    const precondition = writePrecondition(
      ifMatch,
      ifNoneMatch,
      'Send If-None-Match: * to upload the first version of this document, or If-Match with the ' +
        'version you are replacing.',
    );
    checkFileRequest(request, UPLOAD_LIMITS);
    const target = { voyageId, contractId, revisionNumber, documentType };
    const document = await this.documents.upload(principal, target, precondition, {
      receive: (consumer) => receiveSingleFile(request, UPLOAD_LIMITS, consumer),
    });
    if (!document) {
      throw new NotFoundException(CONTRACT_NOT_FOUND);
    }
    response.status(HttpStatus.CREATED);
    response.location(contentPath(target, document.currentVersion.number));
    response.setHeader('ETag', documentEntityTag(document.version));
    return document;
  }

  @Post(`${DOCUMENT_PATH}/versions/:versionNumber/review`)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Approve or reject one version of a document',
    description:
      "Operators of the contract's buyer only. Decides on exactly this file version, which must " +
      'be the latest one, under the current revision of the documentary instructions. A ' +
      'rejection needs a reason. Once per version and final: a decision is never changed or ' +
      'reopened; a replacement from the seller starts pending and is reviewed on its own. ' +
      'Conditional: `If-Match` must carry the document’s version as you read it. Who decided, ' +
      'for which organization and when come from the session and the server.',
  })
  @ApiDocumentParams()
  @ApiParam({ name: 'versionNumber', schema: { type: 'integer', minimum: 1 } })
  @ApiHeader({
    name: 'If-Match',
    required: true,
    description: 'The entity tag of the document version you read, e.g. `"3"`.',
  })
  @ApiBody({ schema: schemaRef('ReviewDocumentVersionRequest') })
  @ApiOkResponse({
    description: 'Decided.',
    schema: schemaRef('ContractDocument'),
    headers: ETAG_HEADER,
  })
  @ApiForbiddenResponse({
    description:
      'Your role does not allow reviewing documents, your organization is the seller under this ' +
      'contract, or the request was cross-site',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiNotFoundResponse({
    description: `${NOT_VISIBLE}, no such revision, document or version, or the revision does not require this document`,
    schema: schemaRef('ProblemDetails'),
  })
  @ApiConflictResponse({
    description:
      'The version has been replaced by a newer one, already has a decision, or its revision ' +
      'has been superseded',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiPreconditionFailedResponse({
    description:
      'The document changed (a new file or a decision) since the version in If-Match. Nothing ' +
      'was recorded.',
    schema: schemaRef('ProblemDetails'),
  })
  @ApiResponse({
    status: HttpStatus.PRECONDITION_REQUIRED,
    description:
      'The review does not name the document version it is based on (no If-Match, or `*`)',
    schema: schemaRef('ProblemDetails'),
  })
  async review(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Param('contractId', contractIdPipe()) contractId: string,
    @Param('revisionNumber', revisionNumberPipe()) revisionNumber: number,
    @Param('documentType', documentTypePipe()) documentType: RequiredDocumentType,
    @Param('versionNumber', versionNumberPipe()) versionNumber: number,
    @Body(new ZodValidationPipe(ReviewDocumentVersionRequestSchema))
    body: ReviewDocumentVersionRequest,
    @Headers('if-match') ifMatch: string | undefined,
    @Res({ passthrough: true }) response: Response,
  ): Promise<ContractDocument> {
    const expectedVersions = versionsFromIfMatch(ifMatch);
    if (!expectedVersions) {
      throw new PreconditionRequiredException(
        'Send If-Match with the version of the document you reviewed.',
      );
    }
    const document = await this.documents.review(
      principal,
      { voyageId, contractId, revisionNumber, documentType },
      versionNumber,
      body,
      expectedVersions,
    );
    if (!document) {
      throw new NotFoundException(CONTRACT_NOT_FOUND);
    }
    response.setHeader('ETag', documentEntityTag(document.version));
    return document;
  }

  @Get(`${DOCUMENT_PATH}/versions/:versionNumber/content`)
  @ApiOperation({
    summary: 'Download one version of a document',
    description:
      'The bytes exactly as uploaded, as an attachment (never displayed inline), named with the ' +
      'file name they were uploaded with. For users of the contract’s seller and buyer, viewers ' +
      'included. Bytes that no longer match their checksum are never served. Not conditional: ' +
      'a file version never changes, so it carries no entity tag.',
  })
  @ApiDocumentParams()
  @ApiParam({ name: 'versionNumber', schema: { type: 'integer', minimum: 1 } })
  @ApiProduces(DOCUMENT_MEDIA_TYPE)
  @ApiOkResponse({
    description: 'The PDF.',
    content: { [DOCUMENT_MEDIA_TYPE]: { schema: { type: 'string', format: 'binary' } } },
    headers: {
      'Content-Disposition': {
        description: '`attachment`, with the uploaded file name.',
        schema: { type: 'string' },
      },
      'Repr-Digest': {
        description: 'SHA-256 of the bytes (RFC 9530), e.g. `sha-256=:...:`.',
        schema: { type: 'string' },
      },
    },
  })
  @ApiNotFoundResponse({
    description: `${NOT_VISIBLE}, or no such document or version`,
    schema: schemaRef('ProblemDetails'),
  })
  async download(
    @CurrentPrincipal() principal: Principal,
    @Param('voyageId', voyageIdPipe()) voyageId: string,
    @Param('contractId', contractIdPipe()) contractId: string,
    @Param('revisionNumber', revisionNumberPipe()) revisionNumber: number,
    @Param('documentType', documentTypePipe()) documentType: RequiredDocumentType,
    @Param('versionNumber', versionNumberPipe()) versionNumber: number,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<StreamableFile> {
    const version = await this.documents.openVersion(
      principal,
      { voyageId, contractId, revisionNumber, documentType },
      versionNumber,
    );
    if (!version) {
      throw new NotFoundException('Document was not found.');
    }
    // A browser must neither guess another type nor run anything the file contains.
    response.setHeader('X-Content-Type-Options', 'nosniff');
    response.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
    response.setHeader('Repr-Digest', `sha-256=:${version.sha256.toString('base64')}:`);
    return new StreamableFile(version.content, {
      type: DOCUMENT_MEDIA_TYPE,
      disposition: attachmentDisposition(version.fileName),
      length: version.sizeBytes,
    })
      .setErrorLogger((error) => {
        this.logger.error(`${request.method} ${request.originalUrl} failed`, error.stack);
      })
      .setErrorHandler(() => {
        // Never Nest's default (a 400 carrying the error's message). Before the first byte, a
        // generic 500; after it, the connection is cut, so the client sees a short download
        // instead of a complete-looking file.
        if (response.headersSent) {
          response.destroy();
          return;
        }
        const problem = toProblemDetails(new Error('stream failed'), request.originalUrl);
        response.removeHeader('Content-Disposition');
        response.removeHeader('Content-Length');
        response.status(problem.status).type(PROBLEM_CONTENT_TYPE).json(problem);
      });
  }
}
