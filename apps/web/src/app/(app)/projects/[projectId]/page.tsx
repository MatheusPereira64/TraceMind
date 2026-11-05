'use client';

import { hasRoleAtLeast } from '@tracemind/shared';
import { ArrowLeft } from 'lucide-react';
import Link from 'next/link';
import { use, useState, type ReactNode } from 'react';
import { ApiKeysPanel } from '@/components/api-keys-panel';
import { PageHeader } from '@/components/app-shell';
import { IngestionPanel } from '@/components/ingestion-panel';
import { RedactionPanel } from '@/components/redaction-panel';
import { useOrganization } from '@/components/organization-context';
import { Button } from '@/components/ui/button';
import { Badge, Card, CardHeader } from '@/components/ui/card';
import { Dialog } from '@/components/ui/dialog';
import { ErrorState, FormError, LoadingState } from '@/components/ui/states';
import { useArchiveProject, useProject } from '@/hooks/queries';
import { ApiError } from '@/lib/api-client';
import { formatDate } from '@/lib/utils';

function Detail({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-1 text-sm">{children}</dd>
    </div>
  );
}

export default function ProjectPage({ params }: { params: Promise<{ projectId: string }> }) {
  const { projectId } = use(params);
  const { organizations } = useOrganization();
  const project = useProject(projectId);
  const archive = useArchiveProject(projectId);
  const [confirmArchive, setConfirmArchive] = useState(false);

  const back = (
    <Link
      href="/projects"
      className="mb-4 inline-flex items-center gap-1.5 text-sm text-muted hover:text-foreground"
    >
      <ArrowLeft className="size-4" aria-hidden /> Projects
    </Link>
  );

  if (project.isPending) return <LoadingState label="Loading project…" />;
  if (project.isError) {
    const notFound = project.error instanceof ApiError && project.error.status === 404;
    return (
      <>
        {back}
        <Card>
          {notFound ? (
            <div className="px-6 py-14 text-center">
              <h2 className="text-sm font-semibold">Project not found</h2>
              <p className="mt-1 text-sm text-muted">
                It may have been removed, or you don&apos;t have access to it.
              </p>
            </div>
          ) : (
            <ErrorState error={project.error} onRetry={() => project.refetch()} />
          )}
        </Card>
      </>
    );
  }

  const data = project.data;
  // The project may belong to an organization other than the one selected in the switcher.
  const role = organizations.find((org) => org.id === data.organizationId)?.role ?? 'viewer';
  const archived = data.archivedAt !== null;

  return (
    <>
      {back}
      <PageHeader
        title={data.name}
        description={data.description ?? undefined}
        actions={
          archived ? (
            <Badge tone="warning">archived</Badge>
          ) : data.isDemo ? (
            <Badge tone="warning">simulated data</Badge>
          ) : null
        }
      />

      <div className="space-y-6">
        <Card>
          <CardHeader title="Details" />
          <dl className="grid grid-cols-2 gap-5 px-5 py-4 sm:grid-cols-4">
            <Detail label="Slug">
              <span className="font-mono text-xs">{data.slug}</span>
            </Detail>
            <Detail label="Project ID">
              <span className="break-all font-mono text-xs">{data.id}</span>
            </Detail>
            <Detail label="Retention">{data.retentionDays} days</Detail>
            <Detail label="Created">{formatDate(data.createdAt)}</Detail>
          </dl>
        </Card>

        <IngestionPanel projectId={data.id} />

        <ApiKeysPanel projectId={data.id} role={role} archived={archived} />

        <RedactionPanel
          projectId={data.id}
          settings={data.redaction}
          canEdit={hasRoleAtLeast(role, 'admin') && !archived}
        />

        {hasRoleAtLeast(role, 'admin') && !archived ? (
          <Card className="border-danger/30">
            <CardHeader
              title="Archive project"
              description="Stops accepting telemetry and revokes access for its API keys. Existing data stays readable until retention removes it."
              action={
                <Button variant="danger" size="sm" onClick={() => setConfirmArchive(true)}>
                  Archive
                </Button>
              }
            />
          </Card>
        ) : null}
      </div>

      <Dialog
        open={confirmArchive}
        onClose={() => setConfirmArchive(false)}
        title={`Archive ${data.name}?`}
        description="Its API keys will stop working immediately."
      >
        <FormError error={archive.error} />
        <div className="mt-4 flex justify-end gap-2">
          <Button variant="secondary" onClick={() => setConfirmArchive(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={archive.isPending}
            onClick={() => archive.mutate(undefined, { onSuccess: () => setConfirmArchive(false) })}
          >
            Archive project
          </Button>
        </div>
      </Dialog>
    </>
  );
}
