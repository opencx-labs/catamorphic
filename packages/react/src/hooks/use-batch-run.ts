"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { BatchRun, BatchRunStatus } from "../types.js";

export interface UseBatchRunOptions {
  batchRunId: string | undefined;
  activeRefetchInterval?: number | false;
}

const ACTIVE_STATUSES = new Set<BatchRunStatus>([
  "pending",
  "sourcing",
  "running",
  "sinking",
]);

export function useBatchRun({
  batchRunId,
  activeRefetchInterval = 2_000,
}: UseBatchRunOptions): UseQueryResult<BatchRun, CatamorphicError> {
  const { apiClient } = useCatamorphic();

  return useQuery<BatchRun, CatamorphicError>({
    queryKey: ["cat", "batch-run", batchRunId],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!batchRunId) {
          throw new CatamorphicError({
            code: "validation",
            message: "batchRunId is required",
          });
        }
        const result = await apiClient.GET("/api/batch-runs/{batchRunId}", {
          params: { path: { batchRunId } },
        });
        return assertApiOk(result, "Batch run not found");
      }),
    enabled: Boolean(batchRunId),
    refetchInterval: ({ state }) => {
      if (activeRefetchInterval === false) return false;
      return state.data && ACTIVE_STATUSES.has(state.data.status)
        ? activeRefetchInterval
        : false;
    },
  });
}
