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

/** A code host with the caller's personal connection to it (ADR 0177). */
export interface CodeHostSummary {
  provider: string;
  displayName: string;
  connection: {
    id: string;
    status: string;
    account: unknown;
  } | null;
}

export interface CodeHostRepositorySummary {
  fullName: string;
  name: string;
  owner: string;
  private: boolean;
  defaultBranch: string;
  cloneUrl: string;
  description: string | null;
  pushedAt: string | null;
}

/** The host's code hosts and the caller's connection to each. */
export function useCodeHosts(): UseQueryResult<
  CodeHostSummary[],
  CatamorphicError
> {
  const { apiClient } = useCatamorphic();
  return useQuery<CodeHostSummary[], CatamorphicError>({
    queryKey: ["cat", "code-hosts"],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET("/api/code-hosts");
        return assertApiOk(result, "Code hosts response empty");
      }),
  });
}

/** Repositories the caller's personal connection to `provider` reaches. */
export function useCodeHostRepositories(
  provider: string,
  opts?: { enabled?: boolean },
): UseQueryResult<CodeHostRepositorySummary[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<CodeHostRepositorySummary[], CatamorphicError>({
    queryKey: ["cat", "code-hosts", provider, "repositories"],
    enabled: opts?.enabled ?? true,
    // People leave for the code host to grant repository access and come
    // back. Focus events are unreliable in Electron, so while the list is
    // empty poll on a slow interval; once repositories exist, stop.
    refetchOnWindowFocus: true,
    staleTime: 0,
    refetchInterval: (query) =>
      (query.state.data?.length ?? 0) === 0 ? 4000 : false,
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET(
          "/api/code-hosts/{provider}/repositories",
          { params: { path: { provider } } },
        );
        return assertApiOk(result, "Repositories response empty");
      }),
  });
}

export interface ImportRepositoryInput {
  provider: string;
  fullName: string;
  name?: string;
}

/** Clone a repository into a new project it stays attached to. */
export function useImportRepository(): UseMutationResult<
  { id: string; name: string },
  CatamorphicError,
  ImportRepositoryInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<
    { id: string; name: string },
    CatamorphicError,
    ImportRepositoryInput
  >({
    mutationFn: ({ provider, ...body }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/code-hosts/{provider}/import",
          { params: { path: { provider } }, body },
        );
        return assertApiOk(result, "Import response empty");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["cat", "projects"] });
    },
  });
}
