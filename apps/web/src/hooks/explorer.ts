'use client';

import {
  keepPreviousData,
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  CreateEvaluationInput,
  CriterionDto,
  CriterionInput,
  EvaluationDto,
  EvaluationSummaryDto,
  EvaluationsPage,
  GenerationDetailDto,
  GenerationsPage,
  RepeatedPromptDto,
  TraceDetailDto,
  TracesPage,
} from '@tracemind/shared';
import { api } from '@/lib/api-client';

/**
 * Trace Explorer, prompt history and evaluation queries. `qs` is the shared analytics query
 * string (range, filters, time zone) built by useAnalyticsQueryString.
 */

const withParams = (qs: string, extra: Record<string, string | undefined>) => {
  const params = new URLSearchParams(qs);
  for (const [key, value] of Object.entries(extra)) if (value) params.set(key, value);
  return params;
};

export function useTraces(
  projectId: string | undefined,
  qs: string | null,
  filters: { q?: string; status?: string; minDurationMs?: string },
) {
  return useInfiniteQuery({
    queryKey: ['traces', projectId, qs, filters],
    queryFn: ({ pageParam }) =>
      api.get<TracesPage>(
        `/v1/projects/${projectId}/traces?${withParams(qs ?? '', { ...filters, cursor: pageParam }).toString()}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(projectId && qs),
    placeholderData: keepPreviousData,
  });
}

export const traceKey = (projectId: string | undefined, traceId: string) => [
  'trace',
  projectId,
  traceId,
];

export function useTrace(projectId: string | undefined, traceId: string) {
  return useQuery({
    queryKey: traceKey(projectId, traceId),
    queryFn: () =>
      api.get<TraceDetailDto>(`/v1/projects/${projectId}/traces/${encodeURIComponent(traceId)}`),
    enabled: Boolean(projectId),
    // A running trace keeps receiving spans; refresh until it finishes.
    refetchInterval: (query) => (query.state.data?.trace.status === 'running' ? 5_000 : false),
  });
}

export function useGenerations(
  projectId: string | undefined,
  qs: string | null,
  filters: { q?: string; status?: string; inputHash?: string },
) {
  return useInfiniteQuery({
    queryKey: ['generations', projectId, qs, filters],
    queryFn: ({ pageParam }) =>
      api.get<GenerationsPage>(
        `/v1/projects/${projectId}/generations?${withParams(qs ?? '', { ...filters, cursor: pageParam }).toString()}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(projectId && qs),
    placeholderData: keepPreviousData,
  });
}

export function useGeneration(projectId: string | undefined, uid: string | undefined) {
  return useQuery({
    queryKey: ['generation', projectId, uid],
    queryFn: () => api.get<GenerationDetailDto>(`/v1/projects/${projectId}/generations/${uid}`),
    enabled: Boolean(projectId && uid),
    staleTime: Infinity,
  });
}

export function useRepeatedPrompts(projectId: string | undefined, qs: string | null) {
  return useQuery({
    queryKey: ['repeated-prompts', projectId, qs],
    queryFn: () => api.get<RepeatedPromptDto[]>(`/v1/projects/${projectId}/prompts/repeated?${qs}`),
    enabled: Boolean(projectId && qs),
    placeholderData: keepPreviousData,
  });
}

/* --------------------------------------------------------------- evaluations */

const criteriaKey = (projectId: string | undefined) => ['evaluation-criteria', projectId];

export function useCriteria(projectId: string | undefined) {
  return useQuery({
    queryKey: criteriaKey(projectId),
    queryFn: () => api.get<CriterionDto[]>(`/v1/projects/${projectId}/evaluation-criteria`),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
}

export function useEvaluationSummary(projectId: string | undefined, qs: string | null) {
  return useQuery({
    queryKey: ['evaluations', projectId, 'summary', qs],
    queryFn: () =>
      api.get<EvaluationSummaryDto>(`/v1/projects/${projectId}/evaluations/summary?${qs}`),
    enabled: Boolean(projectId && qs),
    placeholderData: keepPreviousData,
  });
}

export function useEvaluations(
  projectId: string | undefined,
  qs: string | null,
  filters: { criterion?: string; source?: string },
) {
  return useInfiniteQuery({
    queryKey: ['evaluations', projectId, 'list', qs, filters],
    queryFn: ({ pageParam }) =>
      api.get<EvaluationsPage>(
        `/v1/projects/${projectId}/evaluations?${withParams(qs ?? '', { ...filters, limit: '25', cursor: pageParam }).toString()}`,
      ),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(projectId && qs),
    placeholderData: keepPreviousData,
  });
}

/** Invalidates everything an evaluation change can affect (trace view, lists, charts). */
function useInvalidateEvaluations(projectId: string, traceId?: string) {
  const client = useQueryClient();
  return () =>
    Promise.all([
      traceId ? client.invalidateQueries({ queryKey: traceKey(projectId, traceId) }) : null,
      client.invalidateQueries({ queryKey: ['evaluations', projectId] }),
      client.invalidateQueries({ queryKey: ['traces', projectId] }),
    ]);
}

export function useRecordEvaluation(projectId: string, traceId: string) {
  const invalidate = useInvalidateEvaluations(projectId, traceId);
  return useMutation({
    mutationFn: (input: CreateEvaluationInput) =>
      api.post<EvaluationDto>(
        `/v1/projects/${projectId}/traces/${encodeURIComponent(traceId)}/evaluations`,
        input,
      ),
    onSuccess: invalidate,
  });
}

export function useDeleteEvaluation(projectId: string, traceId?: string) {
  const invalidate = useInvalidateEvaluations(projectId, traceId);
  return useMutation({
    mutationFn: (evaluationId: string) =>
      api.delete<void>(`/v1/projects/${projectId}/evaluations/${evaluationId}`),
    onSuccess: invalidate,
  });
}

export function useSaveCriterion(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: ({ id, input }: { id?: string; input: CriterionInput }) =>
      id
        ? api.put<CriterionDto>(`/v1/projects/${projectId}/evaluation-criteria/${id}`, input)
        : api.post<CriterionDto>(`/v1/projects/${projectId}/evaluation-criteria`, input),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: criteriaKey(projectId) }),
        client.invalidateQueries({ queryKey: ['evaluations', projectId] }),
      ]),
  });
}

export function useDeleteCriterion(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      api.delete<void>(`/v1/projects/${projectId}/evaluation-criteria/${id}`),
    onSuccess: () =>
      Promise.all([
        client.invalidateQueries({ queryKey: criteriaKey(projectId) }),
        client.invalidateQueries({ queryKey: ['evaluations', projectId] }),
      ]),
  });
}
