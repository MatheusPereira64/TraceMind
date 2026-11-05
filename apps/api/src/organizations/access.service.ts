import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { hasRoleAtLeast, type OrganizationRole } from '@tracemind/shared';
import { and, eq } from 'drizzle-orm';
import { DATABASE, type Database } from '../database/database.module.js';
import { organizationMembers, projects, type Project } from '../database/schema.js';

/**
 * Central tenant-isolation checks. Every organization- or project-scoped dashboard endpoint goes
 * through here before touching data.
 *
 * Resources in organizations the user does not belong to answer 404 (not 403) so their existence
 * is not disclosed; insufficient role inside a known organization answers 403.
 */
@Injectable()
export class AccessService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async requireOrganizationRole(
    userId: string,
    organizationId: string,
    minimumRole: OrganizationRole,
  ): Promise<OrganizationRole> {
    const membership = await this.db.query.organizationMembers.findFirst({
      columns: { role: true },
      where: and(
        eq(organizationMembers.organizationId, organizationId),
        eq(organizationMembers.userId, userId),
      ),
    });
    if (!membership) throw new NotFoundException('Organization not found');
    if (!hasRoleAtLeast(membership.role, minimumRole)) {
      throw new ForbiddenException(`This action requires the "${minimumRole}" role`);
    }
    return membership.role;
  }

  async requireProjectRole(
    userId: string,
    projectId: string,
    minimumRole: OrganizationRole,
  ): Promise<{ project: Project; role: OrganizationRole }> {
    const [row] = await this.db
      .select({ project: projects, role: organizationMembers.role })
      .from(projects)
      .innerJoin(
        organizationMembers,
        and(
          eq(organizationMembers.organizationId, projects.organizationId),
          eq(organizationMembers.userId, userId),
        ),
      )
      .where(eq(projects.id, projectId))
      .limit(1);

    if (!row) throw new NotFoundException('Project not found');
    if (!hasRoleAtLeast(row.role, minimumRole)) {
      throw new ForbiddenException(`This action requires the "${minimumRole}" role`);
    }
    return row;
  }
}
