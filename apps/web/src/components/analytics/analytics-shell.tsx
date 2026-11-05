'use client';

import type { DimensionsDto, ENVIRONMENTS, ProjectDto } from '@tracemind/shared';
import { BarChart3, FolderKanban } from 'lucide-react';
import Link from 'next/link';
import { useEffect, type ReactNode } from 'react';
import {
  useAnalyticsFilters,
  useAnalyticsQueryString,
  useDimensions,
  type AnalyticsFilters,
} from '@/hooks/analytics';
import { useProjects } from '@/hooks/queries';
import { RANGE_PRESETS } from '@/lib/time-range';
import { cn } from '@/lib/utils';
import { PageHeader } from '../app-shell';
import { useOrganization } from '../organization-context';
import { buttonVariants } from '../ui/button';
import { Badge, Card } from '../ui/card';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';

export interface AnalyticsContext {
  project: ProjectDto;
  filters: AnalyticsFilters;
  query: string;
  dimensions: DimensionsDto;
}

const selectClass =
  'h-8 rounded-md border border-border bg-surface px-2 text-sm text-foreground hover:border-border-strong focus:border-primary focus:outline-none';

function FilterBar({
  projects,
  filters,
  dimensions,
  update,
}: {
  projects: ProjectDto[];
  filters: AnalyticsFilters;
  dimensions: DimensionsDto;
  update: (changes: Record<string, string | undefined>) => void;
}) {
  const models = dimensions.models.filter(
    (entry) => !filters.provider || entry.provider === filters.provider,
  );
  return (
    <div className="mb-6 flex flex-wrap items-center gap-2" role="group" aria-label="Filters">
      <label className="sr-only" htmlFor="filter-project">
        Project
      </label>
      <select
        id="filter-project"
        className={cn(selectClass, 'font-medium')}
        value={filters.projectId}
        onChange={(event) =>
          update({
            project: event.target.value,
            provider: undefined,
            model: undefined,
            env: undefined,
          })
        }
      >
        {projects.map((project) => (
          <option key={project.id} value={project.id}>
            {project.name}
          </option>
        ))}
      </select>

      <div
        className="flex rounded-md border border-border p-0.5"
        role="radiogroup"
        aria-label="Time range"
      >
        {RANGE_PRESETS.map((preset) => (
          <button
            key={preset.id}
            type="button"
            role="radio"
            aria-checked={filters.range === preset.id}
            onClick={() => update({ range: preset.id, fromDate: undefined, toDate: undefined })}
            className={cn(
              'h-7 rounded px-2.5 text-xs font-medium transition-colors',
              filters.range === preset.id
                ? 'bg-surface-raised text-foreground'
                : 'text-muted hover:text-foreground',
            )}
          >
            {preset.label}
          </button>
        ))}
        <button
          type="button"
          role="radio"
          aria-checked={filters.range === 'custom'}
          onClick={() => {
            const today = new Date();
            const start = new Date(today.getTime() - 13 * 86_400_000);
            const day = (date: Date) => date.toLocaleDateString('en-CA');
            update({
              range: 'custom',
              fromDate: filters.fromDate ?? day(start),
              toDate: filters.toDate ?? day(today),
            });
          }}
          className={cn(
            'h-7 rounded px-2.5 text-xs font-medium transition-colors',
            filters.range === 'custom'
              ? 'bg-surface-raised text-foreground'
              : 'text-muted hover:text-foreground',
          )}
        >
          Custom
        </button>
      </div>

      {filters.range === 'custom' ? (
        <div className="flex items-center gap-1.5 text-xs text-muted">
          <input
            type="date"
            aria-label="From date"
            className={selectClass}
            value={filters.fromDate ?? ''}
            max={filters.toDate}
            onChange={(event) => update({ fromDate: event.target.value })}
          />
          –
          <input
            type="date"
            aria-label="To date"
            className={selectClass}
            value={filters.toDate ?? ''}
            min={filters.fromDate}
            onChange={(event) => update({ toDate: event.target.value })}
          />
        </div>
      ) : null}

      <select
        aria-label="Environment"
        className={selectClass}
        value={filters.environment ?? ''}
        onChange={(event) => update({ env: event.target.value })}
      >
        <option value="">All environments</option>
        {dimensions.environments.map((environment: (typeof ENVIRONMENTS)[number]) => (
          <option key={environment} value={environment}>
            {environment}
          </option>
        ))}
      </select>
      <select
        aria-label="Provider"
        className={selectClass}
        value={filters.provider ?? ''}
        onChange={(event) => update({ provider: event.target.value, model: undefined })}
      >
        <option value="">All providers</option>
        {dimensions.providers.map((provider) => (
          <option key={provider} value={provider}>
            {provider}
          </option>
        ))}
      </select>
      <select
        aria-label="Model"
        className={selectClass}
        value={filters.model ?? ''}
        onChange={(event) => update({ model: event.target.value })}
      >
        <option value="">All models</option>
        {models.map((entry) => (
          <option key={`${entry.provider}/${entry.model}`} value={entry.model}>
            {entry.model}
          </option>
        ))}
      </select>
    </div>
  );
}

