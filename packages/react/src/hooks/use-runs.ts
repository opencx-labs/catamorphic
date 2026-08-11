"use client";

import {
  type QueryClient,
  type UseMutationResult,
  type UseQueryResult,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
  toCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type {
  CancelRunByKeyInput,
  CancelRunInput,
  Run,
  RunDetail,
  RunItemStatus,
  RunItemStep,
  RunItemsList,
  RunsList,
  SignalRunInput,
  SubmitRunInput,
  TriggeredRun,
  TriggerRunInput,
} from "../types.js";

const DEFAULT_POLL_INTERVAL = 2_000;

export const runKeys = {
  all: ["cat", "run"] as const,
  lists: () => [...runKeys.all, "list"] as const,
  list: (args: {
    projectId: string | undefined;
    workflowName: string | undefined;
    limit: number | undefined;
    offset: number | undefined;
  }) => [...runKeys.lists(), args] as const,
  details: () => [...runKeys.all, "detail"] as const,
  detail: (runId: string | undefined) => [...runKeys.details(), runId] as const,
  items: (runId: string | undefined) =>
    [...runKeys.all, "items", runId] as const,
  itemList: (args: {
    runId: string | undefined;
    workflowStepAttemptId: string | undefined;
    status: RunItemStatus | undefined;
    limit: number | undefined;
    offset: number | undefined;
  }) =>
    [
      ...runKeys.items(args.runId),
      args.workflowStepAttemptId,
      { status: args.status, limit: args.limit, offset: args.offset },
    ] as const,
  itemSteps: (runId: string | undefined) =>
    [...runKeys.all, "item-steps", runId] as const,
  itemStepList: (args: {
    runId: string | undefined;
    workflowStepAttemptId: string | undefined;
    itemId: string | undefined;
  }) =>
    [
      ...runKeys.itemSteps(args.runId),
      args.workflowStepAttemptId,
      args.itemId,
    ] as const,
};

function shouldPollRun(run: Run): boolean {
  return (
    run.status === "pending" ||
    run.status === "running" ||
    run.status === "canceling" ||
    (run.status === "waiting" && run.phase === "child")
  );
}

function shouldPollRunScope({
  run,
  workflowStepAttemptId,
}: {
  run: Run | undefined;
  workflowStepAttemptId: string | undefined;
}): boolean {
  if (
    !run ||
    !workflowStepAttemptId ||
    !["pending", "running", "waiting", "canceling"].includes(run.status)
  ) {
    return false;
  }
  return run.batchScopes.some(
    (scope) =>
      scope.workflowStepAttemptId === workflowStepAttemptId &&
      (scope.status === "pending" ||
        scope.status === "running" ||
        scope.status === "waiting"),
  );
}

function updateRunCaches(queryClient: QueryClient, run: Run): void {
  queryClient.setQueryData<RunDetail>(runKeys.detail(run.id), (previous) =>
    previous ? { ...previous, ...run } : previous,
  );
  queryClient.setQueriesData<RunsList>(
    { queryKey: runKeys.lists() },
    (previous) =>
      previous
        ? {
            ...previous,
            items: previous.items.map((item) =>
              item.id === run.id ? run : item,
            ),
          }
        : previous,
  );
}

async function refreshRunCaches(
  queryClient: QueryClient,
  run: Run,
): Promise<void> {
  updateRunCaches(queryClient, run);
  await Promise.all([
    queryClient.invalidateQueries({ queryKey: runKeys.detail(run.id) }),
    queryClient.invalidateQueries({ queryKey: runKeys.lists() }),
    queryClient.invalidateQueries({ queryKey: runKeys.items(run.id) }),
    queryClient.invalidateQueries({ queryKey: runKeys.itemSteps(run.id) }),
  ]);
}

interface PollingOptions {
  pollInterval?: number | false;
}

export interface UseRunOptions extends PollingOptions {
  runId: string | undefined;
}

export function useRun({
  runId,
  pollInterval = DEFAULT_POLL_INTERVAL,
}: UseRunOptions): UseQueryResult<RunDetail, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<RunDetail, CatamorphicError>({
    queryKey: runKeys.detail(runId),
    enabled: Boolean(runId),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!runId) {
          throw new CatamorphicError({
            code: "validation",
            message: "runId is required",
          });
        }
        return assertApiOk(
          await apiClient.GET("/api/runs/{runId}", {
            params: { path: { runId } },
          }),
          "Run not found",
        );
      }),
    refetchInterval: ({ state }) =>
      pollInterval !== false && state.data && shouldPollRun(state.data)
        ? pollInterval
        : false,
  });
}

