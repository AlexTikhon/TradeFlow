import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpStatus,
  Post,
  Req,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBody,
  ApiForbiddenResponse,
  ApiNoContentResponse,
  ApiOkResponse,
  ApiOperation,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import { type CurrentUser, type SignInRequest, SignInRequestSchema } from '@tradeflow/contracts';
import type { Request, Response } from 'express';
import { schemaRef } from '../../common/http/openapi.js';
import { ZodValidationPipe } from '../../common/http/zod-validation.pipe.js';
import { ApiSessionAuth, CurrentPrincipal, Public } from './auth.decorators.js';
import { AuthService } from './auth.service.js';
import type { Principal } from './principal.js';
import { SessionCookie } from './session-cookie.js';

const problem = schemaRef('ProblemDetails');

@ApiTags('auth')
@Controller('auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly cookie: SessionCookie,
  ) {}

  @Public()
  @Post('sign-in')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Sign in with email and password',
    description: 'On success, sets the HttpOnly session cookie and returns the signed-in user.',
  })
  @ApiBody({ schema: schemaRef('SignInRequest') })
  @ApiOkResponse({ schema: schemaRef('CurrentUser') })
  @ApiBadRequestResponse({ description: 'Invalid request', schema: problem })
  @ApiUnauthorizedResponse({ description: 'Email or password is incorrect', schema: problem })
  @ApiForbiddenResponse({ description: 'Cross-site request', schema: problem })
  async signIn(
    @Body(new ZodValidationPipe(SignInRequestSchema)) body: SignInRequest,
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<CurrentUser> {
    const result = await this.auth.signIn(body, this.cookie.read(request));
    if (!result) {
      // One message for every failure, so the response does not reveal which emails exist.
      throw new UnauthorizedException('Email or password is incorrect.');
    }
    this.cookie.set(response, result.token, result.expiresAt);
    return result.currentUser;
  }

  @Get('me')
  @ApiSessionAuth()
  @ApiOperation({ summary: 'The signed-in user and their organization' })
  @ApiOkResponse({ schema: schemaRef('CurrentUser') })
  async me(@CurrentPrincipal() principal: Principal): Promise<CurrentUser> {
    const currentUser = await this.auth.getCurrentUser(principal.userId);
    if (!currentUser) {
      throw new UnauthorizedException('Authentication is required.');
    }
    return currentUser;
  }

  /** Public so that signing out always succeeds and clears the cookie, even for a dead session. */
  @Public()
  @Post('sign-out')
  @HttpCode(HttpStatus.NO_CONTENT)
  @ApiOperation({ summary: 'Sign out: revoke the current session and clear its cookie' })
  @ApiNoContentResponse({ description: 'Signed out (also when there was no session)' })
  @ApiForbiddenResponse({ description: 'Cross-site request', schema: problem })
  async signOut(
    @Req() request: Request,
    @Res({ passthrough: true }) response: Response,
  ): Promise<void> {
    const token = this.cookie.read(request);
    if (token !== undefined) {
      await this.auth.signOut(token);
    }
    this.cookie.clear(response);
  }
}
