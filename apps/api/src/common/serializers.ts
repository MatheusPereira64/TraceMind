import type { ApiKeyDto, OrganizationDto, ProjectDto, UserDto } from '@tracemind/shared';
import type {
  ApiKey,
  Organization,
  OrganizationMember,
  Project,
  User,
} from '../database/schema.js';

const iso = (date: Date | null): string | null => (date ? date.toISOString() : null);

export function toUserDto(user: Pick<User, 'id' | 'email' | 'name' | 'createdAt'>): UserDto {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    createdAt: user.createdAt.toISOString(),
  };
}

export function toOrganizationDto(
  organization: Organization,
  role: OrganizationMember['role'],
): OrganizationDto {
  return {
    id: organization.id,
    name: organization.name,
    slug: organization.slug,
    role,
    createdAt: organization.createdAt.toISOString(),
  };
}

export function toProjectDto(project: Project): ProjectDto {
  return {
    id: project.id,
    organizationId: project.organizationId,
    name: project.name,
    slug: project.slug,
    description: project.description,
    retentionDays: project.retentionDays,
    isDemo: project.isDemo,
    createdAt: project.createdAt.toISOString(),
    archivedAt: iso(project.archivedAt),
  };
}

export function toApiKeyDto(key: ApiKey): ApiKeyDto {
  return {
    id: key.id,
    projectId: key.projectId,
    name: key.name,
    prefix: key.prefix,
    environment: key.environment,
    createdAt: key.createdAt.toISOString(),
    lastUsedAt: iso(key.lastUsedAt),
    expiresAt: iso(key.expiresAt),
    revokedAt: iso(key.revokedAt),
  };
}
