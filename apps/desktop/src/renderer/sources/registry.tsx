import type {
  AppCollectionItem,
  AppCollections,
  CollectionChange,
  CollectionPage,
} from "@catamorphic/app";
import {
  type AgentSessionData,
  agentSessionQueryKey,
  type SessionSnapshot,
  useCatamorphic,
} from "@catamorphic/react";
import { useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  createElement,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useRef,
} from "react";
import { OPEN_ACTIONS, type OpenMode } from "../../shared/open-mode.js";
import {
  isHostAction,
  isWorkSourceName,
  SESSION_WORK_SOURCES,
  type WorkSourceName,
} from "../../shared/sidebar.js";
import type {
  SidebarSourceItem,
  SidebarSourceSession,
} from "../../shared/sidebar-source.js";
import { CHIPS_OWNER_ID } from "../../shared/workspace-config.js";
import { desktopApi } from "../lib/desktop-api.js";
import { readSidebarSessionPage } from "../lib/sidebar-sessions.js";
import { tabKey } from "../lib/workspace-types.js";
import { activitySource, sessionSource } from "./activity.js";
import { bookmarksSource } from "./bookmarks.js";
import { gitSource, prsSource } from "./changes.js";
import { chatRow, chatsSource } from "./chats.js";
import type { SectionSource } from "./contract.js";
import type { WorkSourceDeps, WorkSourceHost } from "./deps.js";
import { resourcesSource } from "./processes.js";
import { remoteSource } from "./remote.js";
import {
  appsSource,
  filesSource,
  tabsSource,
  workflowsSource,
} from "./resources.js";
import { runRowAction } from "./run.js";
import { callProjectWorkflow } from "./workflow-call.js";

/**
 * Work's lists, as one window serves them (ADR 0234): to its sections, to
 * the palette, to app widgets through their grants, and to modules through
 * `work`. Every list is a `SectionSource`; nothing here knows how a section
 * draws one.
 */
export interface WorkSources extends AppCollections {
  get: (name: WorkSourceName) => SectionSource;
  /** A row's action; an action that asks for input takes its `values`. */
  execute: (
    request: Parameters<AppCollections["execute"]>[0] & {
      values?: Record<string, string>;
    },
  ) => Promise<void>;
  /** One page of a list's own rows, remembered for `execute`. */
  rows: (request: {
    source: string;
    parentId?: string | null;
    cursor?: string;
    signal: AbortSignal;
  }) => Promise<CollectionPage<SidebarSourceItem>>;
  /** Open a workspace target the way this window opens links. */
  open: (url: string, mode: OpenMode) => unknown;
  /**
   * The Work lists a module (by section or mode id) has read, now and as
   * it reads more: its section follows their changes (ADR 0234).
   */
  watchReads: (
    ownerId: string,
    onRead: (name: WorkSourceName) => void,
  ) => () => void;
  /** A module read one of Work's lists while serving `ownerId`. */
  noteRead: (ownerId: string, name: WorkSourceName) => void;
  /**
   * Every row of a source, roots then children, bounded and unique; for
   * search. Search reads are not live views.
   */
  readAll: (request: {
    source: string;
    signal: AbortSignal;
    /** Chats: archived ones instead of promoted ones. */
    archived?: boolean;
    /** Walk into rows with children (default true). */
    children?: boolean;
    limit?: number;
  }) => Promise<AppCollectionItem[]>;
}

/** A row as app widgets and the palette see it (`@catamorphic/app`). */
function appItem(
  name: WorkSourceName,
  row: SidebarSourceItem,
): AppCollectionItem {
  // Rows with an address open it; a changed file or a review opens through
  // its list (a checkout, a folder of them, opens nothing).
  const opens =
    Boolean(row.url) ||
    ((name === "git" || name === "prs") && !row.hasChildren);
  return {
    id: row.id,
    parentId: row.parentId ?? null,
    hasChildren: row.hasChildren,
    label: row.label,
    ...(row.description ? { description: row.description } : {}),
    ...(row.icon ? { icon: row.icon } : {}),
    badges: (row.badges ?? []).map((badge) =>
      typeof badge === "string" ? badge : badge.label,
    ),
    ...(row.progress !== undefined ? { progress: row.progress } : {}),
    actions: [
      ...(opens
        ? [
            { id: "open", label: "Open" },
            ...OPEN_ACTIONS.map((entry) => ({
              id: entry.action,
              label: entry.label,
            })),
          ]
        : []),
      // A tab's address is its key in this window, not a link to share.
      ...(row.url && name !== "tabs"
        ? [{ id: "copy-url", label: "Copy link" }]
        : []),
      ...[...(row.menu ?? []), ...(row.actions ?? [])]
        .filter(
          (entry) => !entry.url && !entry.input && !isHostAction(entry.action),
        )
        .map((entry) => ({
          id: entry.action,
          label: entry.label,
          ...(entry.icon ? { icon: entry.icon } : {}),
          ...(entry.disabledReason
            ? { disabledReason: entry.disabledReason }
            : {}),
        })),
    ],
    ...(row.data ? { data: row.data } : {}),
  };
}

