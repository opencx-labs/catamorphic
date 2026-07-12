"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { RunsList } from "../types.js";

export interface UseWorkflowRunsOptions {
  limit?: number;
  offset?: number;
  mode?: "test" | "production";
}

export function useWorkflowRuns(
  projectId: string | undefined,
  name: string | undefined,
  options: UseWorkflowRunsOptions = {},
): UseQueryResult<RunsList, CatamorphicError> {
  const { apiClient } = useCatamorphic();
  const { limit, offset, mode } = options;
  return useQuery<RunsList, CatamorphicError>({
    queryKey: [
      "cat",
      "project",
      projectId,
      "workflow",
      name,
      "runs",
      { limit, offset, mode },
    ],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId || !name) {
          throw new CatamorphicError({
            code: "validation",
            message: "projectId and name are required",
          });
        }
        const result = await apiClient.GET(
          "/api/projects/{projectId}/workflows/{name}/runs",
          {
            params: {
              path: { projectId, name },
              query: { limit, offset, mode },
            },
          },
        );
        return assertApiOk(result, "Runs response empty");
      }),
    enabled: Boolean(projectId && name),
  });
}
