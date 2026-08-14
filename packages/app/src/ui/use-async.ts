import { useCallback, useEffect, useState } from "react";

/** Discriminated union for the three data states every screen has. */
export type AsyncState<T> =
  | { status: "loading" }
  | { status: "error"; error: Error; retry: () => void }
  | { status: "ok"; value: T };

/**
 * Load async data (typically a workflow call) into the three-state union
 * the kit's components render: `loading` → {@link Skeleton}, `error` →
 * {@link ErrorState} (with `retry` wired), `ok` → content.
 *
 * A resolution that lands after unmount — or after `deps` changed and a
 * newer load started — is ignored, so stale responses can never overwrite
 * fresh ones.
 *
 * ```tsx
 * const orders = useAsync(() => workflows.listOrders.call({ status: "open" }), []);
 * if (orders.status === "loading") return <Skeleton height={28} />;
 * if (orders.status === "error") return <ErrorState onRetry={orders.retry} />;
 * return <OrderTable rows={orders.value} />;
 * ```
 */
export function useAsync<T>(
  load: () => Promise<T>,
  deps: readonly unknown[],
): AsyncState<T> {
  const [state, setState] = useState<AsyncState<T>>({ status: "loading" });
  const [nonce, setNonce] = useState(0);
  const retry = useCallback(() => setNonce((n) => n + 1), []);
  // biome-ignore lint/correctness/useExhaustiveDependencies: deps is the caller's dependency list; `load` is intentionally excluded so an inline closure doesn't re-run every render.
  useEffect(() => {
    let active = true;
    setState({ status: "loading" });
    load().then(
      (value) => {
        if (active) setState({ status: "ok", value });
      },
      (cause: unknown) => {
        if (!active) return;
        const error = cause instanceof Error ? cause : new Error(String(cause));
        setState({ status: "error", error, retry });
      },
    );
    return () => {
      active = false;
    };
  }, [...deps, nonce, retry]);
  return state;
}
