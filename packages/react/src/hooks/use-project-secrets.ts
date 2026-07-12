"use client";

import { type UseQueryResult, useQuery } from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";
import type { Secret } from "../types.js";

/**
 * Project secrets (status only — values never leave the server).
 */
export function useProjectSecrets(
  projectId: string | undefined,
  environment: "test" | "production" = "production",
): UseQueryResult<Secret[], CatamorphicError> {
  const { apiClient } = useCatamorphic();
  return useQuery<Secret[], CatamorphicError>({
    queryKey: ["cat", "project", projectId, "secrets", environment],
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET(
          "/api/projects/{projectId}/secrets",
          {
            params: {
              path: { projectId: projectId as string },
              query: { environment },
            },
          },
        );
        return assertApiOk(result, "Secrets response empty");
      }),
    enabled: Boolean(projectId),
  });
}