export function useWorkSources({
  projectId,
  profileId,
  writesProgram,
  remote,
  host,
  open,
}: {
  projectId: string;
  profileId?: string;
  writesProgram: boolean;
  remote: boolean;
  host: WorkSourceHost;
  open: (url: string, mode: OpenMode) => unknown;
}): WorkSources {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  const hostRef = useRef(host);
  hostRef.current = host;
  const openRef = useRef(open);
  openRef.current = open;
  const listeners = useRef({
    tabs: new Set<() => void>(),
    unread: new Set<() => void>(),
  });
  // Only what a tab row shows (or which tab is in front) changing, or which
  // chats were read, reads those lists again.
  const signatures = {
    tabs: [
      host.activeTabKey,
      ...host.tabs.map((tab) =>
        [
          tabKey(tab),
          tab.label,
          tab.detail,
          tab.bookmarkUrl,
          tab.kind === "browser" ? tab.faviconUrl : "",
          tab.groupId,
          host.tabGroups.find((group) => group.parentKey === tabKey(tab))
            ?.memberKeys.length,
          // What a chat is doing: a list sorted by it moves its rows.
          tab.working,
          tab.waiting,
          tab.attention,
          tab.awaitingInput,
          tab.unread,
        ].join("\u0000"),
      ),
    ].join("\n"),
    unread: [...host.unreadSessionIds].sort().join("\n"),
  };
  const previous = useRef(signatures);
  useEffect(() => {
    for (const topic of ["tabs", "unread"] as const) {
      if (previous.current[topic] === signatures[topic]) continue;
      for (const listener of listeners.current[topic]) listener();
    }
    previous.current = signatures;
  });
  return useMemo(() => {
    const deps: WorkSourceDeps = {
      projectId,
      profileId,
      apiClient,
      queryClient,
      writesProgram,
      remote,
      host: () => hostRef.current,
      onWindowChange: (topic, listener) => {
        listeners.current[topic].add(listener);
        return () => listeners.current[topic].delete(listener);
      },
    };
    const lists: Record<WorkSourceName, SectionSource> = {
      pinned: bookmarksSource(deps, "pinned"),
      bookmarks: bookmarksSource(deps, "project"),
      library: bookmarksSource(deps, "library"),
      workflows: workflowsSource(deps),
      apps: appsSource(deps),
      chats: chatsSource(deps, "chats"),
      subsessions: chatsSource(deps, "subsessions"),
      activity: activitySource(deps),
      files: filesSource(deps),
      tabs: tabsSource(deps),
      remote: remoteSource(deps),
      git: gitSource(deps),
      prs: prsSource(deps),
      session: sessionSource(deps),
      resources: resourcesSource(deps),
    };
    const reads = new Map<string, Set<WorkSourceName>>();
    const readers = new Map<string, Set<(name: WorkSourceName) => void>>();
    /** Rows read through the facade, by source, for its actions. */
    const known = new Map<string, Map<string, SidebarSourceItem>>();
    const loaded = new Map<string, Set<string | null>>();
    const requireName = (source: string): WorkSourceName => {
      if (!isWorkSourceName(source))
        throw new Error(`Source ${source} is not one of Work's lists`);
      // Git reads the program's checkouts: only for people who edit it.
      if (!writesProgram && source === "git")
        throw new Error(`Source ${source} is not available here`);
      return source;
    };
    const remember = (name: string, rows: readonly SidebarSourceItem[]) => {
      const rowsOf = known.get(name) ?? new Map<string, SidebarSourceItem>();
      for (const row of rows) rowsOf.set(row.id, row);
      known.set(name, rowsOf);
    };
    /**
     * The chat a chat-scoped list shows when read here: the chat beside the
     * sidebar, its metadata read where the window reads sessions.
     */
    const sessionFor = async (
      name: WorkSourceName,
      signal: AbortSignal,
    ): Promise<SidebarSourceSession | undefined> => {
      const id = hostRef.current.sessionId;
      if (!id || !SESSION_WORK_SOURCES.includes(name)) return undefined;
      if (name !== "session") return { id, title: null, metadata: {} };
      // The chat's reader keeps its fields; otherwise its snapshot has them.
      const cached = queryClient.getQueryData<AgentSessionData>(
        agentSessionQueryKey(projectId, id),
      )?.state.session;
      if (cached)
        return { id, title: cached.title ?? null, metadata: cached.metadata };
      const response = await apiClient.GET(
        "/api/projects/{projectId}/agent/sessions/{sessionId}",
        {
          params: { path: { projectId, sessionId: id } },
          signal,
          // The snapshot is the protocol's own shape, as the chat reads it.
          parseAs: "text",
        },
      );
      if (typeof response.data !== "string")
        throw new Error("Could not read this chat.");
      const detail: { snapshot: SessionSnapshot } = JSON.parse(response.data);
      const fields = detail.snapshot.session;
      return { id, title: fields.title ?? null, metadata: fields.metadata };
    };
    const load = async (
      name: WorkSourceName,
      request: {
        parentId: string | null;
        cursor?: string;
        signal: AbortSignal;
        size?: number;
      },
    ) => {
      const session = await sessionFor(name, request.signal);
      return lists[name].load({ ...request, ...(session ? { session } : {}) });
    };
    const rows: WorkSources["rows"] = async ({
      source,
      parentId,
      cursor,
      signal,
    }) => {
      const name = requireName(source);
      const page = await load(name, {
        parentId: parentId ?? null,
        cursor,
        signal,
      });
      signal.throwIfAborted();
      remember(name, page.items);
      const parents = loaded.get(name) ?? new Set<string | null>();
      parents.add(parentId ?? null);
      loaded.set(name, parents);
      return page;
    };
    const read: WorkSources["read"] = async (request) => {
      const name = requireName(request.source);
      const page = await rows(request);
      return {
        items: page.items.map((row) => appItem(name, row)),
        ...(page.cursor ? { cursor: page.cursor } : {}),
      };
    };
    /** Archived chats are found in the palette, never kept in a list. */
    const readArchived = async (signal: AbortSignal) => {
      const page = await readSidebarSessionPage({
        apiClient,
        client: queryClient,
        projectId,
        signal,
        query: {
          limit: 100,
          offset: 0,
          visibility: "archived",
          rootsOnly: "true",
        },
      });
      const rows = page.items.map((session) =>
        chatRow({ deps, session, parentId: null }),
      );
      remember("chats", rows);
      return rows.map((row) => appItem("chats", row));
    };
    const sources: WorkSources = {
      get: (name) => lists[name],
      rows,
      noteRead: (ownerId, name) => {
        const names = reads.get(ownerId) ?? new Set<WorkSourceName>();
        if (names.has(name)) return;
        names.add(name);
        reads.set(ownerId, names);
        for (const listener of readers.get(ownerId) ?? []) listener(name);
      },
      watchReads: (ownerId, onRead) => {
        const listeners = readers.get(ownerId) ?? new Set();
        listeners.add(onRead);
        readers.set(ownerId, listeners);
        for (const name of reads.get(ownerId) ?? []) onRead(name);
        return () => listeners.delete(onRead);
      },
      open: (url, mode) => openRef.current(url, mode),
      read,
      readAll: async ({
        source,
        signal,
        archived,
        children = true,
        limit = 1000,
      }) => {
        const name = requireName(source);
        if (archived && name === "chats") return readArchived(signal);
        const rows = new Map<string, AppCollectionItem>();
        const queue: Array<string | null> = [null];
        // Activity already lists running children beside their parents.
        const walk = children && name !== "activity";
        let pages = 0;
        while (queue.length && rows.size < limit && pages < 50) {
          const parentId = queue.shift() ?? null;
          let cursor: string | undefined;
          do {
            pages += 1;
            // Everything at once: as few reads as a source allows.
            const page = await load(name, {
              parentId,
              cursor,
              signal,
              size: 100,
            });
            remember(name, page.items);
            for (const row of page.items) {
              if (rows.has(row.id)) continue;
              rows.set(row.id, appItem(name, row));
              if (walk && row.hasChildren) queue.push(row.id);
            }
            cursor = page.cursor;
          } while (cursor && rows.size < limit && pages < 50);
        }
        return [...rows.values()].slice(0, limit);
      },
      execute: async ({ source, itemId, action, values, signal }) => {
        const name = requireName(source);
        const row = known.get(name)?.get(itemId);
        if (!row) throw new Error("This item is no longer available");
        await runRowAction({
          source: lists[name],
          row,
          itemId,
          action,
          ...(values ? { values } : {}),
          signal,
          open: (url, mode) => openRef.current(url, mode),
        });
      },
      subscribe: ({ source, publish }) => {
        const name = requireName(source);
        return (
          lists[name].subscribe?.(
            (change: CollectionChange<SidebarSourceItem>) =>
              publish(
                change.type === "upsert"
                  ? {
                      type: "upsert",
                      items: change.items.map((row) => appItem(name, row)),
                    }
                  : change,
              ),
            {
              branches: () => [...(loaded.get(name) ?? [null])],
              branchSize: () => 0,
              fail: () => {},
            },
          ) ?? (() => {})
        );
      },
    };
    return sources;
  }, [apiClient, queryClient, projectId, profileId, writesProgram, remote]);
}

