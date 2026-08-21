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
import type { AgentSession } from "../types.js";

export interface CreateAgentSessionInput {
  systemPrompt?: string;
  /** Host-registry key of the agent to run the session on. */
  agentId?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
}

/**
 * Create a new agent (coding session) for the project.
 */
export function useCreateAgentSession(
  projectId: string | undefined,
): UseMutationResult<AgentSession, CatamorphicError, CreateAgentSessionInput> {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  return useMutation<AgentSession, CatamorphicError, CreateAgentSessionInput>({
    mutationFn: (input) =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.POST(
          "/api/projects/{projectId}/agent/sessions",
          {
            params: { path: { projectId: projectId as string } },
            body: input,
          },
        );
        return assertApiOk(result, "Create agent session failed");
      }),
    onSuccess: () => {
      queryClient.invalidateQueries({
        queryKey: ["cat", "project", projectId, "agent", "sessions"],
      });
    },
  });
}
