import type { Environment, OrganizationRole } from './enums.js';
import type { RedactionSettings } from './ingestion.js';

/**
 * Response contracts of the TraceMind REST API (v1). Dates are ISO-8601 strings on the wire.
 */

export interface UserDto {
  id: string;
  email: string;
  name: string;
  createdAt: string;
}

export interface OrganizationDto {
  id: string;
  name: string;
  slug: string;
  role: OrganizationRole;
  createdAt: string;
}

export interface ProjectDto {
  id: string;
  organizationId: string;
  name: string;
  slug: string;
  description: string | null;
  retentionDays: number;
  redaction: RedactionSettings;
  isDemo: boolean;
  createdAt: string;
  archivedAt: string | null;
}

export interface ApiKeyDto {
  id: string;
  projectId: string;
  name: string;
  /** Non-secret visible prefix, e.g. `tm_dev_3fA9kQ2m`. */
  prefix: string;
  environment: Environment;
  createdAt: string;
  lastUsedAt: string | null;
  expiresAt: string | null;
  revokedAt: string | null;
}

/** Returned exactly once, when the key is created. The plaintext key is never stored. */
export interface CreatedApiKeyDto extends ApiKeyDto {
  key: string;
}

export interface SessionDto {
  user: UserDto;
  organizations: OrganizationDto[];
  /** Also set as an httpOnly cookie; returned for non-browser clients. */
  accessToken: string;
  expiresAt: string;
}

export interface MeDto {
  user: UserDto;
  organizations: OrganizationDto[];
}

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

/** Shape of every non-2xx response body. */
export interface ApiErrorBody {
  statusCode: number;
  error: string;
  message: string;
  requestId?: string;
  /** Field-level validation issues, when applicable. */
  issues?: Array<{ path: string; message: string }>;
}
