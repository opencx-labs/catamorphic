"use client";
import { useQueries } from "@tanstack/react-query";
import { assertApiOk, runWithCatamorphicError } from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

/** One cached metadata request per app, shared by tabs, lists and chat surfaces. */
export function useAppPresentations(
  projectId: string | undefined,
  appNames: string[],
) {
  const { apiClient } = useCatamorphic();
  return useQueries({
    queries: [...new Set(appNames)].map((appName) => ({
      queryKey: ["cat", "project", projectId, "app", appName, "presentation"],
      queryFn: () =>
        runWithCatamorphicError(async () => {
          if (!projectId) throw new Error("Select a project");
          return assertApiOk(
            await apiClient.GET(
              "/api/projects/{projectId}/apps/{appName}/presentation",
              { params: { path: { projectId, appName } } },
            ),
            "Could not load app presentation",
          );
        }),
      enabled: Boolean(projectId),
      staleTime: 3000,
      refetchInterval: 5000,
      retry: false,
    })),
  });
}
