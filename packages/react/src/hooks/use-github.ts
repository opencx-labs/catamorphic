"use client";

import {
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export interface GithubStatus {
  connected: boolean;
  login?: string;
}

export interface GithubRepoSummary {
  id: number;
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  description: string | null;
  pushedAt: string | null;
}

export function useGithubStatus(): UseQueryResult<
  GithubStatus,
  CatamorphicError
> {
  const { apiClient } = useCatamorphic();
  return useQuery<GithubStatus, CatamorphicError>({
    queryKey: ["cat", "github", "status"],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET("/api/github/status");
        return assertApiOk(result, "GitHub status response empty");
      }),
  });
}

export function useGithubRepos(opts?: {
  enabled?: boolean;
}): UseQueryResult<GithubRepoSummary[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<GithubRepoSummary[], CatamorphicError>({
    queryKey: ["cat", "github", "repos"],
    enabled: opts?.enabled ?? true,
    // Users leave for github.com to grant repo access and come back. Focus
    // events are unreliable in Electron, so while the list is empty poll on
    // a slow interval; once repos exist, stop.
    refetchOnWindowFocus: true,
    staleTime: 0,
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) === 0 ? 4000 : false,
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET("/api/github/repos");
        return assertApiOk(result, "GitHub repos response empty");
      }),
  });
}

export interface ImportGithubRepoInput {
  fullName: string;
  name?: string;
}

export function useImportGithubRepo(): UseMutationResult<
  { id: string; name: string },
  CatamorphicError,
  ImportGithubRepoInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<
    { id: string; name: string },
    CatamorphicError,
    ImportGithubRepoInput
  >({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST("/api/github/import", {
          body: input,
        });
        return assertApiOk(result, "GitHub import response empty");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
    },
  });
}
