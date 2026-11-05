import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import type { TraceMindRequest } from '../auth/auth.types.js';
import { ApiKeysService } from './api-keys.service.js';

/**
 * Authenticates telemetry clients. Accepts `Authorization: Bearer tm_...` or `X-TraceMind-Key`.
 * Use together with @ApiKeyAuth() so the global session guard skips the route.
 */
@Injectable()
export class ApiKeyGuard implements CanActivate {
  constructor(private readonly apiKeys: ApiKeysService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<TraceMindRequest>();
    const presented = this.extract(request);
    if (!presented) throw new UnauthorizedException('Missing API key');

    const principal = await this.apiKeys.authenticate(presented);
    if (!principal) throw new UnauthorizedException('Invalid, revoked or expired API key');

    request.apiKey = principal;
    return true;
  }

  private extract(request: TraceMindRequest): string | undefined {
    const header = request.headers.authorization;
    if (header?.startsWith('Bearer ')) return header.slice('Bearer '.length).trim() || undefined;
    const custom = request.headers['x-tracemind-key'];
    return typeof custom === 'string' && custom.length > 0 ? custom.trim() : undefined;
  }
}
