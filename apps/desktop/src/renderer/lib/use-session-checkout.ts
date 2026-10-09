import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { desktopApi } from "./desktop-api.js";

export const sessionCheckoutKey = (projectId: string, sessionId: string) =>
  ["desktop", "session-checkout", projectId, sessionId] as const;

export const worktreesAvailableKey = (projectId: string) =>
  ["desktop", "worktrees-available", projectId] as const;

/**
 * Where one chat works (ADR 0215), shared by its status popup, the popup's
 * trigger and the sidebar's session card, and refreshed whenever the
 * project's Git state moves.
 */
export function useSessionCheckout(
  projectId: string,
  sessionId: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const client = useQueryClient();
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  useEffect(() => {
    if (!enabled) return;
    return desktopApi.onGitChanged((event) => {
      if (event.projectId !== projectId) return;
      void client.invalidateQueries({
        queryKey: ["desktop", "session-checkout", projectId],
      });
    });
  }, [client, enabled, projectId]);
  return useQuery({
    queryKey: sessionCheckoutKey(projectId, sessionId ?? ""),
    queryFn: () =>
      desktopApi.sessionCheckout({ projectId, sessionId: sessionId ?? "" }),
    enabled,
    staleTime: 2_000,
  });
}

/** The project can start a worktree: a Git repository with a commit. */
export function useWorktreesAvailable(
  projectId: string,
  options: { enabled?: boolean } = {},
) {
  return useQuery({
    queryKey: worktreesAvailableKey(projectId),
    queryFn: () => desktopApi.projectWorktreesAvailable(projectId),
    enabled: options.enabled ?? true,
    staleTime: 30_000,
  });
}
