import { type Collection, createCollection } from "@catamorphic/app";
import { useCollection } from "@catamorphic/app/ui";
import { useCatamorphic } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { type QueryClient, useQueryClient } from "@tanstack/react-query";
import { useMemo } from "react";
import type { SidebarSectionConfig } from "../../shared/sidebar.js";
import {
  projectSidebarItems,
  sidebarItemPresentation,
} from "../components/sidebar-contribution.js";

export interface SessionTreeItem extends AgentSession {
  parentId: string | null;
  hasChildren: boolean;
}
type ApiClient = ReturnType<typeof useCatamorphic>["apiClient"];
const sessionPageKey = (projectId: string) => [
  "desktop",
  "sidebar",
  "agent",
  projectId,
  "page",
];

/** Built-ins, availability probes and guest widgets share authorized page IO. */
export async function readSidebarSessionPage({
  apiClient,
  client,
  projectId,
  query,
  signal,
}: {
  apiClient: ApiClient;
  client: QueryClient;
  projectId: string;
  query: {
    limit: number;
    offset: number;
    visibility?: "promoted";
    parentSessionId?: string;
    rootsOnly?: "true" | "false";
  };
  signal: AbortSignal;
}) {
  signal.throwIfAborted();
  const page = await client.fetchQuery({
    queryKey: [...sessionPageKey(projectId), query],
    staleTime: 1000,
    gcTime: 60_000,
    queryFn: async ({ signal }) => {
      const response = await apiClient.GET(
        "/api/projects/{projectId}/agent/sessions",
        {
          params: { path: { projectId }, query },
          signal,
        },
      );
      if (!response.data)
        throw new Error(response.error?.error ?? "Could not load sessions");
      return response.data;
    },
  });
  // Releasing one view cannot cancel another view's shared request.
  signal.throwIfAborted();
  return page;
}

const stores = new WeakMap<
  QueryClient,
  Map<string, Collection<SessionTreeItem>>
>();

const updates = new WeakMap<
  QueryClient,
  Map<
    string,
    {
      listeners: Set<() => void>;
      dispose: () => void;
    }
  >
>();
/** One project wakeup fanout, regardless of how many session views subscribe. */
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
      if (document.hidden) return;
      void client.invalidateQueries({
        queryKey: sessionPageKey(projectId),
        refetchType: "none",
      });
      for (const notify of listeners) notify();
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
        event.query.queryKey.includes("agent") &&
        !event.query.queryKey.includes("sidebar")
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
  visible,
  relevant,
}: {
  projectId: string;
  sessionId?: string;
  section: SidebarSectionConfig;
  visible: boolean;
  relevant: boolean;
}) {
  const { apiClient } = useCatamorphic();
  const client = useQueryClient();
  const sourceKey = JSON.stringify([
    section.source ?? {},
    section.itemDefaults?.hide,
    Object.entries(section.itemOverrides ?? {}).flatMap(([id, item]) =>
      item.hide === undefined ? [] : [[id, item.hide]],
    ),
  ]);
  const childrenOnly =
    (section.source?.type ?? section.type) === "subsessions" ||
    section.source?.scope === "children";
  const currentOnly = section.source?.scope === "session";
  const key = JSON.stringify([
    projectId,
    childrenOnly || currentOnly ? sessionId : null,
    childrenOnly,
    currentOnly,
    sourceKey,
  ]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: key includes every source option; presentation changes keep the store.
  const collection = useMemo(() => {
    const cache =
      stores.get(client) ?? new Map<string, Collection<SessionTreeItem>>();
    stores.set(client, cache);
    const existing = cache.get(key);
    if (existing) return existing;
    const parents = new Set<string | null>();
    const load = async ({
      parentId,
      cursor,
      signal,
    }: {
      parentId: string | null;
      cursor?: string;
      signal: AbortSignal;
    }) => {
      parents.add(parentId);
      if ((childrenOnly || currentOnly) && !sessionId) return { items: [] };
      if (currentOnly && parentId === null && sessionId) {
        const response = await apiClient.GET(
          "/api/projects/{projectId}/agent/sessions/{sessionId}",
          {
            params: { path: { projectId, sessionId } },
            signal,
          },
        );
        if (!response.data)
          throw new Error(response.error?.error ?? "Could not read session");
        return {
          items: projectSidebarItems([response.data], section)
            .filter(
              (item) => !sidebarItemPresentation({ section, id: item.id }).hide,
            )
            .map((item) => ({
              ...item,
              parentId: null,
              hasChildren: Boolean(item.childCount),
            })),
        };
      }
      const limit = section.source?.pageSize ?? 50;
      let offset = cursor ? Number(cursor) : 0;
      for (;;) {
        const parent = parentId ?? (childrenOnly ? sessionId : undefined);
        const page = await readSidebarSessionPage({
          apiClient,
          client,
          projectId,
          signal,
          query: {
            limit,
            offset,
            ...(!childrenOnly && !section.source?.includeLatent
              ? { visibility: "promoted" }
              : {}),
            ...(parent ? { parentSessionId: parent } : { rootsOnly: "true" }),
          },
        });
        const items = projectSidebarItems(page.items, section)
          .filter(
            (session) =>
              !sidebarItemPresentation({ section, id: session.id }).hide &&
              session.visibility !== "archived" &&
              (childrenOnly ||
                section.source?.includeLatent ||
                session.visibility === "promoted"),
          )
          .map((session) => ({
            ...session,
            parentId,
            hasChildren: Boolean(session.childCount),
          }));
        offset += page.items.length;
        const next = offset < page.total ? String(offset) : undefined;
        if (items.length || !next || !page.items.length)
          return { items, cursor: next };
      }
    };
    const collection = createCollection<SessionTreeItem>({
      source: {
        load,
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
    if (cache.size > 100) {
      const oldest = [...cache].find(([, entry]) => !entry.isAcquired())?.[0];
      if (oldest) cache.delete(oldest);
    }
    return collection;
  }, [apiClient, client, key]);
  const { root } = useCollection({
    collection,
    active: relevant && !visible,
    mode: "preview",
    projected: true,
  });
  return { collection, root };
}
