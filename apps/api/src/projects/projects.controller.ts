import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import {
  createProjectSchema,
  updateProjectSchema,
  type CreateProjectInput,
  type ProjectDto,
  type UpdateProjectInput,
} from '@tracemind/shared';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { ProjectsService } from './projects.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });

@Controller('v1')
export class ProjectsController {
  constructor(private readonly projects: ProjectsService) {}

  @Get('organizations/:organizationId/projects')
  list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', uuid) organizationId: string,
    @Query('includeArchived') includeArchived?: string,
  ): Promise<ProjectDto[]> {
    return this.projects.list(user.id, organizationId, includeArchived === 'true');
  }

  @Post('organizations/:organizationId/projects')
  create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('organizationId', uuid) organizationId: string,
    @Body(new ZodValidationPipe(createProjectSchema)) body: CreateProjectInput,
  ): Promise<ProjectDto> {
    return this.projects.create(user.id, organizationId, body);
  }

  @Get('projects/:projectId')
  get(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
  ): Promise<ProjectDto> {
    return this.projects.get(user.id, projectId);
  }

  @Patch('projects/:projectId')
  update(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Body(new ZodValidationPipe(updateProjectSchema)) body: UpdateProjectInput,
  ): Promise<ProjectDto> {
    return this.projects.update(user.id, projectId, body);
  }

  @Delete('projects/:projectId')
  archive(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
  ): Promise<ProjectDto> {
    return this.projects.archive(user.id, projectId);
  }
}
