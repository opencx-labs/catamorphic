"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { AttachedPlugin } from "../types.js";

/**
 * Plugins currently attached to a project.
 */
export function useProjectPlugins(
  projectId: string | undefined,
): UseQueryResult<AttachedPlugin[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<AttachedPlugin[], CatamorphicError>({
    queryKey: ["cat", "project", projectId, "plugins"],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET(
          "/api/projects/{projectId}/plugins",
          {
            params: { path: { projectId: projectId as string } },
          },
        );
        return assertApiOk(result, "Plugins response empty");
      }),
    enabled: Boolean(projectId),
  });
}
