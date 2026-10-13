import {
  type Collection,
  type CollectionBranch,
  type CollectionRefresh,
  createCollection,
} from "@catamorphic/app";
import { useCollection } from "@catamorphic/app/ui";
import { useCatamorphic } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import {
  type QueryClient,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useEffect, useMemo } from "react";
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

/**
 * A chats list's first read, and each page after it. The default Chats tree
 * shows twelve 28px rows (336px), so 30 fills it at open with a viewport
 * and a half to spare: a short scroll never meets placeholders, while the
 * request (and the attention and presentation reads it makes per row)
 * stays small. The tree asks for the next page one viewport before the end.
 */
export const SIDEBAR_SESSION_PAGE = 30;
/** How often the chats list looks for changes while the window is shown. */
const POLL_MS = 2000;
/**
 * A poll reads the first page, where new chats arrive. Every loaded page is
 * read again on this tick (about every 30 seconds), on focus, on Refresh,
 * and when the app itself changes a chat, so the cost of a poll never grows
 * with how far the person scrolled.
 */
const EVERY_LOADED_PAGE_TICKS = 15;
/**
 * A next page starts a tenth of a page early (at most five rows): a chat
 * archived above the loaded rows shifts every later offset, and the overlap
 * keeps that from skipping one. Repeated rows are merged by id.
 */
const pageOverlap = (limit: number) => Math.min(5, Math.floor(limit / 10));

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
    visibility?: "promoted" | "archived";
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
      listeners: Set<(pages: CollectionRefresh) => void>;
      dispose: () => void;
    }
  >
>();
/**
 * One project wakeup fanout, regardless of how many session views subscribe.
 * Each wakeup says how much to read again: `first` for the routine poll,
 * `loaded` when anything may have changed anywhere in the list.
 */
export function subscribeSidebarSessions({
  client,
  projectId,
  listener,
}: {
  client: QueryClient;
  projectId: string;
  listener: (pages: CollectionRefresh) => void;
}) {
  const projects = updates.get(client) ?? new Map();
  updates.set(client, projects);
  let entry = projects.get(projectId);
  if (!entry) {
    const listeners = new Set<(pages: CollectionRefresh) => void>();
    let ticks = 0;
    const refresh = (pages: CollectionRefresh) => {
      if (document.hidden) return;
      if (pages === "loaded") ticks = 0;
      void client.invalidateQueries({
        queryKey: sessionPageKey(projectId),
        refetchType: "none",
      });
      for (const notify of listeners) notify(pages);
    };
    const timer = window.setInterval(() => {
      ticks += 1;
      refresh(ticks >= EVERY_LOADED_PAGE_TICKS ? "loaded" : "first");
    }, POLL_MS);
    const refreshLoaded = () => refresh("loaded");
    window.addEventListener("focus", refreshLoaded);
    const explicitRefresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === projectId)
        refresh("loaded");
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
        refresh("loaded");
    });
    entry = {
      listeners,
      dispose: () => {
        clearInterval(timer);
        window.removeEventListener("focus", refreshLoaded);
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
      const limit = section.source?.pageSize ?? SIDEBAR_SESSION_PAGE;
      let offset = cursor
        ? Math.max(0, Number(cursor) - pageOverlap(limit))
        : 0;
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
            listener: (pages) => {
              for (const parentId of parents)
                publish({ type: "invalidate", parentId, pages });
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

/** Up to how many chats above an open fork the list looks for its row. */
const REVEAL_ANCESTORS = 8;

/**
 * The open chat stays in the list even when it is older than every loaded
 * row: the next pages load until it arrives, and stop as soon as the loaded
 * rows are older than it (it is not in this list). A fork brings in the
 * top-level chat it hangs under. Lists of one chat's children are not
 * chased: they hold a single family.
 */
export function useRevealSidebarSession({
  collection,
  root,
  projectId,
  sessionId,
  section,
  active,
}: {
  collection: Collection<SessionTreeItem>;
  root: CollectionBranch;
  projectId: string;
  sessionId?: string;
  section: SidebarSectionConfig;
  active: boolean;
}) {
  const { apiClient } = useCatamorphic();
  const scoped =
    (section.source?.type ?? section.type) === "subsessions" ||
    section.source?.scope === "children" ||
    section.source?.scope === "session";
  const includeLatent = Boolean(section.source?.includeLatent);
  const loaded = Boolean(sessionId && collection.getItem(sessionId));
  const query = useQuery({
    queryKey: [
      "desktop",
      "sidebar",
      "agent",
      projectId,
      "reveal",
      sessionId,
      includeLatent,
    ],
    enabled: Boolean(active && !scoped && sessionId && !loaded && root.cursor),
    staleTime: 30_000,
    queryFn: async ({ signal }) => {
      const read = async (id: string) => {
        const response = await apiClient.GET(
          "/api/projects/{projectId}/agent/sessions/{sessionId}",
          { params: { path: { projectId, sessionId: id } }, signal },
        );
        return response.data ?? null;
      };
      // The list's row is the first chat up the family whose parent the
      // list does not show (none, or one that is not promoted).
      let row = sessionId ? await read(sessionId) : null;
      for (let depth = 0; row?.parentSessionId && depth < REVEAL_ANCESTORS; ) {
        const parent = await read(row.parentSessionId);
        if (!parent || (!includeLatent && parent.visibility !== "promoted"))
          break;
        row = parent;
        depth += 1;
      }
      return row;
    },
  });
  const target = query.data;
  const belongs = Boolean(
    target &&
      target.visibility !== "archived" &&
      (includeLatent || target.visibility === "promoted") &&
      projectSidebarItems([target], section).length &&
      !sidebarItemPresentation({ section, id: target.id }).hide,
  );
  const lastId = root.ids.at(-1);
  const last = lastId ? collection.getItem(lastId) : undefined;
  const chase = Boolean(
    active &&
      target &&
      belongs &&
      !root.ids.includes(target.id) &&
      root.cursor &&
      !root.paging &&
      !root.pageError &&
      last &&
      Date.parse(last.createdAt) >= Date.parse(target.createdAt),
  );
  const depth = root.ids.length;
  useEffect(() => {
    if (chase && depth) void collection.load({ more: true });
  }, [chase, collection, depth]);
}
