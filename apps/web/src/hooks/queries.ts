'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type {
  ApiKeyDto,
  CreateApiKeyInput,
  CreateOrganizationInput,
  CreateProjectInput,
  CreatedApiKeyDto,
  IngestionStatusDto,
  LoginInput,
  MeDto,
  OrganizationDto,
  ProjectDto,
  RegisterInput,
  SessionDto,
  UpdateProjectInput,
} from '@tracemind/shared';
import { api, ApiError } from '@/lib/api-client';

export const queryKeys = {
  me: ['me'] as const,
  projects: (organizationId: string) => ['organizations', organizationId, 'projects'] as const,
  project: (projectId: string) => ['projects', projectId] as const,
  apiKeys: (projectId: string) => ['projects', projectId, 'api-keys'] as const,
  ingestion: (projectId: string) => ['projects', projectId, 'ingestion'] as const,
};

/* -------------------------------------------------------------------- session */

export function useMe() {
  return useQuery({
    queryKey: queryKeys.me,
    queryFn: () => api.get<MeDto>('/v1/auth/me'),
    // 401 is an answer ("signed out"), not a transient failure.
    retry: (count, error) => !(error instanceof ApiError && error.status === 401) && count < 2,
    staleTime: 60_000,
  });
}

function useSessionMutation<TInput>(path: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: TInput) => api.post<SessionDto>(path, input),
    onSuccess: (session) => {
      client.setQueryData<MeDto>(queryKeys.me, {
        user: session.user,
        organizations: session.organizations,
      });
    },
  });
}

export const useLogin = () => useSessionMutation<LoginInput>('/v1/auth/login');
export const useRegister = () => useSessionMutation<RegisterInput>('/v1/auth/register');

export function useLogout() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.post<void>('/v1/auth/logout'),
    onSettled: () => client.clear(),
  });
}

/* --------------------------------------------------------------- organizations */

export function useCreateOrganization() {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateOrganizationInput) =>
      api.post<OrganizationDto>('/v1/organizations', input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.me }),
  });
}

/* -------------------------------------------------------------------- projects */

export function useProjects(organizationId: string | undefined) {
  return useQuery({
    queryKey: queryKeys.projects(organizationId ?? 'none'),
    queryFn: () => api.get<ProjectDto[]>(`/v1/organizations/${organizationId}/projects`),
    enabled: Boolean(organizationId),
  });
}

export function useProject(projectId: string) {
  return useQuery({
    queryKey: queryKeys.project(projectId),
    queryFn: () => api.get<ProjectDto>(`/v1/projects/${projectId}`),
  });
}

export function useCreateProject(organizationId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateProjectInput) =>
      api.post<ProjectDto>(`/v1/organizations/${organizationId}/projects`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.projects(organizationId) }),
  });
}

export function useArchiveProject(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: () => api.delete<ProjectDto>(`/v1/projects/${projectId}`),
    onSuccess: (project) => {
      client.setQueryData(queryKeys.project(projectId), project);
      return client.invalidateQueries({ queryKey: queryKeys.projects(project.organizationId) });
    },
  });
}

/* -------------------------------------------------------------------- api keys */

export function useApiKeys(projectId: string) {
  return useQuery({
    queryKey: queryKeys.apiKeys(projectId),
    queryFn: () => api.get<ApiKeyDto[]>(`/v1/projects/${projectId}/api-keys`),
  });
}

export function useCreateApiKey(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateApiKeyInput) =>
      api.post<CreatedApiKeyDto>(`/v1/projects/${projectId}/api-keys`, input),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.apiKeys(projectId) }),
  });
}

export function useRevokeApiKey(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (keyId: string) =>
      api.delete<ApiKeyDto>(`/v1/projects/${projectId}/api-keys/${keyId}`),
    onSuccess: () => client.invalidateQueries({ queryKey: queryKeys.apiKeys(projectId) }),
  });
}

/* ------------------------------------------------------------------- ingestion */

/** Polls while the page is open so the first trace shows up without a reload. */
export function useIngestionStatus(projectId: string | undefined, pollMs = 5_000) {
  return useQuery({
    queryKey: queryKeys.ingestion(projectId ?? 'none'),
    queryFn: () => api.get<IngestionStatusDto>(`/v1/projects/${projectId}/ingestion`),
    enabled: Boolean(projectId),
    refetchInterval: pollMs,
  });
}

export function useUpdateProject(projectId: string) {
  const client = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateProjectInput) =>
      api.patch<ProjectDto>(`/v1/projects/${projectId}`, input),
    onSuccess: (project) => {
      client.setQueryData(queryKeys.project(projectId), project);
      return client.invalidateQueries({ queryKey: queryKeys.projects(project.organizationId) });
    },
  });
}
