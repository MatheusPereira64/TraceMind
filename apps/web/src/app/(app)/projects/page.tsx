'use client';

import { ChevronRight, FolderKanban, Plus } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { hasRoleAtLeast } from '@tracemind/shared';
import { PageHeader } from '@/components/app-shell';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { useOrganization } from '@/components/organization-context';
import { Button } from '@/components/ui/button';
import { Badge, Card } from '@/components/ui/card';
import { EmptyState, ErrorState, LoadingState } from '@/components/ui/states';
import { useProjects } from '@/hooks/queries';
import { formatRelative } from '@/lib/utils';

export default function ProjectsPage() {
  const router = useRouter();
  const { current } = useOrganization();
  const projects = useProjects(current.id);
  const [creating, setCreating] = useState(false);
  const canCreate = hasRoleAtLeast(current.role, 'admin');

  const createButton = canCreate ? (
    <Button onClick={() => setCreating(true)}>
      <Plus /> New project
    </Button>
  ) : null;

  return (
    <>
      <PageHeader
        title="Projects"
        description={`Applications instrumented in ${current.name}.`}
        actions={createButton}
      />

      <Card>
        {projects.isPending ? (
          <LoadingState label="Loading projects…" />
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        ) : projects.data.length === 0 ? (
          <EmptyState
            icon={FolderKanban}
            title="No projects yet"
            description="Create a project for each LLM application you want to observe, then generate an API key for it."
            action={createButton}
          />
        ) : (
          <ul className="divide-y divide-border">
            {projects.data.map((project) => (
              <li key={project.id}>
                <Link
                  href={`/projects/${project.id}`}
                  className="flex items-center gap-4 px-5 py-4 transition-colors hover:bg-surface-raised/60"
                >
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium">{project.name}</span>
                      {project.isDemo ? <Badge tone="warning">simulated</Badge> : null}
                    </div>
                    <p className="mt-0.5 truncate text-sm text-muted">
                      {project.description ?? (
                        <span className="font-mono text-xs">{project.slug}</span>
                      )}
                    </p>
                  </div>
                  <span className="hidden text-xs text-subtle sm:block">
                    created {formatRelative(project.createdAt)}
                  </span>
                  <ChevronRight className="size-4 text-subtle" aria-hidden />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <CreateProjectDialog
        organizationId={current.id}
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(project) => router.push(`/projects/${project.id}`)}
      />
    </>
  );
}