/** A widget sees only the sources its section grants (ADR 0102). */
export function grantSources(
  sources: AppCollections,
  granted: readonly string[] | undefined,
): AppCollections {
  const allowed = new Set(granted ?? []);
  const require = (source: string) => {
    if (!allowed.has(source))
      throw new Error(`Source ${source} is not granted to this widget`);
  };
  return {
    read: async (request) => {
      require(request.source);
      return sources.read(request);
    },
    execute: async (request) => {
      require(request.source);
      return sources.execute(request);
    },
    subscribe: (request) => {
      require(request.source);
      return sources.subscribe?.(request) ?? (() => {});
    },
  };
}

const WorkSourcesContext = createContext<WorkSources | null>(null);

export function WorkSourcesProvider({
  value,
  children,
}: {
  value: WorkSources;
  children: ReactNode;
}) {
  return createElement(WorkSourcesContext.Provider, { value }, children);
}

export function useWorkSourcesContext(): WorkSources {
  const sources = useContext(WorkSourcesContext);
  if (!sources) throw new Error("Workspace lists need a WorkSourcesProvider.");
  return sources;
}

/**
 * Answer modules that ask Work for something while they serve this window
 * (ADR 0234): one of Work's lists, a row's action, or a project workflow.
 * Main checked the section's grants before asking.
 */
