import type { Environment } from '@tracemind/shared';
import type { Request } from 'express';

export interface AuthenticatedUser {
  id: string;
  email: string;
  name: string;
}

/** Identity of a telemetry client authenticated by project API key. */
export interface ApiKeyPrincipal {
  keyId: string;
  projectId: string;
  organizationId: string;
  environment: Environment;
}

export interface TraceMindRequest extends Request {
  user?: AuthenticatedUser;
  apiKey?: ApiKeyPrincipal;
}

export interface SessionTokenPayload {
  sub: string;
}

export const SESSION_COOKIE = 'tm_session';
