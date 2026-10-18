import { QueryClient } from "@tanstack/react-query";

/**
 * A query cache for Work's windows. Work's data follows this computer's
 * hints, polls and session streams (ADRs 0197, 0229), so a window coming
 * back to the front refetches nothing by itself: refetching every stale
 * query of every open workspace at once, and rendering each of their
 * readers twice (fetching, then fetched), made returning to Work after a
 * while stutter. A query that does want it asks with
 * `refetchOnWindowFocus`: a pull request's state, and a file the window
 * shows from disk, which can change outside Work with no hint.
 */
export function workQueryClient(
  queries: { staleTime?: number; retry?: number } = {},
): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: queries.staleTime ?? 30_000,
        retry:
          queries.retry ??
          ((failureCount, error) => {
            // A refusal (4xx) is not retried; anything else twice.
            const status =
              typeof error === "object" && error && "status" in error
                ? error.status
                : undefined;
            if (typeof status === "number" && status >= 400 && status < 500)
              return false;
            return failureCount < 2;
          }),
        refetchOnWindowFocus: false,
      },
    },
  });
}
