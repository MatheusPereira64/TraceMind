import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { ApiKeyDto, CreateApiKeyInput, CreatedApiKeyDto } from '@tracemind/shared';
import { and, desc, eq, isNull, lt, or, sql } from 'drizzle-orm';
import type { ApiKeyPrincipal } from '../auth/auth.types.js';
import { toApiKeyDto } from '../common/serializers.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { apiKeys, projects } from '../database/schema.js';
import { AccessService } from '../organizations/access.service.js';
import { generateApiKey, hashApiKey, looksLikeApiKey } from './api-key.util.js';

/** Avoid a write per request: `last_used_at` is refreshed at most once per minute per key. */
const LAST_USED_RESOLUTION_MS = 60_000;

type ParsedCreateApiKey = Omit<CreateApiKeyInput, 'environment'> & {
  environment: NonNullable<CreateApiKeyInput['environment']>;
};

@Injectable()
export class ApiKeysService {
  private readonly logger = new Logger(ApiKeysService.name);

  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
  ) {}

  async list(userId: string, projectId: string): Promise<ApiKeyDto[]> {
    await this.access.requireProjectRole(userId, projectId, 'viewer');
    const rows = await this.db
      .select()
      .from(apiKeys)
      .where(eq(apiKeys.projectId, projectId))
      .orderBy(desc(apiKeys.createdAt));
    return rows.map(toApiKeyDto);
  }

  async create(
    userId: string,
    projectId: string,
    input: ParsedCreateApiKey,
  ): Promise<CreatedApiKeyDto> {
    const { project } = await this.access.requireProjectRole(userId, projectId, 'admin');
    if (project.archivedAt) throw new NotFoundException('Project not found');

    const generated = generateApiKey(input.environment);
    const [row] = await this.db
      .insert(apiKeys)
      .values({
        projectId,
        name: input.name,
        prefix: generated.prefix,
        keyHash: generated.hash,
        environment: input.environment,
        createdById: userId,
        expiresAt: input.expiresAt ? new Date(input.expiresAt) : null,
      })
      .returning();
    if (!row) throw new Error('API key insert returned no row');

    return { ...toApiKeyDto(row), key: generated.key };
  }

  async revoke(userId: string, projectId: string, keyId: string): Promise<ApiKeyDto> {
    await this.access.requireProjectRole(userId, projectId, 'admin');
    const [row] = await this.db
      .update(apiKeys)
      .set({ revokedAt: sql`COALESCE(${apiKeys.revokedAt}, now())` })
      .where(and(eq(apiKeys.id, keyId), eq(apiKeys.projectId, projectId)))
      .returning();
    if (!row) throw new NotFoundException('API key not found');
    return toApiKeyDto(row);
  }

  /**
   * Resolves a presented key into a principal, or null when it is malformed, unknown, revoked,
   * expired, or belongs to an archived project.
   */
  async authenticate(presentedKey: string): Promise<ApiKeyPrincipal | null> {
    if (!looksLikeApiKey(presentedKey)) return null;

    const [row] = await this.db
      .select({
        keyId: apiKeys.id,
        projectId: apiKeys.projectId,
        organizationId: projects.organizationId,
        environment: apiKeys.environment,
        expiresAt: apiKeys.expiresAt,
        revokedAt: apiKeys.revokedAt,
        lastUsedAt: apiKeys.lastUsedAt,
        projectArchivedAt: projects.archivedAt,
      })
      .from(apiKeys)
      .innerJoin(projects, eq(projects.id, apiKeys.projectId))
      .where(eq(apiKeys.keyHash, hashApiKey(presentedKey)))
      .limit(1);

    const now = Date.now();
    if (
      !row ||
      row.revokedAt ||
      row.projectArchivedAt ||
      (row.expiresAt && row.expiresAt.getTime() <= now)
    ) {
      return null;
    }

    if (!row.lastUsedAt || now - row.lastUsedAt.getTime() > LAST_USED_RESOLUTION_MS) {
      this.touch(row.keyId);
    }

    return {
      keyId: row.keyId,
      projectId: row.projectId,
      organizationId: row.organizationId,
      environment: row.environment,
    };
  }

  /** Fire-and-forget; a failed timestamp update must never fail an ingestion request. */
  private touch(keyId: string): void {
    const threshold = new Date(Date.now() - LAST_USED_RESOLUTION_MS);
    this.db
      .update(apiKeys)
      .set({ lastUsedAt: new Date() })
      .where(
        and(
          eq(apiKeys.id, keyId),
          or(isNull(apiKeys.lastUsedAt), lt(apiKeys.lastUsedAt, threshold)),
        ),
      )
      .catch((error: unknown) =>
        this.logger.warn({ err: error, keyId }, 'Failed to update last_used_at'),
      );
  }
}
