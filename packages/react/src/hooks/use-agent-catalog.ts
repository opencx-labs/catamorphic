"use client";

import type { paths } from "@catamorphic/api-client";
import { useQuery } from "@tanstack/react-query";
import { assertApiOk, runWithCatamorphicError } from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export type AgentCatalog =
  paths["/api/projects/{projectId}/agent-catalog"]["get"]["responses"][200]["content"]["application/json"];

/** The authority's permitted roster and defaults, shared by all host UIs. */
export function useAgentCatalog(projectId: string | undefined) {
  const { apiClient } = useCatamorphic();
  return useQuery({
    queryKey: ["cat", "project", projectId, "agent-catalog"],
    enabled: Boolean(projectId),
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId) throw new Error("projectId is required");
        return assertApiOk(
          await apiClient.GET("/api/projects/{projectId}/agent-catalog", {
            params: { path: { projectId } },
          }),
          "Agents could not be loaded",
        );
      }),
  });
}
