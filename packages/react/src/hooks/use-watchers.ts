"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { assertApiOk, runWithCatamorphicError } from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export const watcherKeys = {
  list: (projectId: string | undefined, sessionId: string | undefined) =>
    [
      "cat",
      "project",
      projectId,
      "agent",
      "session",
      sessionId,
      "watchers",
    ] as const,
};

export function useWatchers(
  projectId: string | undefined,
  sessionId: string | undefined,
) {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  const key = watcherKeys.list(projectId, sessionId);
  const query = useQuery({
    queryKey: key,
    enabled: Boolean(projectId && sessionId),
    refetchInterval: 5_000,
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/watchers",
          {
            params: {
              path: {
                projectId: projectId as string,
                sessionId: sessionId as string,
              },
            },
          },
        );
        return assertApiOk(result, "List watchers failed");
      }),
  });
  const stop = useMutation({
    mutationFn: (watcherId: string) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.DELETE(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/watchers/{watcherId}",
          {
            params: {
              path: {
                projectId: projectId as string,
                sessionId: sessionId as string,
                watcherId,
              },
            },
          },
        );
        return assertApiOk(result, "Stop watcher failed");
      }),
    onSettled: () => queryClient.invalidateQueries({ queryKey: key }),
  });
  return { ...query, stop };
}
