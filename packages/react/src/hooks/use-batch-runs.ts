"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { BatchRun, BatchRunStatus, BatchRunsList } from "../types.js";

export interface UseBatchRunsOptions {
  projectId: string | undefined;
  workflowName: string | undefined;
  limit?: number;
  offset?: number;
  activeRefetchInterval?: number | false;
}

const ACTIVE_STATUSES = new Set<BatchRunStatus>([
  "pending",
  "sourcing",
  "running",
  "sinking",
]);

export function useBatchRuns({
  projectId,
  workflowName,
  limit,
  offset,
  activeRefetchInterval = 2_000,
}: UseBatchRunsOptions): UseQueryResult<BatchRunsList, CatamorphicError> {
  const { apiClient } = useCatamorphic();

  return useQuery<BatchRunsList, CatamorphicError>({
    queryKey: [
      "cat",
      "project",
      projectId,
      "workflow",
      workflowName,
      "batch-runs",
      { limit, offset },
    ],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId || !workflowName) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId and workflowName are required",
          });
        }
        const result = await apiClient.GET(
          "/api/projects/{projectId}/workflows/{name}/batch-runs",
          {
            params: {
              path: { projectId, name: workflowName },
              query: { limit, offset },
            },
          },
        );
        return assertApiOk(result, "Batch runs response empty");
      }),
    enabled: Boolean(projectId && workflowName),
    refetchInterval: ({ state }) => {
      if (activeRefetchInterval === false) return false;
      const hasActiveRun = state.data?.items.some((run: BatchRun) =>
        ACTIVE_STATUSES.has(run.status),
      );
      return hasActiveRun ? activeRefetchInterval : false;
    },
  });
}
