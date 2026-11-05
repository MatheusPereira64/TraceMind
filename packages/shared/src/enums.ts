/**
 * Domain enumerations. These are the single source of truth for the values stored in
 * PostgreSQL enums (apps/api/src/database/schema.ts imports them) and accepted by the API.
 */

export const ORGANIZATION_ROLES = ['owner', 'admin', 'member', 'viewer'] as const;
export type OrganizationRole = (typeof ORGANIZATION_ROLES)[number];

/** Higher number = more privileges. Used for "at least role X" checks. */
export const ROLE_RANK: Readonly<Record<OrganizationRole, number>> = {
  viewer: 0,
  member: 1,
  admin: 2,
  owner: 3,
};

export function hasRoleAtLeast(actual: OrganizationRole, required: OrganizationRole): boolean {
  return ROLE_RANK[actual] >= ROLE_RANK[required];
}

export const ENVIRONMENTS = ['development', 'staging', 'production'] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

export const TRACE_STATUSES = ['running', 'success', 'error'] as const;
export type TraceStatus = (typeof TRACE_STATUSES)[number];

export const SPAN_KINDS = ['llm', 'tool', 'retrieval', 'chain', 'embedding', 'custom'] as const;
export type SpanKind = (typeof SPAN_KINDS)[number];

export const ERROR_TYPES = [
  'provider_error',
  'api_failure',
  'rate_limit',
  'timeout',
  'invalid_response',
  'tool_call_failed',
  'unknown',
] as const;
export type ErrorType = (typeof ERROR_TYPES)[number];

export const EVALUATION_KINDS = ['thumbs', 'numeric', 'categorical'] as const;
export type EvaluationKind = (typeof EVALUATION_KINDS)[number];

export const EVALUATION_SOURCES = ['human', 'api', 'llm_judge'] as const;
export type EvaluationSource = (typeof EVALUATION_SOURCES)[number];
