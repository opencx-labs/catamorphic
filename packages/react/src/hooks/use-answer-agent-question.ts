"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { assertApiOk, runWithCatamorphicError } from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

/** Answer a durable question batch without interrupting the current turn. */
export function useAnswerAgentQuestion(
  projectId: string,
  sessionId: string | null,
) {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { requestId: string; answer: string }) =>
      runWithCatamorphicError(async () => {
        if (!sessionId)
          throw new Error("A session is required to answer a question");
        return assertApiOk(
          await apiClient.POST(
            "/api/projects/{projectId}/agent/sessions/{sessionId}/questions/{requestId}/answer",
            {
              params: {
                path: { projectId, sessionId, requestId: input.requestId },
              },
              body: { answer: input.answer },
            },
          ),
          "Could not send your answer",
        );
      }),
    onSettled: () =>
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "session", sessionId],
      }),
  });
}
