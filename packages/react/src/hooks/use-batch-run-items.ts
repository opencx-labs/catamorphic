"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { BatchItem, BatchItemStatus, BatchItemsList } from "../types.js";

export interface UseBatchRunItemsOptions {
  batchRunId: string | undefined;
  status?: BatchItemStatus;
  limit?: number;
  offset?: number;
  active?: boolean;
  activeRefetchInterval?: number | false;
}

const ACTIVE_STATUSES = new Set<BatchItemStatus>([
  "pending",
  "running",
  "waiting",
]);

export function useBatchRunItems({
  batchRunId,
  status,
  limit,
  offset,
  active = false,
  activeRefetchInterval = 2_000,
}: UseBatchRunItemsOptions): UseQueryResult<BatchItemsList, CatamorphicError> {
  const { apiClient } = useCatamorphic();

  return useQuery<BatchItemsList, CatamorphicError>({
    queryKey: [
      "cat",
      "batch-run",
      batchRunId,
      "items",
      { status, limit, offset },
    ],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!batchRunId) {
          throw new CatamorphicError({
            code: "validation",
            message: "batchRunId is required",
          });
        }
        const result = await apiClient.GET(
          "/api/batch-runs/{batchRunId}/items",
          {
            params: {
              path: { batchRunId },
              query: { status, limit, offset },
            },
          },
        );
        return assertApiOk(result, "Batch run items response empty");
      }),
    enabled: Boolean(batchRunId),
    refetchInterval: ({ state }) => {
      if (activeRefetchInterval === false) return false;
      const hasActiveItem = state.data?.items.some((item: BatchItem) =>
        ACTIVE_STATUSES.has(item.status),
      );
      return active || hasActiveItem ? activeRefetchInterval : false;
    },
  });
}
