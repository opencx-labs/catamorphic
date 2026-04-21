"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { RunDetail } from "../types.js";

export function useWorkflowRun(
  runId: string | undefined,
): UseQueryResult<RunDetail, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<RunDetail, CatamorphicError>({
    queryKey: ["cat", "run", runId],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!runId) {
          throw new CatamorphicError({
            code: "validation",
            message: "runId is required",
          });
        }
        const result = await apiClient.GET("/api/runs/{runId}", {
          params: { path: { runId } },
        });
        return assertApiOk(result, "Run not found");
      }),
    enabled: Boolean(runId),
  });
}
