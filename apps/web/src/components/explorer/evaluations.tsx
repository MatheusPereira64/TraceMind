'use client';

import {
  CRITERION_NAME_PATTERN,
  EVALUATION_KINDS,
  type CriterionDto,
  type EvaluationDto,
  type EvaluationKind,
} from '@tracemind/shared';
import { ThumbsDown, ThumbsUp, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { useCriteria, useDeleteEvaluation, useRecordEvaluation } from '@/hooks/explorer';
import { useMe } from '@/hooks/queries';
import { formatShortDateTime } from '@/lib/format';
import { cn } from '@/lib/utils';
import { Button } from '../ui/button';
import { Badge } from '../ui/card';
import { FormError } from '../ui/states';

const FEEDBACK = 'user_feedback';

/** "0.82", "4 / 5", "👍", "resolved" — the evaluation as a short value. */
export function EvaluationValue({ evaluation }: { evaluation: EvaluationDto }) {
  if (evaluation.kind === 'thumbs')
    return evaluation.score === 1 ? (
      <span className="inline-flex items-center gap-1 text-success">
        <ThumbsUp className="size-3.5" aria-hidden /> Up
      </span>
    ) : (
      <span className="inline-flex items-center gap-1 text-danger">
        <ThumbsDown className="size-3.5" aria-hidden /> Down
      </span>
    );
  if (evaluation.kind === 'categorical') return <span>{evaluation.label}</span>;
  return <span className="font-mono tabular-nums">{evaluation.score}</span>;
}

export function EvaluationList({
  projectId,
  traceId,
  evaluations,
  canEdit,
}: {
  projectId: string;
  traceId: string;
  evaluations: EvaluationDto[];
  canEdit: boolean;
}) {
  const me = useMe();
  const remove = useDeleteEvaluation(projectId, traceId);
  if (evaluations.length === 0) return <p className="text-sm text-muted">No evaluations yet.</p>;
  return (
    <ul className="divide-y divide-border">
      {evaluations.map((evaluation) => (
        <li key={evaluation.id} className="flex items-start gap-3 py-2.5">
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
              <span className="font-medium">{evaluation.criterion}</span>
              <EvaluationValue evaluation={evaluation} />
              {evaluation.spanId ? (
                <span className="font-mono text-[11px] text-subtle">span {evaluation.spanId}</span>
              ) : null}
            </div>
            {evaluation.comment ? (
              <p className="mt-1 whitespace-pre-wrap text-sm text-muted">{evaluation.comment}</p>
            ) : null}
            <p className="mt-1 text-xs text-subtle">
              <Badge tone={evaluation.source === 'human' ? 'primary' : 'neutral'}>
                {evaluation.source}
              </Badge>{' '}
              {evaluation.createdBy ? `${evaluation.createdBy.name} · ` : ''}
              {formatShortDateTime(evaluation.createdAt)}
            </p>
          </div>
          {canEdit && evaluation.createdBy?.id === me.data?.user.id ? (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`Delete ${evaluation.criterion} evaluation`}
              loading={remove.isPending && remove.variables === evaluation.id}
              onClick={() => remove.mutate(evaluation.id)}
            >
              <Trash2 />
            </Button>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/**
 * Quick thumbs feedback for the trace (or a span). Clicking the active thumb removes the vote;
 * the other thumb replaces it (the API updates the user's previous score).
 */
export function QuickFeedback({
  projectId,
  traceId,
  spanId,
  evaluations,
}: {
  projectId: string;
  traceId: string;
  spanId?: string;
  evaluations: EvaluationDto[];
}) {
  const me = useMe();
  const record = useRecordEvaluation(projectId, traceId);
  const remove = useDeleteEvaluation(projectId, traceId);
  const mine = evaluations.find(
    (evaluation) =>
      evaluation.criterion === FEEDBACK &&
      evaluation.source === 'human' &&
      evaluation.createdBy?.id === me.data?.user.id &&
      (evaluation.spanId ?? undefined) === spanId,
  );
  const busy = record.isPending || remove.isPending;
  const vote = (score: 0 | 1) =>
    mine?.score === score
      ? remove.mutate(mine.id)
      : record.mutate({ criterion: FEEDBACK, kind: 'thumbs', score, spanId });

  return (
    <div className="flex items-center gap-1" role="group" aria-label="Your feedback">
      {([1, 0] as const).map((score) => {
        const Icon = score === 1 ? ThumbsUp : ThumbsDown;
        const active = mine?.score === score;
        return (
          <Button
            key={score}
            variant="secondary"
            size="sm"
            disabled={busy}
            aria-pressed={active}
            aria-label={score === 1 ? 'Good response' : 'Bad response'}
            onClick={() => vote(score)}
            className={cn(
              active && score === 1 && 'border-success/50 bg-success/10 text-success',
              active && score === 0 && 'border-danger/50 bg-danger/10 text-danger',
            )}
          >
            <Icon />
          </Button>
        );
      })}
      {record.error ? <FormError error={record.error} /> : null}
    </div>
  );
}

const inputClass =
  'h-8 w-full rounded-md border border-border bg-background px-2 text-sm text-foreground focus:border-primary focus:outline-none';

/** Score form for any criterion: defined criteria bring their kind, scale and labels. */
export function ScoreForm({
  projectId,
  traceId,
  spanId,
  onDone,
}: {
  projectId: string;
  traceId: string;
  spanId?: string;
  onDone?: () => void;
}) {
  const criteria = useCriteria(projectId);
  const record = useRecordEvaluation(projectId, traceId);
  const defined = criteria.data ?? [];
  const [name, setName] = useState('');
  const [custom, setCustom] = useState('');
  const [customKind, setCustomKind] = useState<EvaluationKind>('numeric');
  const [score, setScore] = useState('');
  const [label, setLabel] = useState('');
  const [comment, setComment] = useState('');

  const definition: CriterionDto | undefined = defined.find((entry) => entry.name === name);
  const criterion = name === '__custom' ? custom.trim() : name;
  const kind = definition?.kind ?? customKind;
  const validName = CRITERION_NAME_PATTERN.test(criterion);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (!validName) return;
    record.mutate(
      {
        criterion,
        kind,
        spanId,
        score: kind === 'categorical' ? undefined : Number(score),
        label: kind === 'categorical' ? label : undefined,
        comment: comment.trim() || undefined,
      },
      {
        onSuccess: () => {
          setScore('');
          setLabel('');
          setComment('');
          onDone?.();
        },
      },
    );
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <label className="space-y-1 text-xs text-muted">
          Criterion
          <select
            className={inputClass}
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setScore('');
              setLabel('');
            }}
            required
          >
            <option value="" disabled>
              Choose…
            </option>
            {defined.map((entry) => (
              <option key={entry.id} value={entry.name}>
                {entry.name} ({entry.kind})
              </option>
            ))}
            <option value="__custom">Other criterion…</option>
          </select>
        </label>
        {name === '__custom' ? (
          <div className="grid grid-cols-[1fr_auto] gap-2">
            <label className="space-y-1 text-xs text-muted">
              Name
              <input
                className={inputClass}
                value={custom}
                onChange={(event) => setCustom(event.target.value)}
                placeholder="e.g. correctness"
                aria-invalid={custom !== '' && !validName}
                required
              />
            </label>
            <label className="space-y-1 text-xs text-muted">
              Kind
              <select
                className={inputClass}
                value={customKind}
                onChange={(event) => setCustomKind(event.target.value as EvaluationKind)}
              >
                {EVALUATION_KINDS.filter((entry) => entry !== 'categorical').map((entry) => (
                  <option key={entry} value={entry}>
                    {entry}
                  </option>
                ))}
              </select>
            </label>
          </div>
        ) : null}
      </div>
      {definition?.description ? (
        <p className="text-xs text-muted">{definition.description}</p>
      ) : null}

      {name ? (
        kind === 'thumbs' ? (
          <div className="flex gap-2" role="radiogroup" aria-label="Score">
            {(['1', '0'] as const).map((value) => {
              const Icon = value === '1' ? ThumbsUp : ThumbsDown;
              return (
                <Button
                  key={value}
                  variant="secondary"
                  size="sm"
                  role="radio"
                  aria-checked={score === value}
                  aria-label={value === '1' ? 'Thumbs up' : 'Thumbs down'}
                  onClick={() => setScore(value)}
                  className={cn(score === value && 'border-primary bg-primary/10 text-primary')}
                >
                  <Icon />
                </Button>
              );
            })}
          </div>
        ) : kind === 'categorical' ? (
          <label className="block space-y-1 text-xs text-muted">
            Label
            <select
              className={inputClass}
              value={label}
              onChange={(event) => setLabel(event.target.value)}
              required
            >
              <option value="" disabled>
                Choose…
              </option>
              {definition?.labels.map((entry) => (
                <option key={entry} value={entry}>
                  {entry}
                </option>
              ))}
            </select>
          </label>
        ) : (
          <label className="block space-y-1 text-xs text-muted">
            Score
            {definition?.minScore !== null && definition?.minScore !== undefined
              ? ` (${definition.minScore}–${definition.maxScore})`
              : ''}
            <input
              type="number"
              step="any"
              className={inputClass}
              min={definition?.minScore ?? undefined}
              max={definition?.maxScore ?? undefined}
              value={score}
              onChange={(event) => setScore(event.target.value)}
              required
            />
          </label>
        )
      ) : null}

      <label className="block space-y-1 text-xs text-muted">
        Comment (optional)
        <textarea
          className={cn(inputClass, 'h-auto min-h-16 py-1.5')}
          value={comment}
          maxLength={5000}
          onChange={(event) => setComment(event.target.value)}
        />
      </label>
      {record.error ? <FormError error={record.error} /> : null}
      <div className="flex justify-end">
        <Button
          type="submit"
          size="sm"
          loading={record.isPending}
          disabled={!name || !validName || (kind === 'categorical' ? !label : score === '')}
        >
          Save score
        </Button>
      </div>
    </form>
  );
}
