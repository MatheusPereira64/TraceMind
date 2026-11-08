'use client';

import {
  EVALUATION_KINDS,
  type CriterionDto,
  type CriterionInput,
  type EvaluationKind,
} from '@tracemind/shared';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useDeleteCriterion, useSaveCriterion } from '@/hooks/explorer';
import { ApiError } from '@/lib/api-client';
import { Button } from '../ui/button';
import { Badge } from '../ui/card';
import { Dialog } from '../ui/dialog';
import { InputField, SelectField, TextareaField } from '../ui/field';
import { FormError } from '../ui/states';

const KIND_HINT: Record<EvaluationKind, string> = {
  thumbs: 'Good / bad, like user feedback buttons.',
  numeric: 'A score on a fixed scale, e.g. 0–1 or 1–5.',
  categorical: 'One label out of a fixed list, e.g. resolved / unresolved.',
};

function CriterionForm({
  projectId,
  initial,
  onDone,
}: {
  projectId: string;
  initial?: CriterionDto;
  onDone: () => void;
}) {
  const save = useSaveCriterion(projectId);
  const [name, setName] = useState(initial?.name ?? '');
  const [kind, setKind] = useState<EvaluationKind>(initial?.kind ?? 'numeric');
  const [description, setDescription] = useState(initial?.description ?? '');
  const [minScore, setMinScore] = useState(String(initial?.minScore ?? 0));
  const [maxScore, setMaxScore] = useState(String(initial?.maxScore ?? 1));
  const [labels, setLabels] = useState((initial?.labels ?? []).join(', '));
  const error = save.error instanceof ApiError ? save.error : undefined;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const input: CriterionInput = {
      name: name.trim(),
      kind,
      description: description.trim() || undefined,
      ...(kind === 'numeric' ? { minScore: Number(minScore), maxScore: Number(maxScore) } : {}),
      ...(kind === 'categorical'
        ? {
            labels: labels
              .split(',')
              .map((label) => label.trim())
              .filter(Boolean),
          }
        : {}),
    };
    save.mutate({ id: initial?.id, input }, { onSuccess: onDone });
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <InputField
        label="Name"
        value={name}
        onChange={(event) => setName(event.target.value)}
        disabled={Boolean(initial)}
        placeholder="helpfulness"
        hint={
          initial ? 'Names cannot change: existing scores use them.' : 'Letters, numbers, . _ : -'
        }
        error={error?.fieldError('name')}
        required
      />
      <SelectField
        label="Kind"
        value={kind}
        onChange={(event) => setKind(event.target.value as EvaluationKind)}
        disabled={Boolean(initial)}
        hint={KIND_HINT[kind]}
        options={EVALUATION_KINDS.map((value) => ({ value, label: value }))}
      />
      {kind === 'numeric' ? (
        <div className="grid grid-cols-2 gap-3">
          <InputField
            label="Minimum"
            type="number"
            step="any"
            value={minScore}
            onChange={(event) => setMinScore(event.target.value)}
            required
          />
          <InputField
            label="Maximum"
            type="number"
            step="any"
            value={maxScore}
            onChange={(event) => setMaxScore(event.target.value)}
            error={error?.fieldError('maxScore')}
            required
          />
        </div>
      ) : null}
      {kind === 'categorical' ? (
        <InputField
          label="Labels"
          value={labels}
          onChange={(event) => setLabels(event.target.value)}
          placeholder="resolved, partially_resolved, unresolved"
          hint="Comma-separated, at least two."
          error={error?.fieldError('labels')}
          required
        />
      ) : null}
      <TextareaField
        label="Description"
        value={description}
        onChange={(event) => setDescription(event.target.value)}
        hint="What a good score means, so reviewers score consistently."
        maxLength={500}
      />
      <FormError error={save.error} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onClick={onDone}>
          Cancel
        </Button>
        <Button type="submit" loading={save.isPending}>
          {initial ? 'Save changes' : 'Create criterion'}
        </Button>
      </div>
    </form>
  );
}

/** Criteria definitions with create / edit / delete for admins. */
export function CriteriaManager({
  projectId,
  criteria,
  counts,
  canManage,
}: {
  projectId: string;
  criteria: CriterionDto[];
  counts: Map<string, number>;
  canManage: boolean;
}) {
  const [editing, setEditing] = useState<CriterionDto | 'new' | null>(null);
  const remove = useDeleteCriterion(projectId);

  return (
    <div>
      {criteria.length === 0 ? (
        <p className="px-5 py-6 text-sm text-muted">
          No criteria defined. Scores sent with any criterion name still appear here; defining one
          adds a description, a scale and makes it available for manual scoring.
        </p>
      ) : (
        <ul className="grid md:grid-cols-2 2xl:grid-cols-3">
          {criteria.map((criterion) => (
            <li
              key={criterion.id}
              className="-mb-px flex items-start gap-3 border-b border-border px-5 py-3"
            >
              <div className="min-w-0 flex-1">
                <p className="flex flex-wrap items-center gap-2 text-sm">
                  <span className="font-medium">{criterion.name}</span>
                  <Badge>{criterion.kind}</Badge>
                  {criterion.kind === 'numeric' ? (
                    <span className="font-mono text-xs text-muted">
                      {criterion.minScore}–{criterion.maxScore}
                    </span>
                  ) : null}
                  {criterion.kind === 'categorical' ? (
                    <span className="font-mono text-xs text-muted">
                      {criterion.labels.join(' · ')}
                    </span>
                  ) : null}
                </p>
                {criterion.description ? (
                  <p className="mt-0.5 text-sm text-muted">{criterion.description}</p>
                ) : null}
                <p className="mt-0.5 text-xs text-subtle">
                  {counts.get(criterion.name) ?? 0} evaluations in range
                </p>
              </div>
              {canManage ? (
                <div className="flex shrink-0 gap-1">
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Edit ${criterion.name}`}
                    onClick={() => setEditing(criterion)}
                  >
                    <Pencil />
                  </Button>
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${criterion.name} definition`}
                    title="Removes the definition; recorded scores are kept"
                    loading={remove.isPending && remove.variables === criterion.id}
                    onClick={() => remove.mutate(criterion.id)}
                  >
                    <Trash2 />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
      {canManage ? (
        <div className="border-t border-border px-5 py-3">
          <Button variant="secondary" size="sm" onClick={() => setEditing('new')}>
            <Plus /> New criterion
          </Button>
        </div>
      ) : null}
      <Dialog
        open={editing !== null}
        onClose={() => setEditing(null)}
        title={editing === 'new' ? 'New criterion' : `Edit ${editing?.name ?? ''}`}
        description="Criteria define what a score means. Your code, users and reviewers all score against them."
      >
        {editing ? (
          <CriterionForm
            projectId={projectId}
            initial={editing === 'new' ? undefined : editing}
            onDone={() => setEditing(null)}
          />
        ) : null}
      </Dialog>
    </div>
  );
}
