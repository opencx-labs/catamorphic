import { type Collection, createCollection } from "@catamorphic/app";
import { useCatamorphic } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { SidebarSectionConfig } from "../../shared/sidebar.js";
import { projectSidebarItems } from "../components/sidebar-contribution.js";

export interface SessionTreeItem extends AgentSession {
  parentId: string | null;
  hasChildren: boolean;
}
const stores = new WeakMap<
  QueryClient,
  Map<string, Collection<SessionTreeItem>>
>();

/** One project wakeup fanout, regardless of how many session views subscribe. */
const updates = new WeakMap<
  QueryClient,
  Map<string, { listeners: Set<() => void>; dispose: () => void }>
>();
export function subscribeSidebarSessions({
  client,
  projectId,
  listener,
}: {
  client: QueryClient;
  projectId: string;
  listener: () => void;
}) {
  const projects = updates.get(client) ?? new Map();
  updates.set(client, projects);
  let entry = projects.get(projectId);
  if (!entry) {
    const listeners = new Set<() => void>();
    const refresh = () => {
      if (!document.hidden) for (const notify of listeners) notify();
    };
    const timer = window.setInterval(refresh, 2000);
    window.addEventListener("focus", refresh);
    const explicitRefresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === projectId) refresh();
    };
    window.addEventListener("catamorphic:sidebar-refresh", explicitRefresh);
    const stop = client.getQueryCache().subscribe((event) => {
      if (
        event.type === "updated" &&
        event.action.type === "invalidate" &&
        event.query.queryKey.includes(projectId) &&
        event.query.queryKey.includes("agent")
      )
        refresh();
    });
    entry = {
      listeners,
      dispose: () => {
        clearInterval(timer);
        window.removeEventListener("focus", refresh);
        window.removeEventListener(
          "catamorphic:sidebar-refresh",
          explicitRefresh,
        );
        stop();
      },
    };
    projects.set(projectId, entry);
  }
  entry.listeners.add(listener);
  return () => {
    entry.listeners.delete(listener);
    if (!entry.listeners.size) {
      entry.dispose();
      projects.delete(projectId);
    }
  };
}

export function useSidebarSessions({
  projectId,
  sessionId,
  section,
}: {
  projectId: string;
  sessionId?: string;
  section: SidebarSectionConfig;
}): Collection<SessionTreeItem> {
  const { apiClient } = useCatamorphic();
  const client = useQueryClient();
  const sourceKey = JSON.stringify(section.source ?? {});
  const childrenOnly =
    section.type === "subsessions" || section.source?.scope === "children";
  const currentOnly = section.source?.scope === "session";
  // biome-ignore lint/correctness/useExhaustiveDependencies: sourceKey includes the complete source definition; presentation changes retain the shared store.
  return useMemo(() => {
    const key = JSON.stringify([
      projectId,
      childrenOnly || currentOnly ? sessionId : null,
      childrenOnly,
      currentOnly,
      sourceKey,
    ]);
    const cache =
      stores.get(client) ?? new Map<string, Collection<SessionTreeItem>>();
    stores.set(client, cache);
    const existing = cache.get(key);
    if (existing) return existing;
    const parents = new Set<string | null>();
    const collection = createCollection<SessionTreeItem>({
      structureKey: (session) =>
        JSON.stringify([
          section.source?.groupBy
            ? Object.entries(session).find(
                ([field]) => field === section.source?.groupBy,
              )?.[1]
            : undefined,
        ]),
      source: {
        load: async ({ parentId, cursor, signal }) => {
          parents.add(parentId);
          if ((childrenOnly || currentOnly) && !sessionId) return { items: [] };
          if (currentOnly && parentId === null && sessionId) {
            const response = await apiClient.GET(
              "/api/projects/{projectId}/agent/sessions/{sessionId}",
              { params: { path: { projectId, sessionId } }, signal },
            );
            if (!response.data)
              throw new Error(
                response.error?.error ?? "Could not read session",
              );
            return {
              items: [{ ...response.data, parentId: null, hasChildren: true }],
            };
          }
          const limit = section.source?.pageSize ?? 50;
          let offset = cursor ? Number(cursor) : 0;
          for (;;) {
            const parent = parentId ?? (childrenOnly ? sessionId : undefined);
            const response = await apiClient.GET(
              "/api/projects/{projectId}/agent/sessions",
              {
                params: {
                  path: { projectId },
                  query: {
                    limit,
                    offset,
                    ...(!childrenOnly && !section.source?.includeLatent
                      ? { visibility: "promoted" as const }
                      : {}),
                    ...(parent
                      ? { parentSessionId: parent }
                      : { rootsOnly: "true" }),
                  },
                },
                signal,
              },
            );
            if (!response.data)
              throw new Error(
                response.error?.error ?? "Could not load sessions",
              );
            const items = projectSidebarItems(response.data.items, section)
              .filter(
                (session) =>
                  session.visibility !== "archived" &&
                  (childrenOnly ||
                    section.source?.includeLatent ||
                    session.visibility === "promoted"),
              )
              .map((session) => ({
                ...session,
                parentId,
                hasChildren: (session.childCount ?? 0) > 0,
              }));
            offset += response.data.items.length;
            const next =
              offset < response.data.total ? String(offset) : undefined;
            if (items.length || !next || response.data.items.length === 0)
              return { items, cursor: next };
          }
        },
        subscribe: (publish) =>
          subscribeSidebarSessions({
            client,
            projectId,
            listener: () => {
              for (const parentId of parents)
                publish({ type: "invalidate", parentId });
            },
          }),
      },
    });
    cache.set(key, collection);
    // Bounded retained snapshots; active views retain their store independently.
    if (cache.size > 100) {
      const oldest = [...cache].find(([, entry]) => !entry.isAcquired())?.[0];
      if (oldest) cache.delete(oldest);
    }
    return collection;
  }, [
    apiClient,
    client,
    projectId,
    sessionId,
    childrenOnly,
    currentOnly,
    sourceKey,
  ]);
}