export interface UseRunsOptions extends PollingOptions {
  projectId: string | undefined;
  workflowName?: string;
  limit?: number;
  offset?: number;
}

export function useRuns({
  projectId,
  workflowName,
  limit,
  offset,
  pollInterval = DEFAULT_POLL_INTERVAL,
}: UseRunsOptions): UseQueryResult<RunsList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<RunsList, CatamorphicError>({
    queryKey: runKeys.list({
      projectId,
      workflowName,
      limit,
      offset,
    }),
    enabled: Boolean(projectId && workflowName),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId || !workflowName) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId and workflowName are required",
          });
        }
        return assertApiOk(
          await apiClient.GET(
            "/api/projects/{projectId}/workflows/{name}/runs",
            {
              params: {
                path: { projectId, name: workflowName },
                query: { limit, offset },
              },
            },
          ),
          "Runs response empty",
        );
      }),
    refetchInterval: ({ state }) =>
      pollInterval !== false && state.data?.items.some(shouldPollRun)
        ? pollInterval
        : false,
  });
}

export interface UseTriggerRunOptions {
  projectId: string;
  workflowName: string;
}

export function useTriggerRun({
  projectId,
  workflowName,
}: UseTriggerRunOptions): UseMutationResult<
  TriggeredRun,
  CatamorphicError,
  TriggerRunInput | undefined
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    // Raw fetch: openapi-fetch cannot infer a body that mixes the recursive
    // JsonValueInput schema with sibling properties. Same reason as
    // useSubmitRunInput below.
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const url = `${apiClient.baseUrl}/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowName)}/runs`;
        const response = await apiClient.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input ?? {}),
        });
        if (!response.ok) {
          const body = await response
            .json()
            .catch(() => response.text().catch(() => ""));
          throw toCatamorphicError({
            response,
            body,
            fallbackMessage: "Trigger run failed",
          });
        }
        return response.json();
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: runKeys.lists() });
    },
  });
}

export interface UseRunMutationOptions {
  runId: string;
}

export function useCancelRun({
  runId,
}: UseRunMutationOptions): UseMutationResult<
  Run,
  CatamorphicError,
  CancelRunInput | undefined
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input) =>
      runWithCatamorphicError(async () =>
        assertApiOk(
          await apiClient.POST("/api/runs/{runId}/cancel", {
            params: { path: { runId } },
            body: input ?? {},
          }),
          "Cancel run failed",
        ),
      ),
    onSuccess: (run) => refreshRunCaches(queryClient, run),
  });
}

export function usePauseRunProcessing({
  runId,
}: UseRunMutationOptions): UseMutationResult<Run, CatamorphicError, void> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      runWithCatamorphicError(async () =>
        assertApiOk(
          await apiClient.POST("/api/runs/{runId}/pause", {
            params: { path: { runId } },
          }),
          "Pause run processing failed",
        ),
      ),
    onSuccess: (run) => refreshRunCaches(queryClient, run),
  });
}

export function useResumeRunProcessing({
  runId,
}: UseRunMutationOptions): UseMutationResult<Run, CatamorphicError, void> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: () =>
      runWithCatamorphicError(async () =>
        assertApiOk(
          await apiClient.POST("/api/runs/{runId}/resume", {
            params: { path: { runId } },
          }),
          "Resume run processing failed",
        ),
      ),
    onSuccess: (run) => refreshRunCaches(queryClient, run),
  });
}

export interface UseSubmitRunInputOptions extends UseRunMutationOptions {
  pauseId: string;
}

export function useSubmitRunInput({
  runId,
  pauseId,
}: UseSubmitRunInputOptions): UseMutationResult<
  Run,
  CatamorphicError,
  SubmitRunInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<Run, CatamorphicError, SubmitRunInput>({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const url = `${apiClient.baseUrl}/api/runs/${encodeURIComponent(runId)}/pauses/${encodeURIComponent(pauseId)}/resume`;
        const response = await apiClient.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) {
          const body = await response
            .json()
            .catch(() => response.text().catch(() => ""));
          throw toCatamorphicError({
            response,
            body,
            fallbackMessage: "Submit run input failed",
          });
        }
        return response.json();
      }),
    onSuccess: (run) => refreshRunCaches(queryClient, run),
  });
}

