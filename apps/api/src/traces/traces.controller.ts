import { BadRequestException, Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import {
  analyticsQuerySchema,
  generationsQuerySchema,
  tracesQuerySchema,
  type AnalyticsQuery,
  type GenerationDetailDto,
  type GenerationsPage,
  type GenerationsQuery,
  type RepeatedPromptDto,
  type TraceDetailDto,
  type TracesPage,
  type TracesQuery,
} from '@tracemind/shared';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AccessService } from '../organizations/access.service.js';
import { TracesService } from './traces.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });

/** Trace Explorer and prompt history. Read access (viewer) is enough for every route. */
@Controller('v1/projects/:projectId')
export class TracesController {
  constructor(
    private readonly traces: TracesService,
    private readonly access: AccessService,
  ) {}

  @Get('traces')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(new ZodValidationPipe(tracesQuerySchema)) query: TracesQuery,
  ): Promise<TracesPage> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.traces.list(projectId, query);
  }

  @Get('traces/:traceId')
  async detail(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Param('traceId') traceId: string,
  ): Promise<TraceDetailDto> {
    if (traceId.length === 0 || traceId.length > 128)
      throw new BadRequestException('Invalid trace id');
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.traces.detail(projectId, traceId);
  }

  @Get('generations')
  async generations(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(new ZodValidationPipe(generationsQuerySchema)) query: GenerationsQuery,
  ): Promise<GenerationsPage> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.traces.generations(projectId, query);
  }

  @Get('generations/:uid')
  async generation(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Param('uid', new ParseUUIDPipe()) uid: string,
  ): Promise<GenerationDetailDto> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.traces.generation(projectId, uid);
  }

  @Get('prompts/repeated')
  async repeated(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(new ZodValidationPipe(analyticsQuerySchema)) query: AnalyticsQuery,
  ): Promise<RepeatedPromptDto[]> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.traces.repeatedPrompts(projectId, query);
  }
}
