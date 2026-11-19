import { useQueryClient } from "@tanstack/react-query";
import { useEffect } from "react";
import { desktopApi } from "./desktop-api.js";

/**
 * How often lists that this computer's own work changes look again on
 * their own (ADR 0229): its chats, their attention and watchers, which
 * follow `desktopApi.onSessionsChanged`, and its apps, which follow
 * `desktopApi.onGitChanged`. The timer only backs those up. A remote
 * project's server says nothing: its lists keep their shorter polls.
 */
export const LOCAL_CHATS_POLL_MS = 30_000;

/**
 * Whether a query reads chats as lists, attention or watchers: what a
 * hint makes stale. A chat's own conversation streams, and is never read
 * again for a hint.
 */
export function readsChats(queryKey: readonly unknown[]): boolean {
  if (queryKey[0] !== "cat") return false;
  if (queryKey[1] === "agent") return queryKey[2] === "attention";
  if (queryKey[1] !== "project" || queryKey[3] !== "agent") return false;
  if (queryKey[4] === "sessions") return true;
  return queryKey[4] === "session" && queryKey[6] === "watchers";
}

/**
 * Keeps this window's chat lists, attention and watchers current from
 * this computer's hints: the ones on screen read again at once. (A read,
 * not an invalidation: the sidebar's chat lists follow the hints on their
 * own, reading only their first page.) Mount once per window, beside its
 * query client.
 *
 * A window nobody can see (covered, minimised) reads nothing for a hint:
 * every chat's turn hints several times a second, and each read is a
 * request to the main process and a render here. It reads once as it
 * shows again, and only if it dropped a hint (ADR 0249).
 */
export function useSessionChangeHints(): void {
  const client = useQueryClient();
  useEffect(() => {
    let missed = false;
    const read = () =>
      void client.refetchQueries({
        type: "active",
        predicate: (query) => readsChats(query.queryKey),
      });
    const hinted = desktopApi.onSessionsChanged(() => {
      if (document.hidden) missed = true;
      else read();
    });
    const shown = () => {
      if (document.hidden || !missed) return;
      missed = false;
      read();
    };
    document.addEventListener("visibilitychange", shown);
    return () => {
      hinted();
      document.removeEventListener("visibilitychange", shown);
    };
  }, [client]);
}
