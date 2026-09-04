"use client";

import {
  type UseMutationResult,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import {
  assertApiOk,
  type CatamorphicError,
  runWithCatamorphicError,
} from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

export interface ArchiveAgentSessionInput {
  sessionId: string;
  confirmStop?: boolean;
}

export type ArchiveAgentSessionResult = {
  impact: {
    sessionIds: string[];
    runningSessionIds: string[];
    activeWatcherCount: number;
    activeProcessCount: number;
    requiresConfirmation: boolean;
  };
  sessions: Array<{ id: string }>;
};

/** Stop and archive a session tree, requiring confirmation only for live work. */
export function useArchiveAgentSession(
  projectId: string | undefined,
): UseMutationResult<
  ArchiveAgentSessionResult,
  CatamorphicError,
  ArchiveAgentSessionInput
> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ sessionId, confirmStop }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/archive",
          {
            params: { path: { projectId: projectId as string, sessionId } },
            body: { confirmStop },
          },
        );
        return assertApiOk(result, "Archive agent session failed");
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "sessions"],
      });
    },
  });
}

/** Restore an archived session tree to navigation; later work re-anchors. */
export function useUnarchiveAgentSession(
  projectId: string | undefined,
): UseMutationResult<Array<{ id: string }>, CatamorphicError, string> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (sessionId) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/unarchive",
          {
            params: { path: { projectId: projectId as string, sessionId } },
          },
        );
        return assertApiOk(result, "Unarchive agent session failed");
      }),
    onSuccess: () => {
      void queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "sessions"],
      });
    },
  });
}
