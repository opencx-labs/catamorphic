import type { LucideIcon } from "lucide-react";
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
import { downloadIcon } from "./downloads.js";

const HISTORY_ICONS: Record<
  Exclude<HistoryEntry["target"]["kind"], "local">,
  LucideIcon
> = {
  web: Globe,
  app: LayoutGrid,
  file: FileText,
  workflow: Workflow,
  chat: MessageSquare,
  run: Workflow,
  artifact: AppWindow,
};
export function historyIcon(entry: HistoryEntry): LucideIcon {
  return entry.target.kind === "local"
    ? downloadIcon(entry.target.path)
    : HISTORY_ICONS[entry.target.kind];
}
/** The line under the title: where the entry lives. */
export function historyDetail(entry: HistoryEntry): string {
  const { target } = entry;
  if (target.kind === "web") return target.url;
  if (target.kind === "local") return target.path;
  return `${entry.project?.name ?? "Project"} · ${target.resource}`;
}
/** A project resource as a surface link its project can open. */
export function historyDestination(
  target: Extract<HistoryEntry["target"], { projectId: string }>,
): string {
  return `${target.kind === "chat" ? "session" : target.kind}:${encodeURIComponent(target.resource)}`;
}
const EMPTY_PAGE: HistoryPage = { entries: [], total: 0, projects: [] };
export function useHistory({
  query = "",
  projectId,
  offset = 0,
  limit = 100,
  enabled = true,
  profileId,
}: HistoryQuery & { enabled?: boolean; profileId?: string }) {
  const key = JSON.stringify([profileId, query, projectId, offset, limit]);
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
          .historyQuery({ query, projectId, offset, limit })
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
  }, [query, projectId, offset, limit, enabled, profileId, revision, key]);
  const page = result?.key === key ? result.page : EMPTY_PAGE;
  return {
    ...page,
    error,
    loading: loading || (enabled && !error && result?.key !== key),
    refresh,
  };
}
