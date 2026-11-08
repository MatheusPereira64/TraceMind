'use client';

import type { ProjectDto } from '@tracemind/shared';
import { FolderSearch } from 'lucide-react';
import { useSearchParams } from 'next/navigation';
import type { ReactNode } from 'react';
import { useProjects } from '@/hooks/queries';
import { useOrganization } from '../organization-context';
import { EmptyState, ErrorState, LoadingState } from '../ui/states';

/**
 * Resolves the project for pages that are not wrapped in the analytics filter bar (trace detail,
 * comparisons): `?project=` when present, otherwise the organization's first project.
 */
export function ProjectScope({ children }: { children: (project: ProjectDto) => ReactNode }) {
  const { current } = useOrganization();
  const projects = useProjects(current.id);
  const requested = useSearchParams().get('project');

  if (projects.isPending) return <LoadingState />;
  if (projects.isError)
    return <ErrorState error={projects.error} onRetry={() => projects.refetch()} />;
  const project = requested
    ? projects.data.find((candidate) => candidate.id === requested)
    : projects.data[0];
  if (!project)
    return (
      <EmptyState
        icon={FolderSearch}
        title="Project not found"
        description="It may belong to another organization. Switch organization or open it from the project list."
      />
    );
  return <>{children(project)}</>;
}

/** Link target for a trace, keeping the project in the URL. */
export const traceHref = (projectId: string, traceId: string, spanId?: string) =>
  `/traces/${encodeURIComponent(traceId)}?project=${projectId}${spanId ? `&span=${encodeURIComponent(spanId)}` : ''}`;
