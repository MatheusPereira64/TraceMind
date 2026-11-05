'use client';

import { hasRoleAtLeast } from '@tracemind/shared';
import { Check, FolderKanban, KeyRound, Loader2, Radio } from 'lucide-react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState, type ReactNode } from 'react';
import { PageHeader } from '@/components/app-shell';
import { CreateProjectDialog } from '@/components/create-project-dialog';
import { useOrganization } from '@/components/organization-context';
import { Button, buttonVariants } from '@/components/ui/button';
import { Card, CardHeader } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useApiKeys, useProjects } from '@/hooks/queries';
import { cn } from '@/lib/utils';

function Step({
  done,
  pending = false,
  icon: Icon,
  title,
  description,
  action,
}: {
  done: boolean;
  /** Completion is still being determined; avoids flashing "not done". */
  pending?: boolean;
  icon: typeof FolderKanban;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <li className="flex items-start gap-4 px-5 py-4">
      <div
        className={cn(
          'mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-full border',
          done
            ? 'border-success/40 bg-success/10 text-success'
            : 'border-border bg-surface-raised text-muted',
        )}
      >
        {pending ? (
          <Loader2 className="size-4 animate-spin" aria-label="Checking" />
        ) : done ? (
          <Check className="size-4" aria-label="Done" />
        ) : (
          <Icon className="size-4" aria-hidden />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <p
          className={cn('text-sm font-medium', done && 'text-muted line-through decoration-subtle')}
        >
          {title}
        </p>
        <p className="mt-0.5 text-sm text-muted">{description}</p>
      </div>
      {!done && !pending && action ? <div className="shrink-0">{action}</div> : null}
    </li>
  );
}

/** The first project's keys tell us whether onboarding step 2 is done. */
function KeyStep({ projectId }: { projectId: string }) {
  const keys = useApiKeys(projectId);
  const hasKey = (keys.data ?? []).some((key) => !key.revokedAt);
  const hasUsedKey = (keys.data ?? []).some((key) => key.lastUsedAt !== null);
  return (
    <>
      <Step
        pending={keys.isPending}
        done={hasKey}
        icon={KeyRound}
        title="Create an API key"
        description="Keys authenticate your application when it sends telemetry."
        action={
          <Link
            href={`/projects/${projectId}`}
            className={buttonVariants({ size: 'sm', variant: 'secondary' })}
          >
            Create key
          </Link>
        }
      />
      <Step
        pending={keys.isPending}
        done={hasUsedKey}
        icon={Radio}
        title="Connect your application"
        description="Verify the key from your app's environment. Trace ingestion and the TypeScript SDK arrive in the next release."
      />
    </>
  );
}

export default function OverviewPage() {
  const router = useRouter();
  const { current } = useOrganization();
  const projects = useProjects(current.id);
  const [creating, setCreating] = useState(false);
  const firstProject = projects.data?.[0];
  const canCreate = hasRoleAtLeast(current.role, 'admin');

  return (
    <>
      <PageHeader title="Overview" description={`Getting started with ${current.name}.`} />
      <Card>
        <CardHeader
          title="Set up observability"
          description="Three steps to see your first LLM trace."
        />
        {projects.isPending ? (
          <LoadingState />
        ) : projects.isError ? (
          <ErrorState error={projects.error} onRetry={() => projects.refetch()} />
        ) : (
          <ol className="divide-y divide-border">
            <Step
              done={Boolean(firstProject)}
              icon={FolderKanban}
              title="Create a project"
              description="One project per LLM application you want to observe."
              action={
                canCreate ? (
                  <Button size="sm" onClick={() => setCreating(true)}>
                    New project
                  </Button>
                ) : undefined
              }
            />
            {firstProject ? (
              <KeyStep projectId={firstProject.id} />
            ) : (
              <>
                <Step
                  done={false}
                  icon={KeyRound}
                  title="Create an API key"
                  description="Available once you have a project."
                />
                <Step
                  done={false}
                  icon={Radio}
                  title="Connect your application"
                  description="Send telemetry with the API key."
                />
              </>
            )}
          </ol>
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
