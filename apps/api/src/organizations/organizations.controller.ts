import { Body, Controller, Get, Post } from '@nestjs/common';
import {
  createOrganizationSchema,
  type CreateOrganizationInput,
  type OrganizationDto,
} from '@tracemind/shared';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { OrganizationsService } from './organizations.service.js';

@Controller('v1/organizations')
export class OrganizationsController {
  constructor(private readonly organizations: OrganizationsService) {}

  @Get()
  list(@CurrentUser() user: AuthenticatedUser): Promise<OrganizationDto[]> {
    return this.organizations.listForUser(user.id);
  }

  @Post()
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(createOrganizationSchema)) body: CreateOrganizationInput,
  ): Promise<OrganizationDto> {
    return this.organizations.create(user.id, body);
  }
}
