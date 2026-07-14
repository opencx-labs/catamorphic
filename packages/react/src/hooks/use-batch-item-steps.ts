"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { BatchItemStep } from "../types.js";

export interface UseBatchItemStepsOptions {
  batchRunId?: string;
  itemId?: string;
  active?: boolean;
}

export function useBatchItemSteps({
  batchRunId,
  itemId,
  active = false,
}: UseBatchItemStepsOptions): UseQueryResult<
  BatchItemStep[],
  CatamorphicError
> {
  const { apiClient } = useCatamorphic();
  return useQuery<BatchItemStep[], CatamorphicError>({
    queryKey: ["cat", "batch-run", batchRunId, "item", itemId, "steps"],
    enabled: Boolean(batchRunId && itemId),
    refetchInterval: active ? 1_000 : false,
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!batchRunId || !itemId) return [];
        const result = await apiClient.GET(
          "/api/batch-runs/{batchRunId}/items/{itemId}/steps",
          { params: { path: { batchRunId, itemId } } },
        );
        return assertApiOk(result, "Load batch item steps failed");
      }),
  });
}
