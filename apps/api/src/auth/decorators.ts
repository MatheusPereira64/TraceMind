import {
  createParamDecorator,
  SetMetadata,
  UnauthorizedException,
  type ExecutionContext,
} from '@nestjs/common';
import type { ApiKeyPrincipal, AuthenticatedUser, TraceMindRequest } from './auth.types.js';

export const IS_PUBLIC = 'tracemind:isPublic';
export const USES_API_KEY = 'tracemind:usesApiKey';
export const AUTH_RATE_LIMITED = 'tracemind:authRateLimited';
export const INGEST_RATE_LIMITED = 'tracemind:ingestRateLimited';

/** Skips dashboard session authentication (e.g. login, health). */
export const Public = () => SetMetadata(IS_PUBLIC, true);

/** Marks a route as authenticated by project API key instead of a dashboard session. */
export const ApiKeyAuth = () => SetMetadata(USES_API_KEY, true);

/**
 * Applies the stricter credential-endpoint rate limit (AUTH_RATE_LIMIT_PER_MINUTE) on top of the
 * global one, to slow down credential stuffing and password guessing.
 */
export const AuthRateLimit = () => SetMetadata(AUTH_RATE_LIMITED, true);

/** Applies the per-API-key ingestion limit (INGEST_RATE_LIMIT_PER_MINUTE). */
export const IngestRateLimit = () => SetMetadata(INGEST_RATE_LIMITED, true);

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext): AuthenticatedUser => {
    const user = context.switchToHttp().getRequest<TraceMindRequest>().user;
    if (!user) throw new UnauthorizedException();
    return user;
  },
);

export const CurrentApiKey = createParamDecorator(
  (_: unknown, context: ExecutionContext): ApiKeyPrincipal => {
    const principal = context.switchToHttp().getRequest<TraceMindRequest>().apiKey;
    if (!principal) throw new UnauthorizedException();
    return principal;
  },
);
