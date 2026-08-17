"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { assertApiOk, runWithCatamorphicError } from "../lib/errors.js";
import { useCatamorphic } from "../provider.js";

/**
 * A pending tool-permission ask (ADR 0054): an agent wants to use an MCP
 * tool whose policy says "ask", and the host answers over HTTP.
 */
export interface PendingToolPermission {
  id: string;
  sessionId?: string;
  agentLabel?: string;
  request: {
    server: string;
    tool: string;
    description?: string;
    input: Record<string, unknown>;
    annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
  };
  createdAt: string;
  expiresAt: string;
}

export type ToolPermissionAnswer =
  | { decision: "allow"; remember?: "always" }
  | { decision: "deny" };

export interface UseToolPermissionsOptions {
  /** Poll while true (a turn is running); off otherwise. Default true. */
  enabled?: boolean;
  /** Poll interval in ms while enabled (default 1500). */
  intervalMs?: number;
}

/**
 * The session's pending permission asks, plus `answer`. Hosts render a
 * consent card per entry (see `ToolPermissionCard` in the registry); the
 * harness's tool call resumes the moment the answer lands. A 503 (host
 * without a broker — the desktop answers through its own bridge) reads as
 * an empty list.
 */
export function useToolPermissions(
  projectId: string | undefined,
  sessionId: string | undefined,
  options: UseToolPermissionsOptions = {},
) {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  const enabled = Boolean(projectId && sessionId) && (options.enabled ?? true);
  const queryKey = [
    "cat",
    "project",
    projectId,
    "agent",
    "session",
    sessionId,
    "permissions",
  ];
  const query = useQuery({
    queryKey,
    queryFn: () =>
      runWithCatamorphicError(async () => {
        const result = await apiClient.GET(
          "/api/projects/{projectId}/agent/sessions/{sessionId}/permissions",
          {
            params: {
              path: {
                projectId: projectId as string,
                sessionId: sessionId as string,
              },
            },
          },
        );
        if (result.response.status === 503)
          return [] as PendingToolPermission[];
        return assertApiOk(result, "Permissions response empty").permissions;
      }),
    enabled,
    refetchInterval: enabled ? (options.intervalMs ?? 1500) : false,
  });
  const mutation = useMutation({
    mutationFn: async ({
      permissionId,
      answer,
    }: {
      permissionId: string;
      answer: ToolPermissionAnswer;
    }) => {
      await apiClient.POST(
        "/api/projects/{projectId}/agent/sessions/{sessionId}/permissions/{permissionId}",
        {
          params: {
            path: {
              projectId: projectId as string,
              sessionId: sessionId as string,
              permissionId,
            },
          },
          body: answer,
        },
      );
    },
    onSuccess: () => queryClient.invalidateQueries({ queryKey }),
  });
  const answer = useCallback(
    (permissionId: string, decision: ToolPermissionAnswer) =>
      mutation.mutateAsync({ permissionId, answer: decision }),
    [mutation],
  );
  return {
    permissions: query.data ?? [],
    isLoading: query.isLoading,
    answer,
    isAnswering: mutation.isPending,
  };
}
