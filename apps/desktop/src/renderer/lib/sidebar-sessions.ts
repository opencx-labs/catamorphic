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
import { useMemo } from "react";
import type { SidebarSectionConfig } from "../../shared/sidebar.js";
import {
  projectSidebarItems,
  sidebarItemPresentation,
} from "../components/sidebar-contribution.js";
import { desktopApi } from "./desktop-api.js";
import { isRemoteQueryClient } from "./remote-query-clients.js";
import { LOCAL_CHATS_POLL_MS } from "./session-change-hints.js";

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
/**
 * How often a remote project's chats list looks for changes while the
 * window is shown. This computer's own lists follow its hints instead
 * (ADR 0229), reading every loaded page every `LOCAL_CHATS_POLL_MS`.
 */
const POLL_MS = 2000;
/**
 * A poll of a deep list reads the first page, where new chats arrive (two
 * pages or fewer are read whole every time, so the first sixty chats never
 * lag). Every loaded page is read again on this tick (about every 30
 * seconds), on focus, on Refresh, and when the app itself changes a chat,
 * so the cost of a poll never grows with how far the person scrolled.
 */
const EVERY_LOADED_PAGE_TICKS = 15;
/** Loaded pages a poll still reads whole. */
const WHOLE_POLL_PAGES = 2;
/**
 * A next page starts up to five rows early (half a page when pages are
 * smaller): a chat archived or started above the loaded rows shifts every
 * later offset, and the overlap keeps that from skipping or repeating one.
 * Its cursor also names the last row read and when it was created (pages
 * are newest first); when even the overlap misses that row, the read finds
 * it again: further on when the rows read are newer (more chats arrived
 * than the overlap covers, before a poll of every loaded page re-reads the
 * offsets), a page earlier when they are older (more chats went away).
 * Repeated rows are merged by id.
 */
const pageOverlap = (limit: number) => Math.min(5, Math.floor(limit / 2));
/**
 * Pages a next page reads on, past the overlap, looking for the last row
 * read. Past that it returns the rows it reached with their cursor: the
 * tree shows Show more, and the next read starts where this one ended.
 */
const ANCHOR_SCAN_PAGES = 4;
/**
 * Raw pages one read may look through for rows a section's filter keeps
 * ("Working chats"). Past that it returns what it found with its cursor,
 * and the tree waits for the person before looking further.
 */
const FILTER_SCAN_PAGES = 4;
/**
 * `offset~createdAt~lastRowId`: where the next page starts, and the row
 * before it.
 */
const readCursor = (
  cursor?: string,
): { offset: number; last?: { id: string; createdAt: number } } => {
  if (!cursor) return { offset: 0 };
  const [offset = "", createdAt = "", ...id] = cursor.split("~");
  return id.length
    ? {
        offset: Number(offset),
        last: { id: id.join("~"), createdAt: Date.parse(createdAt) },
      }
    : { offset: Number(offset) };
};
const writeCursor = (
  offset: number,
  last?: { id: string; createdAt: string },
) => (last ? `${offset}~${last.createdAt}~${last.id}` : String(offset));

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

/**
 * A wakeup: how much to read again, and whether the person asked for it
 * (a Refresh press shows the section refreshing; routine checks do not).
 */
type SessionsWakeup = (pages: CollectionRefresh, asked: boolean) => void;

