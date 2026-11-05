'use client';

import { CreateOrganizationForm } from '@/components/create-organization-form';
import { PageHeader } from '@/components/app-shell';
import { useOrganization } from '@/components/organization-context';
import { Badge, Card, CardHeader } from '@/components/ui/card';
import { useMe } from '@/hooks/queries';
import { formatDate } from '@/lib/utils';

export default function SettingsPage() {
  const me = useMe();
  const { organizations, current, select } = useOrganization();
  const user = me.data?.user;

  return (
    <>
      <PageHeader title="Settings" description="Your account and organizations." />
      <div className="space-y-6">
        {user ? (
          <Card>
            <CardHeader title="Account" />
            <dl className="grid gap-5 px-5 py-4 sm:grid-cols-3">
              <div>
                <dt className="text-xs text-muted">Name</dt>
                <dd className="mt-1 text-sm">{user.name}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Email</dt>
                <dd className="mt-1 text-sm">{user.email}</dd>
              </div>
              <div>
                <dt className="text-xs text-muted">Member since</dt>
                <dd className="mt-1 text-sm">{formatDate(user.createdAt)}</dd>
              </div>
            </dl>
          </Card>
        ) : null}

        <Card>
          <CardHeader
            title="Organizations"
            description="Projects, API keys and telemetry are isolated per organization."
          />
          <ul className="divide-y divide-border">
            {organizations.map((organization) => (
              <li key={organization.id} className="flex items-center gap-3 px-5 py-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium">{organization.name}</p>
                  <p className="font-mono text-xs text-muted">{organization.slug}</p>
                </div>
                <Badge tone={organization.role === 'owner' ? 'primary' : 'neutral'}>
                  {organization.role}
                </Badge>
                {organization.id === current.id ? (
                  <Badge tone="success">current</Badge>
                ) : (
                  <button
                    type="button"
                    onClick={() => select(organization.id)}
                    className="text-sm text-muted hover:text-foreground"
                  >
                    Switch
                  </button>
                )}
              </li>
            ))}
          </ul>
          <div className="border-t border-border px-5 py-4">
            <h3 className="mb-3 text-sm font-medium">New organization</h3>
            <div className="max-w-sm">
              <CreateOrganizationForm onCreated={(organization) => select(organization.id)} />
            </div>
          </div>
        </Card>
      </div>
    </>
  );
}
