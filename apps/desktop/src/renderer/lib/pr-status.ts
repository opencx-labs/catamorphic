import { useQueries, useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
import type {
  PullRequestStatus,
  PullRequestStatusRead,
} from "../../shared/pr-details.js";
import { desktopApi } from "./desktop-api.js";

/** How often a pull request shown on a chip is read again. */
const PR_STATUS_REFRESH_MS = 60_000;
/** A status this fresh is drawn without asking again. */
const PR_STATUS_STALE_MS = 30_000;
/** Anonymous GitHub reads share a much smaller rate limit. */
const PUBLIC_REFRESH_MS = 5 * 60_000;

export const prStatusQueryKey = (url: string) =>
  ["desktop", "pr-status", url] as const;

/**
 * Where each pull request a chat recorded stands (ADR 0239), read through
 * main while the chat is in view, every minute and when the window comes
 * back. Null for one nothing here may read: its chip shows what the chat
 * recorded. One cache for every chat, so two chats of one PR share it.
 */
export function usePullRequestStatuses({
  urls,
  enabled,
}: {
  urls: readonly string[];
  enabled: boolean;
}): ReadonlyMap<string, PullRequestStatus | null> {
  const results = useQueries({
    queries: urls.map((url) => ({
      queryKey: prStatusQueryKey(url),
      queryFn: () => desktopApi.prStatus(url),
      enabled,
      staleTime: (query: { state: { data?: PullRequestStatusRead } }) =>
        query.state.data?.source === "public"
          ? PUBLIC_REFRESH_MS
          : PR_STATUS_STALE_MS,
      // A merged pull request cannot reopen; a closed one can.
      refetchInterval: (query: { state: { data?: PullRequestStatusRead } }) =>
        enabled &&
        query.state.data?.status?.state !== "merged" &&
        (query.state.data === undefined || query.state.data.status !== null)
          ? query.state.data?.source === "public"
            ? PUBLIC_REFRESH_MS
            : PR_STATUS_REFRESH_MS
          : false,
      refetchIntervalInBackground: false,
      retry: 1,
    })),
  });
  // Read again when the window comes back to the front, a read that failed
  // meanwhile included. The query client listens to the document becoming
  // visible, which switching apps never changes in a desktop window.
  const queryClient = useQueryClient();
  useEffect(() => {
    if (!enabled) return;
    const onFocus = () =>
      void queryClient.refetchQueries(
        { queryKey: ["desktop", "pr-status"], type: "active", stale: true },
        { cancelRefetch: false },
      );
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [enabled, queryClient]);
  const key = results
    .map((result, index) => `${urls[index]}\u0000${result.dataUpdatedAt}`)
    .join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a status that was read again is what changes the map
  return useMemo(
    () =>
      new Map(
        urls.flatMap((url, index) => {
          const data = results[index]?.data;
          return data === undefined ? [] : [[url, data.status] as const];
        }),
      ),
    [key],
  );
}
