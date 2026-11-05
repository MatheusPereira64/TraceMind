'use client';

import { keepPreviousData, useInfiniteQuery, useQuery } from '@tanstack/react-query';
import type {
  BreakdownRow,
  CostsDto,
  DimensionsDto,
  Environment,
  ErrorType,
  ErrorsDto,
  OverviewDto,
  PerformanceDto,
  PricingRowDto,
  TimeseriesDto,
} from '@tracemind/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useMemo } from 'react';
import { api } from '@/lib/api-client';
import {
  browserTimeZone,
  resolveCustom,
  resolvePreset,
  RANGE_PRESETS,
  type RangePresetId,
} from '@/lib/time-range';

export interface AnalyticsFilters {
  projectId: string | undefined;
  range: RangePresetId | 'custom';
  fromDate?: string;
  toDate?: string;
  environment?: Environment;
  provider?: string;
  model?: string;
}

const isPreset = (value: string | null): value is RangePresetId =>
  RANGE_PRESETS.some((preset) => preset.id === value);

/**
 * Filters live in the URL so a dashboard view can be bookmarked or shared and survives reloads.
 */
export function useAnalyticsFilters(defaultProjectId: string | undefined) {
  const params = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters: AnalyticsFilters = useMemo(() => {
    const range = params.get('range');
    return {
      projectId: params.get('project') ?? defaultProjectId,
      range: range === 'custom' ? 'custom' : isPreset(range) ? range : '30d',
      fromDate: params.get('fromDate') ?? undefined,
      toDate: params.get('toDate') ?? undefined,
      environment: (params.get('env') as Environment | null) ?? undefined,
      provider: params.get('provider') ?? undefined,
      model: params.get('model') ?? undefined,
    };
  }, [params, defaultProjectId]);

  const update = useCallback(
    (changes: Record<string, string | undefined>) => {
      const next = new URLSearchParams(params.toString());
      for (const [key, value] of Object.entries(changes)) {
        if (value === undefined || value === '') next.delete(key);
        else next.set(key, value);
      }
      router.replace(`${pathname}?${next.toString()}`, { scroll: false });
    },
    [params, pathname, router],
  );

  return { filters, update };
}

/** Query string shared by all analytics endpoints. */
export function useAnalyticsQueryString(filters: AnalyticsFilters): string | null {
  return useMemo(() => {
    const range =
      filters.range === 'custom' && filters.fromDate && filters.toDate
        ? resolveCustom(filters.fromDate, filters.toDate)
        : resolvePreset(filters.range === 'custom' ? '30d' : filters.range);
    if (!range || !filters.projectId) return null;
    const query = new URLSearchParams({ from: range.from, to: range.to, tz: browserTimeZone() });
    if (filters.environment) query.set('environment', filters.environment);
    if (filters.provider) query.set('provider', filters.provider);
    if (filters.model) query.set('model', filters.model);
    return query.toString();
  }, [filters]);
}

function useAnalytics<T>(projectId: string | undefined, path: string, queryString: string | null) {
  return useQuery({
    queryKey: ['analytics', projectId, path, queryString],
    queryFn: () => api.get<T>(`/v1/projects/${projectId}/analytics/${path}?${queryString}`),
    enabled: Boolean(projectId && queryString),
    // Keep the previous chart on screen while a new filter loads instead of flashing a spinner.
    placeholderData: keepPreviousData,
    refetchInterval: 60_000,
  });
}

export const useOverview = (projectId?: string, qs?: string | null) =>
  useAnalytics<OverviewDto>(projectId, 'overview', qs ?? null);
export const useTimeseries = (projectId?: string, qs?: string | null) =>
  useAnalytics<TimeseriesDto>(projectId, 'timeseries', qs ?? null);
export const useBreakdown = (
  projectId?: string,
  qs?: string | null,
  by: 'model' | 'provider' = 'model',
) => useAnalytics<BreakdownRow[]>(projectId, 'breakdown', qs ? `${qs}&by=${by}` : null);
export const useCosts = (projectId?: string, qs?: string | null) =>
  useAnalytics<CostsDto>(projectId, 'costs', qs ?? null);
export const usePerformance = (projectId?: string, qs?: string | null) =>
  useAnalytics<PerformanceDto>(projectId, 'performance', qs ?? null);

export function useErrors(
  projectId: string | undefined,
  qs: string | null,
  type: ErrorType | undefined,
) {
  return useInfiniteQuery({
    queryKey: ['analytics', projectId, 'errors', qs, type],
    queryFn: ({ pageParam }) => {
      const query = new URLSearchParams(qs ?? '');
      if (type) query.set('type', type);
      if (pageParam) query.set('cursor', pageParam);
      return api.get<ErrorsDto>(`/v1/projects/${projectId}/analytics/errors?${query.toString()}`);
    },
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    enabled: Boolean(projectId && qs),
    placeholderData: keepPreviousData,
  });
}

export function useDimensions(projectId: string | undefined) {
  return useQuery({
    queryKey: ['analytics', projectId, 'dimensions'],
    queryFn: () => api.get<DimensionsDto>(`/v1/projects/${projectId}/analytics/dimensions`),
    enabled: Boolean(projectId),
    staleTime: 60_000,
  });
}

export function usePricing() {
  return useQuery({
    queryKey: ['pricing'],
    queryFn: () => api.get<PricingRowDto[]>('/v1/pricing'),
    staleTime: 5 * 60_000,
  });
}
