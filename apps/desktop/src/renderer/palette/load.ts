import { useCallback, useEffect, useMemo, useState } from "react";
import type {
  PaletteItem,
  PaletteLoad,
  PaletteMode,
  PaletteRows,
} from "./types.js";

/** "@se", "se" or "chat" → one mode, once unambiguous. */
export function matchPaletteMode(
  modes: readonly PaletteMode[],
  input: string,
): PaletteMode | undefined {
  const raw = (input.startsWith("@") ? input.slice(1) : input).toLowerCase();
  if (!raw) return undefined;
  const exact = modes.find((mode) => mode.names?.includes(raw));
  if (exact) return exact;
  const matches = modes.filter((mode) =>
    mode.names?.some((name) => name.startsWith(raw)),
  );
  return matches.length === 1 ? matches[0] : undefined;
}

export function isFullPaletteModeName(
  modes: readonly PaletteMode[],
  input: string,
): boolean {
  const raw = input.toLowerCase();
  return modes.some((mode) => mode.names?.includes(raw));
}

export interface PaletteLoadState {
  items: PaletteItem[];
  notice?: string;
  loading: boolean;
  error: string | null;
  idle: boolean;
  retry: () => void;
}

/**
 * Runs a "load" mode's source: debounced per query for filtered sources,
 * once per key otherwise. Aborts superseded loads so a slow answer never
 * replaces a newer one.
 */
export function usePaletteLoad(
  rows: PaletteRows | undefined,
  query: string,
  active: boolean,
): PaletteLoadState {
  const load = rows?.kind === "load" ? rows : undefined;
  const filteredQuery = load?.filtered ? query.trim() : "";
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<{
    token: string;
    key: string;
    result: PaletteLoad | null;
    error: string | null;
  }>({ token: "", key: "", result: null, error: null });
  const token = load ? JSON.stringify([load.key, filteredQuery, attempt]) : "";
  const idle = Boolean(load?.filtered && !filteredQuery && load.idle);
  // biome-ignore lint/correctness/useExhaustiveDependencies: the token captures key, query and retry; load closures change every render
  useEffect(() => {
    if (!active || !load || idle) return;
    const controller = new AbortController();
    const key = load.key;
    const timer = window.setTimeout(
      () => {
        void load
          .load(filteredQuery, controller.signal)
          .then((result) => {
            if (!controller.signal.aborted)
              setState({ token, key, result, error: null });
          })
          .catch((cause: unknown) => {
            if (!controller.signal.aborted)
              setState({
                token,
                key,
                result: null,
                error:
                  cause instanceof Error && cause.message
                    ? cause.message
                    : "Could not load these results.",
              });
          });
      },
      load.filtered && filteredQuery ? (load.debounceMs ?? 150) : 0,
    );
    return () => {
      controller.abort();
      window.clearTimeout(timer);
    };
  }, [active, token, idle]);
  const retry = useCallback(() => setAttempt((value) => value + 1), []);
  const loadKey = load?.key;
  return useMemo(() => {
    const current = state.token === token ? state : null;
    // The previous query's rows stay while the next query loads, so
    // typing refines a list instead of flashing a loading row.
    const shown =
      current?.result ?? (state.key === loadKey ? state.result : null);
    return {
      items: shown?.items ?? [],
      notice: shown?.notice,
      loading: Boolean(loadKey) && !idle && !current,
      error: current?.error ?? null,
      idle,
      retry,
    };
  }, [state, token, loadKey, idle, retry]);
}
