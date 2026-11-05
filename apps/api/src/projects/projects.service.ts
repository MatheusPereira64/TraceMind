import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type {
  CreateProjectInput,
  IngestionStatusDto,
  ProjectDto,
  UpdateProjectInput,
} from '@tracemind/shared';
import { and, asc, count, desc, eq, isNull, max } from 'drizzle-orm';
import { toProjectDto } from '../common/serializers.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { ingestionFailures, projects, spans, traces } from '../database/schema.js';
import { AccessService } from '../organizations/access.service.js';
import { baseSlug, withSuffix } from '../organizations/slug.js';

const MAX_SLUG_ATTEMPTS = 5;

@Injectable()
export class ProjectsService {
  constructor(
    @Inject(DATABASE) private readonly db: Database,
    private readonly access: AccessService,
  ) {}

  async list(
    userId: string,
    organizationId: string,
    includeArchived: boolean,
  ): Promise<ProjectDto[]> {
    await this.access.requireOrganizationRole(userId, organizationId, 'viewer');
    const rows = await this.db
      .select()
      .from(projects)
      .where(
        and(
          eq(projects.organizationId, organizationId),
          includeArchived ? undefined : isNull(projects.archivedAt),
        ),
      )
      .orderBy(asc(projects.createdAt));
    return rows.map(toProjectDto);
  }

  async get(userId: string, projectId: string): Promise<ProjectDto> {
    const { project } = await this.access.requireProjectRole(userId, projectId, 'viewer');
    return toProjectDto(project);
  }

  async create(
    userId: string,
    organizationId: string,
    input: CreateProjectInput,
  ): Promise<ProjectDto> {
    await this.access.requireOrganizationRole(userId, organizationId, 'admin');

    const explicitSlug = input.slug;
    let slug = explicitSlug ?? baseSlug(input.name, 'project');

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const [project] = await this.db
        .insert(projects)
        .values({
          organizationId,
          name: input.name,
          slug,
          description: input.description ?? null,
          ...(input.retentionDays === undefined ? {} : { retentionDays: input.retentionDays }),
        })
        .onConflictDoNothing({ target: [projects.organizationId, projects.slug] })
        .returning();

      if (project) return toProjectDto(project);
      if (explicitSlug)
        throw new ConflictException(`Slug "${explicitSlug}" is already used in this organization`);
      slug = withSuffix(baseSlug(input.name, 'project'));
    }
    throw new ConflictException('Could not allocate a unique slug, please provide one');
  }

  async update(userId: string, projectId: string, input: UpdateProjectInput): Promise<ProjectDto> {
    await this.access.requireProjectRole(userId, projectId, 'admin');
    const [project] = await this.db
      .update(projects)
      .set(input)
      .where(eq(projects.id, projectId))
      .returning();
    // The row existed in requireProjectRole; a concurrent hard delete is the only way to miss it.
    if (!project) throw new ConflictException('Project was removed concurrently');
    return toProjectDto(project);
  }

  /** Soft delete: telemetry stays queryable for audits until the retention job removes it. */
  async archive(userId: string, projectId: string): Promise<ProjectDto> {
    const { project: current } = await this.access.requireProjectRole(userId, projectId, 'admin');
    if (current.archivedAt) return toProjectDto(current);
    const [project] = await this.db
      .update(projects)
      .set({ archivedAt: new Date() })
      .where(eq(projects.id, projectId))
      .returning();
    if (!project) throw new ConflictException('Project was removed concurrently');
    return toProjectDto(project);
  }

  /** Quick health view of a project's telemetry pipeline (used by onboarding and settings). */
  async ingestionStatus(userId: string, projectId: string): Promise<IngestionStatusDto> {
    await this.access.requireProjectRole(userId, projectId, 'viewer');
    const [traceStats, spanStats, failures] = await Promise.all([
      this.db
        .select({ total: count(), last: max(traces.createdAt) })
        .from(traces)
        .where(eq(traces.projectId, projectId)),
      this.db.select({ total: count() }).from(spans).where(eq(spans.projectId, projectId)),
      this.db
        .select({
          id: ingestionFailures.id,
          reason: ingestionFailures.reason,
          createdAt: ingestionFailures.createdAt,
        })
        .from(ingestionFailures)
        .where(eq(ingestionFailures.projectId, projectId))
        .orderBy(desc(ingestionFailures.createdAt))
        .limit(10),
    ]);
    const last = traceStats[0]?.last;
    return {
      traceCount: traceStats[0]?.total ?? 0,
      spanCount: spanStats[0]?.total ?? 0,
      lastReceivedAt: last ? new Date(last).toISOString() : null,
      recentFailures: failures.map((failure) => ({
        id: failure.id,
        reason: failure.reason,
        createdAt: failure.createdAt.toISOString(),
      })),
    };
  }
}
