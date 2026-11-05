'use client';

import type { ReactNode } from 'react';
import { AppShell } from '@/components/app-shell';
import { CreateOrganizationForm } from '@/components/create-organization-form';
import { Logo } from '@/components/logo';
import { OrganizationProvider } from '@/components/organization-context';
import { Card } from '@/components/ui/card';
import { ErrorState, LoadingState } from '@/components/ui/states';
import { useMe } from '@/hooks/queries';
import { ApiError } from '@/lib/api-client';

export default function AuthenticatedLayout({ children }: { children: ReactNode }) {
  const me = useMe();

  if (me.isPending) {
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <LoadingState label="Loading your workspace…" />
      </div>
    );
  }

  if (me.isError) {
    // 401 triggers the global redirect to /login (see Providers); show nothing meanwhile.
    if (me.error instanceof ApiError && me.error.status === 401) return null;
    return (
      <div className="flex min-h-dvh items-center justify-center">
        <ErrorState error={me.error} onRetry={() => me.refetch()} />
      </div>
    );
  }

  if (me.data.organizations.length === 0) {
    return (
      <main className="flex min-h-dvh items-center justify-center px-4">
        <div className="w-full max-w-sm">
          <Logo className="mb-8 flex justify-center" />
          <Card className="p-6">
            <h1 className="text-lg font-semibold">Create an organization</h1>
            <p className="mb-5 mt-1 text-sm text-muted">
              Projects and API keys live inside an organization.
            </p>
            <CreateOrganizationForm />
          </Card>
        </div>
      </main>
    );
  }

  return (
    <OrganizationProvider organizations={me.data.organizations}>
      <AppShell user={me.data.user}>{children}</AppShell>
    </OrganizationProvider>
  );
}
