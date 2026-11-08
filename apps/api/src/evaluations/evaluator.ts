import type { EvaluationKind, SpanDto } from '@tracemind/shared';

/**
 * Extension point for automated evaluations (ADR-008).
 *
 * An evaluator scores one LLM call against one criterion. Human feedback, SDK scores and
 * automated evaluators all end up in the same `evaluations` table and go through
 * `EvaluationsService.record`, so charts, criteria validation and trace views work for every
 * source without special cases. An LLM-as-a-Judge evaluator implements this interface by calling
 * a model with a grading prompt; a scheduler (BullMQ job) picks unevaluated spans and calls it.
 */
export interface EvaluatorInput {
  traceId: string;
  span: SpanDto;
}

export interface EvaluatorResult {
  score?: number;
  label?: string;
  /** The judge's reasoning; shown next to the score in the trace view. */
  comment?: string;
}

export interface Evaluator {
  /** Criterion name, e.g. `helpfulness`. Must match a defined criterion of the same kind. */
  readonly criterion: string;
  readonly kind: EvaluationKind;
  evaluate(input: EvaluatorInput): Promise<EvaluatorResult>;
}
