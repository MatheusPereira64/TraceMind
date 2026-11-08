import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  Param,
  ParseUUIDPipe,
  Post,
  Put,
  Query,
} from '@nestjs/common';
import {
  createEvaluationSchema,
  criterionInputSchema,
  evaluationsQuerySchema,
  type CreateEvaluationInput,
  type CriterionDto,
  type CriterionInput,
  type EvaluationDto,
  type EvaluationSummaryDto,
  type EvaluationsPage,
  type EvaluationsQuery,
} from '@tracemind/shared';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { AccessService } from '../organizations/access.service.js';
import { EvaluationsService } from './evaluations.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const evaluationsQuery = new ZodValidationPipe(evaluationsQuerySchema);
const criterionBody = new ZodValidationPipe(criterionInputSchema);

/**
 * Quality evaluations. Viewers read; members score traces; admins manage criteria definitions.
 */
@Controller('v1/projects/:projectId')
export class EvaluationsController {
  constructor(
    private readonly evaluations: EvaluationsService,
    private readonly access: AccessService,
  ) {}

  @Get('evaluation-criteria')
  async criteria(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
  ): Promise<CriterionDto[]> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.evaluations.criteria(projectId);
  }

  @Post('evaluation-criteria')
  async createCriterion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Body(criterionBody) body: CriterionInput,
  ): Promise<CriterionDto> {
    await this.access.requireProjectRole(user.id, projectId, 'admin');
    return this.evaluations.createCriterion(projectId, body);
  }

  @Put('evaluation-criteria/:criterionId')
  async updateCriterion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Param('criterionId', uuid) criterionId: string,
    @Body(criterionBody) body: CriterionInput,
  ): Promise<CriterionDto> {
    await this.access.requireProjectRole(user.id, projectId, 'admin');
    return this.evaluations.updateCriterion(projectId, criterionId, body);
  }

  @Delete('evaluation-criteria/:criterionId')
  @HttpCode(204)
  async deleteCriterion(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Param('criterionId', uuid) criterionId: string,
  ): Promise<void> {
    await this.access.requireProjectRole(user.id, projectId, 'admin');
    await this.evaluations.deleteCriterion(projectId, criterionId);
  }

  @Post('traces/:traceId/evaluations')
  async create(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Param('traceId') traceId: string,
    @Body(new ZodValidationPipe(createEvaluationSchema)) body: CreateEvaluationInput,
  ): Promise<EvaluationDto> {
    await this.access.requireProjectRole(user.id, projectId, 'member');
    return this.evaluations.record(projectId, traceId, {
      ...body,
      source: 'human',
      userId: user.id,
    });
  }

  @Delete('evaluations/:evaluationId')
  @HttpCode(204)
  async remove(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Param('evaluationId', uuid) evaluationId: string,
  ): Promise<void> {
    const { role } = await this.access.requireProjectRole(user.id, projectId, 'member');
    await this.evaluations.remove(projectId, evaluationId, { id: user.id, role });
  }

  @Get('evaluations')
  async list(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(evaluationsQuery) query: EvaluationsQuery,
  ): Promise<EvaluationsPage> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.evaluations.list(projectId, query);
  }

  @Get('evaluations/summary')
  async summary(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(evaluationsQuery) query: EvaluationsQuery,
  ): Promise<EvaluationSummaryDto> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.evaluations.summary(projectId, query);
  }
}
