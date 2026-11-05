import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  Param,
  ParseUUIDPipe,
  Query,
} from '@nestjs/common';
import {
  analyticsQuerySchema,
  errorsQuerySchema,
  type AnalyticsQuery,
  type BreakdownRow,
  type CostsDto,
  type DimensionsDto,
  type ErrorsDto,
  type ErrorsQuery,
  type OverviewDto,
  type PerformanceDto,
  type PricingRowDto,
  type TimeseriesDto,
} from '@tracemind/shared';
import { asc } from 'drizzle-orm';
import type { AuthenticatedUser } from '../auth/auth.types.js';
import { CurrentUser } from '../auth/decorators.js';
import { ZodValidationPipe } from '../common/zod-validation.pipe.js';
import { DATABASE, type Database } from '../database/database.module.js';
import { modelPricing } from '../database/schema.js';
import { AccessService } from '../organizations/access.service.js';
import { OPEN_START } from '../pricing/registry.js';
import { AnalyticsService } from './analytics.service.js';

const uuid = new ParseUUIDPipe({ version: '4' });
const analyticsQuery = new ZodValidationPipe(analyticsQuerySchema);

/**
 * Read-only analytics for a project. Query: from, to (ISO-8601), environment, provider, model, tz.
 */
@Controller('v1')
export class AnalyticsController {
  constructor(
    private readonly analytics: AnalyticsService,
    private readonly access: AccessService,
    @Inject(DATABASE) private readonly db: Database,
  ) {}

  @Get('projects/:projectId/analytics/overview')
  async overview(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(analyticsQuery) query: AnalyticsQuery,
  ): Promise<OverviewDto> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.analytics.overview(projectId, query);
  }

  @Get('projects/:projectId/analytics/timeseries')
  async timeseries(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(analyticsQuery) query: AnalyticsQuery,
  ): Promise<TimeseriesDto> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.analytics.timeseries(projectId, query);
  }

  @Get('projects/:projectId/analytics/breakdown')
  async breakdown(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(analyticsQuery) query: AnalyticsQuery,
    @Query('by') by = 'model',
  ): Promise<BreakdownRow[]> {
    if (by !== 'model' && by !== 'provider')
      throw new BadRequestException('`by` must be model or provider');
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.analytics.breakdown(projectId, query, by);
  }

  @Get('projects/:projectId/analytics/costs')
  async costs(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(analyticsQuery) query: AnalyticsQuery,
  ): Promise<CostsDto> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.analytics.costs(projectId, query);
  }

  @Get('projects/:projectId/analytics/performance')
  async performance(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(analyticsQuery) query: AnalyticsQuery,
  ): Promise<PerformanceDto> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.analytics.performance(projectId, query);
  }

  @Get('projects/:projectId/analytics/errors')
  async errors(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
    @Query(new ZodValidationPipe(errorsQuerySchema)) query: ErrorsQuery,
  ): Promise<ErrorsDto> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.analytics.errors(projectId, query);
  }

  @Get('projects/:projectId/analytics/dimensions')
  async dimensions(
    @CurrentUser() user: AuthenticatedUser,
    @Param('projectId', uuid) projectId: string,
  ): Promise<DimensionsDto> {
    await this.access.requireProjectRole(user.id, projectId, 'viewer');
    return this.analytics.dimensions(projectId);
  }

  /** The model price registry used for cost estimates (global, read-only). */
  @Get('pricing')
  async pricing(): Promise<PricingRowDto[]> {
    const rows = await this.db
      .select()
      .from(modelPricing)
      .orderBy(
        asc(modelPricing.providerId),
        asc(modelPricing.model),
        asc(modelPricing.effectiveFrom),
      );
    return rows.map((row) => ({
      provider: row.providerId,
      model: row.model,
      inputPricePerMillion: row.inputPricePerMillion,
      outputPricePerMillion: row.outputPricePerMillion,
      cachedInputPricePerMillion: row.cachedInputPricePerMillion,
      effectiveFrom:
        row.effectiveFrom.getTime() === OPEN_START.getTime()
          ? null
          : row.effectiveFrom.toISOString(),
      effectiveTo: row.effectiveTo?.toISOString() ?? null,
      source: row.source,
    }));
  }
}
