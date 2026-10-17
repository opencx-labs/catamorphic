import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";
import type { PullRequestStatus } from "../../shared/pr-details.js";
import { desktopApi } from "./desktop-api.js";

/** How often a pull request shown on a chip is read again. */
const PR_STATUS_REFRESH_MS = 60_000;
/** A status this fresh is drawn without asking again. */
const PR_STATUS_STALE_MS = 30_000;

export const prStatusQueryKey = (url: string) =>
  ["desktop", "pr-status", url] as const;

/**
 * Where each pull request a chat recorded stands (ADR 0238), read through
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
      staleTime: PR_STATUS_STALE_MS,
      // A merged or closed pull request stands where it is.
      refetchInterval: (query: {
        state: { data?: PullRequestStatus | null };
      }) =>
        enabled &&
        query.state.data?.state !== "merged" &&
        query.state.data?.state !== "closed"
          ? PR_STATUS_REFRESH_MS
          : false,
      refetchIntervalInBackground: false,
      retry: 1,
    })),
  });
  const key = results
    .map((result, index) => `${urls[index]}\u0000${result.dataUpdatedAt}`)
    .join("\n");
  // biome-ignore lint/correctness/useExhaustiveDependencies: a status that was read again is what changes the map
  return useMemo(
    () =>
      new Map(
        urls.flatMap((url, index) => {
          const data = results[index]?.data;
          return data === undefined ? [] : [[url, data] as const];
        }),
      ),
    [key],
  );
}
