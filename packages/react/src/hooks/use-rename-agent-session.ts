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

export interface RenameAgentSessionInput {
  sessionId: string;
  title: string;
}

/**
 * A person names their chat (ADR 0247); the chat keeps the name, whatever
 * its agent titles it later. Allowed while a turn runs.
 */
export function useRenameAgentSession(
  projectId: string | undefined,
): UseMutationResult<void, CatamorphicError, RenameAgentSessionInput> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<void, CatamorphicError, RenameAgentSessionInput>({
    mutationFn: ({ sessionId, title }) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.PATCH(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/title",
          {
            params: { path: { projectId: projectId as string, sessionId } },
            body: { title },
          },
        );
        assertApiOk(result, "Could not rename this chat");
      }),
    onSuccess: (_data, { sessionId }) => {
      void queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "session", sessionId],
      });
      void queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "sessions"],
      });
    },
  });
}
