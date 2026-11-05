import { ConflictException, Inject, Injectable } from '@nestjs/common';
import type { CreateOrganizationInput, OrganizationDto } from '@tracemind/shared';
import { eq } from 'drizzle-orm';
import { toOrganizationDto } from '../common/serializers.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { organizationMembers, organizations, type Organization } from '../database/schema.js';
import { baseSlug, withSuffix } from './slug.js';

/** Either the root database handle or an open transaction. */
type Executor = Database | Parameters<Parameters<Database['transaction']>[0]>[0];

const MAX_SLUG_ATTEMPTS = 5;

@Injectable()
export class OrganizationsService {
  constructor(@Inject(DATABASE) private readonly db: Database) {}

  async listForUser(userId: string): Promise<OrganizationDto[]> {
    const rows = await this.db
      .select({ organization: organizations, role: organizationMembers.role })
      .from(organizationMembers)
      .innerJoin(organizations, eq(organizations.id, organizationMembers.organizationId))
      .where(eq(organizationMembers.userId, userId))
      .orderBy(organizations.createdAt);
    return rows.map((row) => toOrganizationDto(row.organization, row.role));
  }

  async create(userId: string, input: CreateOrganizationInput): Promise<OrganizationDto> {
    const organization = await this.db.transaction((tx) => this.createWithOwner(tx, userId, input));
    return toOrganizationDto(organization, 'owner');
  }

  /**
   * Creates an organization and makes `userId` its owner. When no slug is given, one is derived
   * from the name and suffixed on collision; an explicit slug that is taken is a conflict.
   */
  async createWithOwner(
    executor: Executor,
    userId: string,
    input: CreateOrganizationInput,
  ): Promise<Organization> {
    const explicitSlug = input.slug;
    let slug = explicitSlug ?? baseSlug(input.name, 'org');

    for (let attempt = 0; attempt < MAX_SLUG_ATTEMPTS; attempt += 1) {
      const [organization] = await executor
        .insert(organizations)
        .values({ name: input.name, slug })
        .onConflictDoNothing({ target: organizations.slug })
        .returning();

      if (organization) {
        await executor
          .insert(organizationMembers)
          .values({ organizationId: organization.id, userId, role: 'owner' });
        return organization;
      }
      if (explicitSlug) throw new ConflictException(`Slug "${explicitSlug}" is already taken`);
      slug = withSuffix(baseSlug(input.name, 'org'));
    }

    throw new ConflictException('Could not allocate a unique slug, please provide one');
  }
}