const updates = new WeakMap<
  QueryClient,
  Map<
    string,
    {
      listeners: Set<SessionsWakeup>;
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
  listener: SessionsWakeup;
}) {
  const projects = updates.get(client) ?? new Map();
  updates.set(client, projects);
  let entry = projects.get(projectId);
  if (!entry) {
    const listeners = new Set<SessionsWakeup>();
    const remote = isRemoteQueryClient(client);
    let ticks = 0;
    const refresh = (pages: CollectionRefresh, asked = false) => {
      if (document.hidden) return;
      if (pages === "loaded") ticks = 0;
      void client.invalidateQueries({
        queryKey: sessionPageKey(projectId),
        refetchType: "none",
      });
      for (const notify of listeners) notify(pages, asked);
    };
    const timer = window.setInterval(
      () => {
        ticks += 1;
        refresh(
          !remote || ticks >= EVERY_LOADED_PAGE_TICKS ? "loaded" : "first",
        );
      },
      remote ? POLL_MS : LOCAL_CHATS_POLL_MS,
    );
    // This computer says when its chats change: new rows arrive first.
    const hinted = remote
      ? () => {}
      : desktopApi.onSessionsChanged(() => refresh("first"));
    const refreshLoaded = () => refresh("loaded");
    window.addEventListener("focus", refreshLoaded);
    // A hidden window drops its wakeups: it catches up once it shows
    // again, which need not give it focus.
    const shown = () => {
      if (!document.hidden) refresh("loaded");
    };
    document.addEventListener("visibilitychange", shown);
    const explicitRefresh = (event: Event) => {
      if (event instanceof CustomEvent && event.detail === projectId)
        refresh("loaded", true);
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
        hinted();
        window.removeEventListener("focus", refreshLoaded);
        document.removeEventListener("visibilitychange", shown);
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
    const unsorted: SidebarSectionConfig = {
      ...section,
      source: section.source && { ...section.source, sort: undefined },
    };
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
      const parent = parentId ?? (childrenOnly ? sessionId : undefined);
      const read = (offset: number) =>
        readSidebarSessionPage({
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
      const start = readCursor(cursor);
      const anchor = start.last;
      let offset = Math.max(0, start.offset - pageOverlap(limit));
      let page = await read(offset);
      /** Created after the last row read: the server reads newest first. */
      const newer = (session?: { createdAt: string }) =>
        Boolean(
          anchor && session && Date.parse(session.createdAt) > anchor.createdAt,
        );
      if (
        anchor &&
        pageOverlap(limit) > 0 &&
        !page.items.some((session) => session.id === anchor.id)
      ) {
        if (newer(page.items.at(-1))) {
          // More chats arrived above than the overlap covers: the last row
          // read sits further on. Read on to it and start right after it.
          for (let step = 0; step < ANCHOR_SCAN_PAGES; step += 1) {
            const after = offset + page.items.length;
            if (!page.items.length || after >= page.total) break;
            offset = after;
            page = await read(offset);
            const at = page.items.findIndex(
              (session) => session.id === anchor.id,
            );
            if (at >= 0 && at + 1 < page.items.length) {
              offset += at + 1;
              page = { ...page, items: page.items.slice(at + 1) };
              break;
            }
            if (at >= 0) {
              offset += page.items.length;
              page = await read(offset);
              break;
            }
            // Past where it would be: it went away too; read on from here.
            if (!newer(page.items.at(-1))) break;
          }
        } else if (offset > 0) {
          // More chats went away above than the overlap covers.
          offset = Math.max(0, start.offset - limit);
          page = await read(offset);
        }
      }
      for (let scanned = 1; ; scanned += 1) {
        if (scanned > 1) page = await read(offset);
        // Pages keep the server's order: the section's sort is applied
        // across every loaded row by the view, never within one page.
        const items = projectSidebarItems(page.items, unsorted)
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
        const next =
          offset < page.total
            ? writeCursor(offset, page.items.at(-1))
            : undefined;
        if (
          items.length ||
          !next ||
          !page.items.length ||
          scanned >= FILTER_SCAN_PAGES
        )
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
            listener: (pages, asked) => {
              for (const parentId of parents)
                publish({
                  type: "invalidate",
                  parentId,
                  // Polls and other routine checks change the list only
                  // when its rows do (no refreshing spinner every poll).
                  quiet: !asked,
                  // A short list is read whole, so no row of it lags.
                  pages:
                    pages === "first" &&
                    collection.getBranch(parentId).ids.length >
                      WHOLE_POLL_PAGES *
                        (section.source?.pageSize ?? SIDEBAR_SESSION_PAGE)
                      ? "first"
                      : "loaded",
                });
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
 * The open chat's row when it is older than every loaded row: the list
 * shows it past its end (`CollectionTree`'s `tail`) instead of reading every
 * page above it, so opening an old chat costs one read and never deepens
 * what later refreshes read. A fork brings in the top-level chat it hangs
 * under. Lists of one chat's children hold a single family and need none.
 */
export function useOpenSidebarSession({
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
}): SessionTreeItem | undefined {
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
      "open",
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
  // Only a chat older than the loaded rows belongs past their end; a newer
  // one arrives with the next poll.
  const lastId = root.ids.at(-1);
  const last = lastId ? collection.getItem(lastId) : undefined;
  const shown = Boolean(
    active &&
      !scoped &&
      !loaded &&
      target &&
      root.cursor &&
      !root.ids.includes(target.id) &&
      target.visibility !== "archived" &&
      (includeLatent || target.visibility === "promoted") &&
      projectSidebarItems([target], section).length &&
      !sidebarItemPresentation({ section, id: target.id }).hide &&
      last &&
      Date.parse(last.createdAt) >= Date.parse(target.createdAt),
  );
  return useMemo(
    () =>
      shown && target
        ? { ...target, parentId: null, hasChildren: false }
        : undefined,
    [shown, target],
  );
}