export interface UseKeyedRunMutationOptions {
  projectId: string;
  workflowName: string;
}

/** Delivers an external event to whichever run awaits a named signal for a key. */
export function useSignalRun({
  projectId,
  workflowName,
}: UseKeyedRunMutationOptions): UseMutationResult<
  Run,
  CatamorphicError,
  SignalRunInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<Run, CatamorphicError, SignalRunInput>({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const url = `${apiClient.baseUrl}/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowName)}/signals`;
        const response = await apiClient.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) {
          const body = await response
            .json()
            .catch(() => response.text().catch(() => ""));
          throw toCatamorphicError({
            response,
            body,
            fallbackMessage: "Signal run failed",
          });
        }
        return response.json();
      }),
    onSuccess: (run) => refreshRunCaches(queryClient, run),
  });
}

/** Ends the live journey for a key. Resolves null when none was live. */
export function useCancelRunByKey({
  projectId,
  workflowName,
}: UseKeyedRunMutationOptions): UseMutationResult<
  Run | null,
  CatamorphicError,
  CancelRunByKeyInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<Run | null, CatamorphicError, CancelRunByKeyInput>({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const url = `${apiClient.baseUrl}/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflowName)}/cancellations`;
        const response = await apiClient.fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(input),
        });
        if (!response.ok) {
          const body = await response
            .json()
            .catch(() => response.text().catch(() => ""));
          throw toCatamorphicError({
            response,
            body,
            fallbackMessage: "Cancel run failed",
          });
        }
        return response.status === 204 ? null : await response.json();
      }),
    onSuccess: (run) => {
      if (run) refreshRunCaches(queryClient, run);
    },
  });
}

export interface UseRunItemsOptions extends PollingOptions {
  run: Run | undefined;
  workflowStepAttemptId: string | undefined;
  status?: RunItemStatus;
  limit?: number;
  offset?: number;
}

export function useRunItems({
  run,
  workflowStepAttemptId,
  status,
  limit,
  offset,
  pollInterval = DEFAULT_POLL_INTERVAL,
}: UseRunItemsOptions): UseQueryResult<RunItemsList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const runId = run?.id;
  return useQuery<RunItemsList, CatamorphicError>({
    queryKey: runKeys.itemList({
      runId,
      workflowStepAttemptId,
      status,
      limit,
      offset,
    }),
    enabled: Boolean(runId && workflowStepAttemptId),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!runId || !workflowStepAttemptId) {
          throw new CatamorphicError({
            code: "validation",
            message: "runId and workflowStepAttemptId are required",
          });
        }
        return assertApiOk(
          await apiClient.GET(
            "/api/runs/{runId}/steps/{workflowStepAttemptId}/items",
            {
              params: {
                path: { runId, workflowStepAttemptId },
                query: { status, limit, offset },
              },
            },
          ),
          "Run items response empty",
        );
      }),
    refetchInterval: () => {
      if (pollInterval === false) return false;
      return shouldPollRunScope({ run, workflowStepAttemptId })
        ? pollInterval
        : false;
    },
  });
}

export interface UseRunItemStepsOptions extends PollingOptions {
  run: Run | undefined;
  workflowStepAttemptId: string | undefined;
  itemId: string | undefined;
}

export function useRunItemSteps({
  run,
  workflowStepAttemptId,
  itemId,
  pollInterval = DEFAULT_POLL_INTERVAL,
}: UseRunItemStepsOptions): UseQueryResult<RunItemStep[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const runId = run?.id;
  return useQuery<RunItemStep[], CatamorphicError>({
    queryKey: runKeys.itemStepList({
      runId,
      workflowStepAttemptId,
      itemId,
    }),
    enabled: Boolean(runId && workflowStepAttemptId && itemId),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!runId || !workflowStepAttemptId || !itemId) {
          throw new CatamorphicError({
            code: "validation",
            message: "runId, workflowStepAttemptId, and itemId are required",
          });
        }
        return assertApiOk(
          await apiClient.GET(
            "/api/runs/{runId}/steps/{workflowStepAttemptId}/items/{itemId}/steps",
            {
              params: {
                path: { runId, workflowStepAttemptId, itemId },
              },
            },
          ),
          "Run item steps response empty",
        );
      }),
    refetchInterval: () => {
      if (pollInterval === false) return false;
      return shouldPollRunScope({
        run,
        workflowStepAttemptId,
      })
        ? pollInterval
        : false;
    },
  });
}
