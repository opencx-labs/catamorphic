import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { desktopApi } from "./desktop-api.js";

export const sessionCheckoutKey = (projectId: string, sessionId: string) =>
  ["desktop", "session-checkout", projectId, sessionId] as const;

export const worktreesAvailableKey = (projectId: string) =>
  ["desktop", "worktrees-available", projectId] as const;

/** Refresh one query whenever the project's Git state moves. */
function useRefreshOnGitChange(
  projectId: string,
  queryKey: readonly string[],
  enabled: boolean,
) {
  const client = useQueryClient();
  const keyRef = useRef(queryKey);
  keyRef.current = queryKey;
  useEffect(() => {
    if (!enabled) return;
    return desktopApi.onGitChanged((event) => {
      if (event.projectId !== projectId) return;
      void client.invalidateQueries({
        queryKey: keyRef.current,
        exact: true,
      });
    });
  }, [client, enabled, projectId]);
}

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
  const enabled = (options.enabled ?? true) && Boolean(sessionId);
  const queryKey = sessionCheckoutKey(projectId, sessionId ?? "");
  useRefreshOnGitChange(projectId, queryKey, enabled);
  return useQuery({
    queryKey,
    queryFn: () =>
      desktopApi.sessionCheckout({ projectId, sessionId: sessionId ?? "" }),
    enabled,
    staleTime: 2_000,
  });
}

/**
 * The project can start a worktree: a Git repository with a commit. A
 * first commit, or a folder made a repository, changes it.
 */
export function useWorktreesAvailable(
  projectId: string | undefined,
  options: { enabled?: boolean } = {},
) {
  const enabled = (options.enabled ?? true) && Boolean(projectId);
  const queryKey = worktreesAvailableKey(projectId ?? "");
  useRefreshOnGitChange(projectId ?? "", queryKey, enabled);
  return useQuery({
    queryKey,
    queryFn: () => desktopApi.projectWorktreesAvailable(projectId ?? ""),
    enabled,
    staleTime: 30_000,
  });
}