/**
 * Shared frame for analytics pages: resolves the project, owns the filter bar (state in the URL)
 * and handles the no-project / no-telemetry cases once for every page.
 */
export function AnalyticsShell({
  title,
  description,
  onboarding,
  children,
}: {
  title: string;
  description: string;
  /** Replaces the default empty states (no project / no telemetry), e.g. with a setup checklist. */
  onboarding?: ReactNode;
  children: (context: AnalyticsContext) => ReactNode;
}) {
  const { current } = useOrganization();
  const projects = useProjects(current.id);
  const firstProjectId = projects.data?.[0]?.id;
  const { filters, update } = useAnalyticsFilters(firstProjectId);
  const project = projects.data?.find((candidate) => candidate.id === filters.projectId);
  const query = useAnalyticsQueryString(filters);
  const dimensions = useDimensions(project?.id);

  // A project id from another organization (e.g. after switching) falls back to the default.
  useEffect(() => {
    if (projects.data && filters.projectId && !project && firstProjectId)
      update({ project: undefined });
  }, [projects.data, filters.projectId, project, firstProjectId, update]);

  const header = (
    <PageHeader
      title={title}
      description={description}
      actions={project?.isDemo ? <Badge tone="warning">simulated data</Badge> : undefined}
    />
  );

  if (projects.isPending) return <LoadingState />;
  if (projects.isError)
    return <ErrorState error={projects.error} onRetry={() => projects.refetch()} />;
  if (projects.data.length === 0) {
    return (
      <>
        {header}
        {onboarding ?? (
          <Card>
            <EmptyState
              icon={FolderKanban}
              title="No projects yet"
              description="Create a project and send telemetry to see analytics here."
              action={
                <Link href="/projects" className={buttonVariants({ size: 'sm' })}>
                  Go to projects
                </Link>
              }
            />
          </Card>
        )}
      </>
    );
  }
  if (!project || dimensions.isPending) return <LoadingState />;
  if (dimensions.isError)
    return <ErrorState error={dimensions.error} onRetry={() => dimensions.refetch()} />;

  return (
    <>
      {header}
      <FilterBar
        projects={projects.data}
        filters={filters}
        dimensions={dimensions.data}
        update={update}
      />
      {dimensions.data.firstSeenAt === null ? (
        (onboarding ?? (
          <Card>
            <EmptyState
              icon={BarChart3}
              title="No telemetry yet"
              description="Send your first trace with the SDK or OpenTelemetry; charts appear here within seconds."
              action={
                <Link href={`/projects/${project.id}`} className={buttonVariants({ size: 'sm' })}>
                  View setup
                </Link>
              }
            />
          </Card>
        ))
      ) : query ? (
        children({ project, filters, query, dimensions: dimensions.data })
      ) : (
        <Card>
          <p className="px-5 py-8 text-center text-sm text-muted">Choose a valid date range.</p>
        </Card>
      )}
    </>
  );
}