export function useAnswerSourceWork({
  sources,
  projectId,
}: {
  sources: WorkSources | null;
  projectId: string | undefined;
}) {
  const { apiClient } = useCatamorphic();
  const ref = useRef(sources);
  ref.current = sources;
  useEffect(
    () =>
      desktopApi.onSidebarSourceWork(
        ({ callId, projectId: asked, sectionId, call }) => {
          // A chat's chips answer for their own module, beside the chat.
          if (sectionId === CHIPS_OWNER_ID) return;
          const reply = (result: {
            ok: boolean;
            value?: unknown;
            error?: string;
          }) => void desktopApi.sidebarSourceWorkResult({ callId, ...result });
          const current = ref.current;
          if (!current || asked !== projectId) {
            reply({ ok: false, error: "This project is not open here." });
            return;
          }
          const signal = new AbortController().signal;
          const answer = async (): Promise<unknown> => {
            if (call.op === "read") {
              if (isWorkSourceName(call.source))
                current.noteRead(sectionId, call.source);
              // Rows read here are the ones work.execute can act on.
              return current.rows({
                source: call.source,
                parentId: call.parentId ?? null,
                cursor: call.cursor,
                signal,
              });
            }
            if (call.op === "execute") {
              await current.execute({
                source: call.source,
                itemId: call.itemId,
                action: call.action,
                ...(call.values ? { values: call.values } : {}),
                signal,
              });
              return null;
            }
            return callProjectWorkflow({
              apiClient,
              projectId: asked,
              workflow: call.workflow,
              input: call.input,
            });
          };
          void answer().then(
            (value) => reply({ ok: true, value }),
            (cause: unknown) =>
              reply({
                ok: false,
                error: cause instanceof Error ? cause.message : String(cause),
              }),
          );
        },
      ),
    [apiClient, projectId],
  );
}
