import {
  Inject,
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { DATABASE, type Database } from '../database/database.module.js';
import { users } from '../database/schema.js';
import { IS_PUBLIC, USES_API_KEY } from './decorators.js';
import { SESSION_COOKIE, type SessionTokenPayload, type TraceMindRequest } from './auth.types.js';

/**
 * Global guard: every route requires a dashboard session unless marked @Public() or
 * @ApiKeyAuth(). Accepts `Authorization: Bearer <jwt>` or the httpOnly session cookie.
 */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly jwt: JwtService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const targets = [context.getHandler(), context.getClass()];
    if (
      this.reflector.getAllAndOverride<boolean>(IS_PUBLIC, targets) ||
      this.reflector.getAllAndOverride<boolean>(USES_API_KEY, targets)
    ) {
      return true;
    }

    const request = context.switchToHttp().getRequest<TraceMindRequest>();
    const token = this.extractToken(request);
    if (!token) throw new UnauthorizedException('Authentication required');

    let payload: SessionTokenPayload;
    try {
      payload = await this.jwt.verifyAsync<SessionTokenPayload>(token);
    } catch {
      throw new UnauthorizedException('Invalid or expired session');
    }

    // Re-read the user so deleted accounts lose access immediately.
    const user = await this.db.query.users.findFirst({
      columns: { id: true, email: true, name: true },
      where: eq(users.id, payload.sub),
    });
    if (!user) throw new UnauthorizedException('Invalid or expired session');

    request.user = user;
    return true;
  }

  private extractToken(request: TraceMindRequest): string | undefined {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) {
      const token = header.slice('Bearer '.length).trim();
      // API keys are not session tokens; reject them here with a clear message.
      if (token.startsWith('tm_'))
        throw new UnauthorizedException('API keys cannot access dashboard endpoints');
      return token || undefined;
    }
    const cookies = request.cookies as Record<string, string | undefined> | undefined;
    return cookies?.[SESSION_COOKIE];
  }
}
