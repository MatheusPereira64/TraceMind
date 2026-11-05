import { AlertTriangle, Loader2, type LucideIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import { ApiError } from '@/lib/api-client';
import { Button } from './button';

export function LoadingState({ label = 'Loading…' }: { label?: string }) {
  return (
    <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-muted">
      <Loader2 className="size-4 animate-spin" aria-hidden />
      {label}
    </div>
  );
}

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon;
  title: string;
  description: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <div className="mb-4 rounded-lg border border-border bg-surface-raised p-3">
        <Icon className="size-5 text-primary" aria-hidden />
      </div>
      <h3 className="text-sm font-semibold">{title}</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{description}</p>
      {action ? <div className="mt-5">{action}</div> : null}
    </div>
  );
}

export function ErrorState({ error, onRetry }: { error: unknown; onRetry?: () => void }) {
  const message = error instanceof Error ? error.message : 'Something went wrong';
  const requestId = error instanceof ApiError ? error.requestId : undefined;
  return (
    <div role="alert" className="flex flex-col items-center justify-center px-6 py-14 text-center">
      <AlertTriangle className="mb-3 size-5 text-danger" aria-hidden />
      <h3 className="text-sm font-semibold">Couldn&apos;t load this data</h3>
      <p className="mt-1 max-w-sm text-sm text-muted">{message}</p>
      {requestId ? <p className="mt-2 font-mono text-xs text-subtle">request {requestId}</p> : null}
      {onRetry ? (
        <Button variant="secondary" size="sm" className="mt-5" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}

export function FormError({ error }: { error: unknown }) {
  if (!error) return null;
  // Field-level issues are shown next to their inputs; only surface the general message here.
  const message =
    error instanceof ApiError && error.issues?.length
      ? 'Please fix the highlighted fields.'
      : error instanceof Error
        ? error.message
        : 'Something went wrong';
  return (
    <p
      role="alert"
      className="rounded-md border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger"
    >
      {message}
    </p>
  );
}
