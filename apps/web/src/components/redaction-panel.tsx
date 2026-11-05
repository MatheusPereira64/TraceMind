'use client';

import type { RedactionSettings } from '@tracemind/shared';
import { ShieldCheck } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { useUpdateProject } from '@/hooks/queries';
import { ApiError } from '@/lib/api-client';
import { Button } from './ui/button';
import { Card, CardHeader } from './ui/card';
import { TextareaField } from './ui/field';
import { FormError } from './ui/states';

function Toggle({
  label,
  description,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  description: string;
  checked: boolean;
  disabled?: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="flex cursor-pointer items-start gap-3 has-disabled:cursor-not-allowed has-disabled:opacity-60">
      <input
        type="checkbox"
        className="mt-0.5 size-4 accent-[var(--primary)]"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>
        <span className="block text-sm font-medium">{label}</span>
        <span className="block text-xs text-muted">{description}</span>
      </span>
    </label>
  );
}

export function RedactionPanel({
  projectId,
  settings,
  canEdit,
}: {
  projectId: string;
  settings: RedactionSettings;
  canEdit: boolean;
}) {
  const update = useUpdateProject(projectId);
  const [draft, setDraft] = useState(settings);
  const [literals, setLiterals] = useState(settings.literals.join('\n'));
  const [saved, setSaved] = useState(false);

  // Any edit after a successful save hides the confirmation.
  const edit = (change: Partial<RedactionSettings>) => {
    setSaved(false);
    setDraft((current) => ({ ...current, ...change }));
  };

  useEffect(() => {
    setDraft(settings);
    setLiterals(settings.literals.join('\n'));
  }, [settings]);

  const parsedLiterals = literals
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  const dirty =
    draft.enabled !== settings.enabled ||
    draft.maskEmails !== settings.maskEmails ||
    draft.maskPhoneNumbers !== settings.maskPhoneNumbers ||
    parsedLiterals.join('\n') !== settings.literals.join('\n');

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    setSaved(false);
    update.mutate(
      { redaction: { ...draft, literals: parsedLiterals } },
      { onSuccess: () => setSaved(true) },
    );
  }

  const literalError =
    update.error instanceof ApiError
      ? update.error.issues?.find((issue) => issue.path.startsWith('redaction.literals'))?.message
      : undefined;

  return (
    <Card>
      <CardHeader
        title={
          <span className="flex items-center gap-1.5">
            <ShieldCheck className="size-4 text-primary" aria-hidden /> Sensitive-data redaction
          </span>
        }
        description="Applied to prompts, completions and metadata before anything is queued or stored."
      />
      <form onSubmit={onSubmit} className="space-y-4 px-5 py-4">
        <Toggle
          label="Mask secrets"
          description="Provider and TraceMind API keys, bearer tokens, JWTs, private keys, card numbers and values of fields like password or api_key."
          checked={draft.enabled}
          disabled={!canEdit}
          onChange={(enabled) => edit({ enabled })}
        />
        <Toggle
          label="Mask email addresses"
          description="Replaces emails with [REDACTED:email]."
          checked={draft.maskEmails}
          disabled={!canEdit || !draft.enabled}
          onChange={(maskEmails) => edit({ maskEmails })}
        />
        <Toggle
          label="Mask phone numbers"
          description="Numbers with 10 or more digits. Off by default because it can also match order numbers or IDs."
          checked={draft.maskPhoneNumbers}
          disabled={!canEdit || !draft.enabled}
          onChange={(maskPhoneNumbers) => edit({ maskPhoneNumbers })}
        />
        <TextareaField
          label="Custom terms"
          hint="One per line, matched exactly (case-sensitive), e.g. internal hostnames or customer names. Up to 50."
          value={literals}
          disabled={!canEdit}
          onChange={(event) => {
            setSaved(false);
            setLiterals(event.target.value);
          }}
          error={literalError}
          className="font-mono text-xs"
        />
        <FormError error={literalError ? null : update.error} />
        {canEdit ? (
          <div className="flex items-center gap-3">
            <Button type="submit" size="sm" disabled={!dirty} loading={update.isPending}>
              Save redaction settings
            </Button>
            {saved ? (
              <span className="text-xs text-success">
                Saved. Applies to new telemetry within 30 s.
              </span>
            ) : null}
          </div>
        ) : null}
      </form>
    </Card>
  );
}
