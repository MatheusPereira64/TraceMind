import { Body, Controller, Get, HttpCode, Inject, Post, Res } from '@nestjs/common';
import {
  loginSchema,
  registerSchema,
  type LoginInput,
  type MeDto,
  type RegisterInput,
  type SessionDto,
} from '@tracemind/shared';
import type { CookieOptions, Response } from 'express';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ENV, type Env } from '../config/env.js';
import { AuthService } from './auth.service.js';
import { SESSION_COOKIE, type AuthenticatedUser } from './auth.types.js';
import { AuthRateLimit, CurrentUser, Public } from './decorators.js';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    @Inject(ENV) private readonly env: Env,
  ) {}

  @Public()
  @AuthRateLimit()
  @Post('register')
  async register(
    @Body(new ZodValidationPipe(registerSchema)) body: RegisterInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const session = await this.auth.register(body);
    this.setSessionCookie(response, session.accessToken);
    return session;
  }

  @Public()
  @AuthRateLimit()
  @Post('login')
  @HttpCode(200)
  async login(
    @Body(new ZodValidationPipe(loginSchema)) body: LoginInput,
    @Res({ passthrough: true }) response: Response,
  ): Promise<SessionDto> {
    const session = await this.auth.login(body);
    this.setSessionCookie(response, session.accessToken);
    return session;
  }

  @Public()
  @Post('logout')
  @HttpCode(204)
  logout(@Res({ passthrough: true }) response: Response): void {
    response.clearCookie(SESSION_COOKIE, this.cookieOptions());
  }

  @Get('me')
  me(@CurrentUser() user: AuthenticatedUser): Promise<MeDto> {
    return this.auth.me(user.id);
  }

  private setSessionCookie(response: Response, token: string): void {
    response.cookie(SESSION_COOKIE, token, {
      ...this.cookieOptions(),
      maxAge: this.env.JWT_TTL_SECONDS * 1000,
    });
  }

  private cookieOptions(): CookieOptions {
    return {
      httpOnly: true,
      sameSite: 'lax',
      secure: this.env.COOKIE_SECURE ?? this.env.NODE_ENV === 'production',
      path: '/',
    };
  }
}
