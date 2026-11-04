import { useCatamorphic } from "@catamorphic/react";
import { History } from "lucide-react";
import { useMemo } from "react";
import { type HistoryEntry, historyIdentity } from "../../../shared/history.js";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import { desktopApi } from "../../lib/desktop-api.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/**
 * Everything opened in this profile; the source searches the full history.
 * Typed words also find the project's chats by what was written in them:
 * such a chat reads with the words' message in place of its id.
 */
export function useHistoryMode(
  historyRow: (entry: HistoryEntry) => PaletteItem,
): PaletteMode {
  const { profileId, projectId, projects } = usePaletteHost();
  const { apiClient } = useCatamorphic();
  const projectName = projects.find(
    (project) => project.id === projectId,
  )?.name;
  return useMemo(
    () => ({
      id: "history",
      chip: "History",
      icon: History,
      label: "Search history",
      description: "Find pages, chats and work you opened",
      placeholder: "Search history…",
      names: profileId ? BUILTIN_PALETTE_TRIGGERS.history : undefined,
      rows: {
        kind: "load",
        key: `history:${profileId}:${projectId}`,
        filtered: true,
        debounceMs: 120,
        empty: "No history matches",
        load: async (typed, signal) => {
          const [history, chats] = await Promise.all([
            desktopApi.historyQuery({ query: typed, limit: 80 }),
            projectId && typed
              ? apiClient
                  .GET("/api/projects/{projectId}/agent/sessions", {
                    params: {
                      path: { projectId },
                      query: { query: typed, limit: 30 },
                    },
                    signal,
                  })
                  .then((response) => response.data?.items ?? [])
                  // History still answers when the project cannot.
                  .catch(() => [])
              : [],
          ]);
          const project = projectId
            ? { id: projectId, name: projectName ?? "Project" }
            : undefined;
          const excerpts = new Map<string, string>();
          const entries = [...history.entries];
          const known = new Set(entries.map((entry) => entry.id));
          for (const chat of chats) {
            if (!project) break;
            const target = {
              kind: "chat" as const,
              projectId: project.id,
              resource: chat.id,
            };
            const id = historyIdentity(target);
            if (chat.match) excerpts.set(id, chat.match);
            if (known.has(id)) continue;
            known.add(id);
            entries.push({
              id,
              target,
              title: chat.title ?? "Untitled chat",
              project,
              lastVisitAt: Date.parse(chat.updatedAt),
              visitCount: 1,
            });
          }
          return {
            items: entries
              .sort((a, b) => b.lastVisitAt - a.lastVisitAt)
              .map((entry) => {
                const row = historyRow(entry);
                const excerpt = excerpts.get(entry.id);
                return excerpt
                  ? {
                      ...row,
                      detail: `${entry.project?.name ?? "Project"} · ${excerpt}`,
                    }
                  : row;
              }),
          };
        },
      },
    }),
    [profileId, projectId, projectName, apiClient, historyRow],
  );
}
