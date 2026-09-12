"use client";
import { useQuery } from "@tanstack/react-query";
import { assertApiOk, runWithCatamorphicError } from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

/** Retained outputs for a session, independent of which tabs are open. */
export function useSessionArtifacts(
  projectId: string | undefined,
  sessionId: string | undefined,
  options: { refetchInterval?: number | false } = {},
) {
  const { apiClient } = useCatamorphic();
  return useQuery({
    queryKey: [
      "cat",
      "project",
      projectId,
      "agent",
      "session",
      sessionId,
      "artifacts",
    ],
    enabled: Boolean(projectId && sessionId),
    refetchInterval: options.refetchInterval ?? false,
    queryFn: () =>
      runWithCatamorphicError(async () => {
        if (!projectId || !sessionId) throw new Error("Select a session");
        return assertApiOk(
          await apiClient.GET(
            "/api/projects/{projectId}/agent/sessions/{sessionId}/artifacts",
            { params: { path: { projectId, sessionId } } },
          ),
          "Could not load session artifacts",
        );
      }),
  });
}
