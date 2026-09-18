import {
  AppWindow,
  FileText,
  Globe,
  LayoutGrid,
  MessageSquare,
  Workflow,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import type {
  HistoryEntry,
  HistoryPage,
  HistoryQuery,
} from "../../shared/history.js";
import { desktopApi } from "./desktop-api.js";

export const HISTORY_ICONS = {
  web: Globe,
  app: LayoutGrid,
  file: FileText,
  workflow: Workflow,
  chat: MessageSquare,
  run: Workflow,
  artifact: AppWindow,
};
export function historyDetail(entry: HistoryEntry): string {
  return entry.target.kind === "web"
    ? entry.target.url
    : `${entry.projectName ?? "Project"} · ${entry.target.resource}`;
}
export function historyDestination(entry: HistoryEntry): string {
  const target = entry.target;
  return target.kind === "web"
    ? target.url
    : `${target.kind === "chat" ? "session" : target.kind}:${encodeURIComponent(target.resource)}`;
}
export function useHistory({
  query = "",
  offset = 0,
  limit = 100,
  enabled = true,
  profileId,
}: HistoryQuery & { enabled?: boolean; profileId?: string }) {
  const key = JSON.stringify([profileId, query, offset, limit]);
  const [result, setResult] = useState<{
    key: string;
    page: HistoryPage;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [revision, setRevision] = useState(0);
  const refresh = useCallback(() => setRevision((value) => value + 1), []);
  useEffect(
    () => (enabled ? desktopApi.onHistoryChanged(refresh) : undefined),
    [enabled, refresh],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: refresh and profile switches invalidate the same query.
  useEffect(() => {
    if (!enabled) return;
    let active = true;
    setLoading(true);
    setError(null);
    const timer = setTimeout(
      () => {
        void desktopApi
          .historyQuery({ query, offset, limit })
          .then((page) => {
            if (active) setResult({ key, page });
          })
          .catch(() => {
            if (active) setError("Could not load history. Try again.");
          })
          .finally(() => {
            if (active) setLoading(false);
          });
      },
      query ? 120 : 0,
    );
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [query, offset, limit, enabled, profileId, revision, key]);
  const page = result?.key === key ? result.page : { entries: [], total: 0 };
  return {
    ...page,
    error,
    loading: loading || (enabled && !error && result?.key !== key),
    refresh,
  };
}
