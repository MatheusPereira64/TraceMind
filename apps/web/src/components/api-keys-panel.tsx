'use client';

import {
  ENVIRONMENTS,
  hasRoleAtLeast,
  type ApiKeyDto,
  type CreatedApiKeyDto,
  type Environment,
  type OrganizationRole,
} from '@tracemind/shared';
import { KeyRound, Plus, ShieldAlert } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useApiKeys, useCreateApiKey, useRevokeApiKey } from '@/hooks/queries';
import { ApiError } from '@/lib/api-client';
import { PUBLIC_API_URL } from '@/lib/config';
import { formatDate, formatRelative } from '@/lib/utils';
import { Button } from './ui/button';
import { Badge, Card, CardHeader } from './ui/card';
import { CopyButton } from './ui/copy-button';
import { Dialog } from './ui/dialog';
import { InputField, SelectField } from './ui/field';
import { EmptyState, ErrorState, FormError, LoadingState } from './ui/states';

type KeyStatus = 'active' | 'revoked' | 'expired';

export function keyStatus(key: ApiKeyDto, now: number = Date.now()): KeyStatus {
  if (key.revokedAt) return 'revoked';
  if (key.expiresAt && new Date(key.expiresAt).getTime() <= now) return 'expired';
  return 'active';
}

const STATUS_TONE = { active: 'success', revoked: 'danger', expired: 'warning' } as const;

function CreateKeyDialog({
  projectId,
  open,
  onClose,
}: {
  projectId: string;
  open: boolean;
  onClose: () => void;
}) {
  const create = useCreateApiKey(projectId);
  const [name, setName] = useState('');
  const [environment, setEnvironment] = useState<Environment>('development');
  const [created, setCreated] = useState<CreatedApiKeyDto | null>(null);

  function close() {
    setName('');
    setEnvironment('development');
    setCreated(null);
    create.reset();
    onClose();
  }

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    create.mutate({ name, environment }, { onSuccess: setCreated });
  }

  if (created) {
    const verify = `curl ${PUBLIC_API_URL}/v1/ingest/whoami \\\n  -H "Authorization: Bearer ${created.key}"`;
    return (
      <Dialog
        open={open}
        onClose={close}
        title="Save your API key"
        description="This is the only time the full key is shown."
      >
        <div className="space-y-4">
          <div className="flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 p-3 text-sm text-warning">
            <ShieldAlert className="mt-0.5 size-4 shrink-0" aria-hidden />
            <p>
              Store it in your secret manager or <code className="font-mono">.env</code>. Never
              commit it or ship it to a browser.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <code className="min-w-0 flex-1 select-all truncate rounded-md border border-border bg-background px-3 py-2 font-mono text-xs">
              {created.key}
            </code>
            <CopyButton value={created.key} />
          </div>
          <div>
            <p className="mb-1.5 text-xs font-medium text-muted">Verify it</p>
            <pre className="overflow-x-auto rounded-md border border-border bg-background p-3 font-mono text-xs leading-relaxed text-muted">
              {verify}
            </pre>
          </div>
          <div className="flex justify-end">
            <Button onClick={close}>Done</Button>
          </div>
        </div>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={close}
      title="New API key"
      description="Keys authenticate applications that send telemetry to this project."
    >
      <form onSubmit={onSubmit} className="space-y-4" noValidate>
        <InputField
          label="Name"
          placeholder="production-backend"
          required
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={create.error instanceof ApiError ? create.error.fieldError('name') : undefined}
        />
        <SelectField
          label="Environment"
          value={environment}
          onChange={(event) => setEnvironment(event.target.value as Environment)}
          options={ENVIRONMENTS.map((value) => ({ value, label: value }))}
          hint="Default environment attached to telemetry sent with this key."
        />
        <FormError error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={close}>
            Cancel
          </Button>
          <Button type="submit" loading={create.isPending}>
            Create key
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function RevokeDialog({
  projectId,
  apiKey,
  onClose,
}: {
  projectId: string;
  apiKey: ApiKeyDto | null;
  onClose: () => void;
}) {
  const revoke = useRevokeApiKey(projectId);
  return (
    <Dialog
      open={apiKey !== null}
      onClose={() => {
        revoke.reset();
        onClose();
      }}
      title="Revoke API key?"
      description={
        <>
          Applications using <span className="font-mono text-foreground">{apiKey?.prefix}…</span>{' '}
          will immediately stop sending telemetry. This cannot be undone.
        </>
      }
    >
      <FormError error={revoke.error} />
      <div className="mt-4 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={revoke.isPending}
          onClick={() => apiKey && revoke.mutate(apiKey.id, { onSuccess: onClose })}
        >
          Revoke key
        </Button>
      </div>
    </Dialog>
  );
}

export function ApiKeysPanel({
  projectId,
  role,
  archived,
}: {
  projectId: string;
  role: OrganizationRole;
  archived: boolean;
}) {
  const keys = useApiKeys(projectId);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<ApiKeyDto | null>(null);
  const canManage = hasRoleAtLeast(role, 'admin') && !archived;

  const createButton = canManage ? (
    <Button size="sm" onClick={() => setCreating(true)}>
      <Plus /> New key
    </Button>
  ) : null;

  return (
    <Card>
      <CardHeader
        title="API keys"
        description="Used by the SDK and OpenTelemetry exporters to send telemetry."
        action={createButton}
      />
      {keys.isPending ? (
        <LoadingState label="Loading keys…" />
      ) : keys.isError ? (
        <ErrorState error={keys.error} onRetry={() => keys.refetch()} />
      ) : keys.data.length === 0 ? (
        <EmptyState
          icon={KeyRound}
          title="No API keys"
          description="Create a key to start sending traces from your application."
          action={createButton}
        />
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border text-left text-xs text-muted">
                <th className="px-5 py-2.5 font-medium">Name</th>
                <th className="px-3 py-2.5 font-medium">Key</th>
                <th className="px-3 py-2.5 font-medium">Environment</th>
                <th className="px-3 py-2.5 font-medium">Created</th>
                <th className="px-3 py-2.5 font-medium">Last used</th>
                <th className="px-3 py-2.5 font-medium">Status</th>
                <th className="px-5 py-2.5" aria-label="Actions" />
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {keys.data.map((key) => {
                const status = keyStatus(key);
                return (
                  <tr key={key.id}>
                    <td className="px-5 py-3 font-medium">{key.name}</td>
                    <td className="px-3 py-3 font-mono text-xs text-muted">{key.prefix}…</td>
                    <td className="px-3 py-3">
                      <Badge>{key.environment}</Badge>
                    </td>
                    <td className="px-3 py-3 text-muted" title={key.createdAt}>
                      {formatDate(key.createdAt)}
                    </td>
                    <td className="px-3 py-3 text-muted">
                      {key.lastUsedAt ? formatRelative(key.lastUsedAt) : 'Never'}
                    </td>
                    <td className="px-3 py-3">
                      <Badge tone={STATUS_TONE[status]}>{status}</Badge>
                    </td>
                    <td className="px-5 py-3 text-right">
                      {canManage && status === 'active' ? (
                        <Button variant="ghost" size="sm" onClick={() => setRevoking(key)}>
                          Revoke
                        </Button>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <CreateKeyDialog projectId={projectId} open={creating} onClose={() => setCreating(false)} />
      <RevokeDialog projectId={projectId} apiKey={revoking} onClose={() => setRevoking(null)} />
    </Card>
  );
}
