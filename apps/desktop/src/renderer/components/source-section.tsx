import { type Collection, createCollection } from "@catamorphic/app";
import {
  CollectionTree,
  type TreeDragAndDrop,
  type TreeDropTarget,
  useCollection,
} from "@catamorphic/app/ui";
import { useAgentSessionFields } from "@catamorphic/react";
import type { AgentSession } from "@catamorphic/react/types";
import { useQuery } from "@tanstack/react-query";
import {
  type DragEvent as ReactDragEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { chatBookmarkUrl } from "../../shared/bookmark-target.js";
import { type OpenMode, openModeForAction } from "../../shared/open-mode.js";
import {
  isHostAction,
  type SidebarActionInput,
  type SidebarMenuEntry,
  sessionSection,
} from "../../shared/sidebar.js";
import type {
  SidebarSourceItem,
  SidebarSourceSession,
} from "../../shared/sidebar-source.js";
import { readBookmarkDrop } from "../lib/bookmark-drag.js";
import {
  currentSidebarDrag,
  isOwnSidebarDrag,
  readSidebarItemDrag,
  sidebarItemDragSpec,
} from "../lib/sidebar-drag.js";
import { TAB_DRAG_TYPE } from "../lib/tab-drag.js";
import type { SectionSource } from "../sources/contract.js";
import { runRowAction } from "../sources/run.js";
import {
  chatTarget,
  frontKeys,
  rowDragPayload,
  targetKey,
} from "../sources/targets.js";
import { ActionInputDialog } from "./action-input-dialog.js";
import { fadeEdges } from "./catamorphic/edge-fade.js";
import { RowIcon } from "./row-icon.js";
import { SessionAccess } from "./session-access.js";
import {
  sidebarItemPresentation,
  useSidebarContent,
  useSidebarContribution,
  useSidebarItemCount,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { useSidebarHost } from "./sidebar-host.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarSessionInspector } from "./sidebar-session-inspector.js";
import { emptySentence } from "./sidebar-status.js";

const failure = (cause: unknown) =>
  cause instanceof Error ? cause : new Error(String(cause));

/** A value as JSON with object keys in order: the same for the same data. */
function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, entry: unknown) =>
    typeof entry === "object" && entry !== null && !Array.isArray(entry)
      ? Object.fromEntries(
          Object.entries(entry).sort(([a], [b]) =>
            a < b ? -1 : a > b ? 1 : 0,
          ),
        )
      : entry,
  );
}

/** How long a sentence an action reported stays under its section. */
const MESSAGE_MS = 8000;

/** A pending action that asks for values first. */
interface InputRequest {
  label: string;
  input: SidebarActionInput;
  run: (values: Record<string, string>) => Promise<unknown>;
}

/**
 * Every list section, whatever its source (ADR 0234): Work's own lists, a
 * person's module, a layout's static items. Rows open their address, run
 * their source's actions, drag where their source allows, and get what
 * Work knows about the target they name. Nothing here branches on which
 * source it draws.
 */
export function SourceSection({
  projectId,
  source,
}: {
  projectId: string;
  source: SectionSource;
}) {
  const section = useSidebarContribution()?.section;
  // A session-scoped section reads its chat where the chat is read.
  return section && sessionSection(section) ? (
    <SessionAccess projectId={projectId}>
      <SourceView projectId={projectId} source={source} />
    </SessionAccess>
  ) : (
    <SourceView projectId={projectId} source={source} />
  );
}

function SourceView({
  projectId,
  source,
}: {
  projectId: string;
  source: SectionSource;
}) {
  const contribution = useSidebarContribution();
  const host = useSidebarHost();
  const section = contribution?.section;
  const sectionId = section?.id ?? "";
  const surface = contribution?.surface ?? { kind: "none" };
  const [subscriptionError, setSubscriptionError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [message, setMessage] = useState<string>();
  const [inputRequest, setInputRequest] = useState<InputRequest | null>(null);
  const [capabilities, setCapabilities] = useState(() => source.capabilities());
  useEffect(() => setCapabilities(source.capabilities()), [source]);
  // A session-scoped section (`when.session`) is given the chat in front
  // (ADR 0226), and keeps the one it showed while it leaves.
  const sessionScoped = section ? sessionSection(section) : false;
  const surfaceSessionId = sessionScoped ? surface.sessionId : undefined;
  const [sessionId, setSessionId] = useState(surfaceSessionId);
  if (surfaceSessionId && surfaceSessionId !== sessionId)
    setSessionId(surfaceSessionId);
  const shown =
    (contribution?.relevant ?? true) && (contribution?.visible ?? true);
  // On screen it follows the chat, so what is set outside a turn shows.
  const {
    fields,
    error: sessionError,
    refetch: refetchSession,
  } = useAgentSessionFields(projectId, sessionScoped ? sessionId : undefined, {
    live: sessionScoped && shown,
  });
  const session = useMemo<SidebarSourceSession | undefined>(
    () =>
      fields
        ? { id: fields.id, title: fields.title, metadata: fields.metadata }
        : undefined,
    [fields],
  );
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const withSession = () =>
    sessionRef.current ? { session: sessionRef.current } : {};
  // Header actions run beside the rows, with the same chat.
  useEffect(() => {
    if (contribution?.chat) contribution.chat.current = session;
  }, [contribution?.chat, session]);
  const parents = useRef(new Set<string | null>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: another source, or the chat a session-scoped section shows, must replace the cache and release old leases.
  const collection = useMemo(() => {
    parents.current = new Set();
    const subscribe = source.subscribe;
    const created: Collection<SidebarSourceItem> = createCollection({
      source: {
        load: async ({ parentId, cursor, signal }) => {
          parents.current.add(parentId);
          try {
            const page = await source.load({
              parentId,
              cursor,
              signal,
              ...withSession(),
            });
            // A module says what it exports with its pages.
            const now = source.capabilities();
            setCapabilities((current) =>
              current.move === now.move &&
              current.drop === now.drop &&
              current.reveal === now.reveal
                ? current
                : now,
            );
            return page;
          } catch (cause) {
            throw failure(cause);
          }
        },
        ...(subscribe
          ? {
              subscribe: (publish) =>
                subscribe(publish, {
                  ...withSession(),
                  branches: () => [...parents.current],
                  branchSize: (parentId) =>
                    created.getBranch(parentId).ids.length,
                  fail: setSubscriptionError,
                }),
            }
          : {}),
      },
    });
    return created;
  }, [source, sessionScoped ? sessionId : undefined]);
  // A session-scoped source runs only with its chat (ADR 0226): until the
  // chat is read nothing loads it, a refresh reads the chat, and a failed
  // read is the section's error.
  const awaitingSession = sessionScoped && session === undefined;
  const sessionFailed = awaitingSession && sessionError !== null;
  // A section hidden for being empty keeps only a root lease, to come back
  // when rows arrive; the tree owns expanded branch leases while visible.
  // With its sidebar closed, it reads nothing.
  const active =
    (contribution?.relevant ?? true) &&
    ((contribution?.visible ?? true) || contribution?.observeEmpty === true) &&
    !awaitingSession;
  const { root, revision } = useCollection({
    collection,
    active,
    mode: "preview",
    projected: true,
  });
  // What an agent sets on the session shows: the section loads again when
  // the chat's title or metadata changes (the same data in another key
  // order is no change), at once when shown and when it is shown next
  // otherwise. Another chat is a new collection, which loads by itself.
  const sessionKey = useMemo(
    () => (session ? stableJson(session) : undefined),
    [session],
  );
  const loadedWith = useRef({ collection, sessionKey });
  const stale = useRef(false);
  useEffect(() => {
    const previous = loadedWith.current;
    loadedWith.current = { collection, sessionKey };
    if (previous.collection !== collection) stale.current = false;
    else if (
      previous.sessionKey !== undefined &&
      sessionKey !== undefined &&
      previous.sessionKey !== sessionKey
    )
      stale.current = true;
    if (!active || !stale.current) return;
    stale.current = false;
    void collection.load().catch(() => undefined);
  }, [collection, sessionKey, active]);
  const tiles = section?.presentation === "tiles";
  const hidden = useCallback(
    (row: SidebarSourceItem) =>
      Boolean(
        sidebarItemPresentation({ section, id: row.id }).hide ?? row.hide,
      ),
    [section],
  );
  // Tiles draw root rows without children; the tree draws the rest.
  const project = useCallback(
    (items: readonly SidebarSourceItem[]) =>
      items.filter(
        (row) => !hidden(row) && !(tiles && !row.parentId && !row.hasChildren),
      ),
    [hidden, tiles],
  );
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision versions the loaded rows read here.
  const roots = useMemo(
    () =>
      root.ids.flatMap((id) => {
        const row = collection.getItem(id);
        return row && !hidden(row) ? [row] : [];
      }),
    [root.ids, collection, hidden, revision],
  );
  useSidebarItemCount(roots.length);
  const refresh = useCallback(() => {
    setSubscriptionError(undefined);
    setActionError(undefined);
    if (!awaitingSession) return collection.load();
    return sessionId ? refetchSession() : undefined;
  }, [collection, awaitingSession, sessionId, refetchSession]);
  useSidebarRefresh(refresh);
  useSidebarContent({
    state:
      sessionFailed || root.status === "error" || subscriptionError
        ? "error"
        : root.status === "idle" || root.status === "loading"
          ? "loading"
          : roots.length
            ? "ready"
            : "empty",
    refreshing: root.fetching && root.ids.length > 0,
    idle: awaitingSession ? !sessionId : !root.fetching,
    error: sessionFailed
      ? "Could not read this chat."
      : (subscriptionError ?? root.error),
    retry: refresh,
    empty: source.empty,
    droppable: capabilities.drop,
  });
  useEffect(() => {
    if (!message) return;
    const timer = setTimeout(() => setMessage(undefined), MESSAGE_MS);
    return () => clearTimeout(timer);
  }, [message]);

  // What is in front: the row naming it is the active one. The surface is a
  // new object every render; what it names changes rarely.
  // biome-ignore lint/correctness/useExhaustiveDependencies: the keys are what frontKeys reads.
  const front = useMemo(
    () => frontKeys(surface),
    [surface.sessionId, surface.path, surface.url, surface.key],
  );
  const frontUrl = surface.sessionId
    ? chatBookmarkUrl({ projectId, sessionId: surface.sessionId })
    : surface.key;
  // biome-ignore lint/correctness/useExhaustiveDependencies: revision versions the loaded rows read here.
  const activeId = useMemo(() => {
    for (const parentId of parents.current)
      for (const id of collection.getBranch(parentId).ids) {
        const key = targetKey(collection.getItem(id)?.url);
        if (key && front.has(key)) return id;
      }
    return undefined;
  }, [collection, front, revision]);
  // A target in front that no loaded page holds shows past the loaded rows
  // when its source can place it (a chat older than every loaded one).
  const lastRow = root.ids.at(-1)
    ? collection.getItem(root.ids.at(-1) ?? "")
    : undefined;
  const reveal = source.reveal;
  const revealed = useQuery({
    queryKey: [
      "desktop",
      "sidebar-reveal",
      projectId,
      sectionId,
      frontUrl,
      lastRow?.id,
    ],
    enabled: Boolean(
      reveal &&
        capabilities.reveal &&
        active &&
        frontUrl &&
        !activeId &&
        root.cursor,
    ),
    staleTime: 30_000,
    queryFn: ({ signal }) =>
      reveal && frontUrl
        ? reveal({ url: frontUrl, after: lastRow, signal, ...withSession() })
        : null,
  });
  const tail = useMemo(
    () =>
      revealed.data && !activeId && !hidden(revealed.data)
        ? [revealed.data]
        : undefined,
    [revealed.data, activeId, hidden],
  );
  // The row in front, a revealed one included.
  const revealedKey = targetKey(tail?.[0]?.url);
  const selectedId =
    activeId ??
    (revealedKey && front.has(revealedKey) ? tail?.[0]?.id : undefined);

  const open = (url: string, mode: OpenMode) => contribution?.open(url, mode);
  const act = async (
    row: SidebarSourceItem | undefined,
    itemId: string,
    action: string,
    values?: Record<string, string>,
    mode?: OpenMode,
  ) => {
    const effect = await runRowAction({
      source,
      row,
      itemId,
      action,
      values,
      mode,
      signal: new AbortController().signal,
      open,
      ...withSession(),
    });
    if (effect?.message) setMessage(effect.message);
    // Its subscription says so too, but that may still be settling; the
    // person's own action must show regardless. Opening something changes
    // no list.
    if (!isHostAction(action)) void collection.load().catch(() => undefined);
  };
  const runEntry = (
    row: SidebarSourceItem | undefined,
    itemId: string,
    entry: SidebarMenuEntry,
  ) => {
    const input = entry.input;
    if (input) {
      setInputRequest({
        label: entry.label,
        input,
        run: (values) => act(row, itemId, entry.action, values),
      });
      return Promise.resolve();
    }
    return act(row, itemId, entry.action);
  };

  /**
   * Before: the target itself. After: whatever follows it among its
   * siblings, past the row being dragged (dropped just above itself, a row
   * stays where it is rather than going last).
   */
  const slotFor = (
    target: TreeDropTarget<SidebarSourceItem>,
    dragged?: string,
  ) => {
    if (!target.item) return { parentId: null, beforeId: undefined };
    if (target.position === "inside")
      return { parentId: target.item.id, beforeId: undefined };
    const parentId = target.item.parentId ?? null;
    if (target.position === "before")
      return { parentId, beforeId: target.item.id };
    const siblings = collection
      .getBranch(parentId)
      .ids.filter((id) => id !== dragged);
    const index = siblings.indexOf(target.item.id);
    return { parentId, beforeId: index >= 0 ? siblings[index + 1] : undefined };
  };
  /** A row never lands inside itself or what it holds. */
  const insideItself = (dragged: string, parentId: string | null) => {
    for (let cursor = parentId; cursor; ) {
      if (cursor === dragged) return true;
      cursor = collection.getItem(cursor)?.parentId ?? null;
    }
    return false;
  };
  const accepts = (
    types: readonly string[],
    target: TreeDropTarget<SidebarSourceItem>,
  ) => {
    if (
      target.position === "inside" &&
      target.item &&
      !target.item.hasChildren &&
      !target.item.acceptsChildren
    )
      return false;
    if (isOwnSidebarDrag(types, sectionId)) {
      const drag = currentSidebarDrag();
      return (
        capabilities.move &&
        drag !== null &&
        drag.id !== target.item?.id &&
        !insideItself(drag.id, slotFor(target, drag.id).parentId)
      );
    }
    return capabilities.drop && types.includes(TAB_DRAG_TYPE);
  };
  const dropInto = (
    transfer: DataTransfer,
    target: TreeDropTarget<SidebarSourceItem>,
  ) => {
    const own = isOwnSidebarDrag(transfer.types, sectionId)
      ? readSidebarItemDrag(transfer)
      : null;
    const slot = slotFor(target, own?.id);
    const signal = new AbortController().signal;
    const call = (async () => {
      if (own) {
        if (!source.move) throw new Error("This list keeps its own order.");
        await source.move({
          itemId: own.id,
          ...slot,
          signal,
          ...withSession(),
        });
        return;
      }
      const dropped = readBookmarkDrop(transfer);
      if (!dropped || !source.drop)
        throw new Error("Only pages, chats and bookmarks can be dropped here.");
      let kind = "bookmark";
      try {
        kind = String(JSON.parse(transfer.getData(TAB_DRAG_TYPE)).kind ?? kind);
      } catch {}
      await source.drop({
        ...slot,
        payload: { kind, label: dropped.label, url: dropped.url },
        signal,
        ...withSession(),
      });
    })();
    setActionError(undefined);
    void call.then(
      () => collection.load().catch(() => undefined),
      (cause: unknown) => setActionError(failure(cause).message),
    );
  };
  const drag = (row: SidebarSourceItem) =>
    sidebarItemDragSpec(
      {
        sectionId,
        id: row.id,
        parentId: row.parentId ?? null,
        kind: row.hasChildren ? "folder" : "item",
        label: row.label,
        url: row.url,
      },
      rowDragPayload({
        sectionId,
        id: row.id,
        label: row.label,
        url: row.url,
        openTab: row.url ? host?.openTab(row.url) : undefined,
      }),
    );
  // A row standing for a tab hands its drag to the window while it lasts,
  // as the strip's tab does: it can tile to either side.
  const tabDragStart = (row: SidebarSourceItem) => {
    if (row.url && host?.openTab(row.url)) host.onTabDrag(row.url);
  };
  const tabDragEnd = () => host?.onTabDrag(null);
  const dragAndDrop: TreeDragAndDrop<SidebarSourceItem> = {
    drag,
    accept: accepts,
    onDrop: dropInto,
    onDragStart: tabDragStart,
    onDragEnd: tabDragEnd,
  };
  const renderRow = (
    row: SidebarSourceItem,
    tree?: {
      depth: number;
      hasChildren: boolean;
      expanded: boolean;
      toggle: () => void;
    },
  ) => (
    <SourceRow
      key={row.id}
      row={row}
      projectId={projectId}
      tile={!tree}
      disclosure={
        tree?.hasChildren
          ? { open: tree.expanded, onToggle: tree.toggle }
          : undefined
      }
      active={row.id === selectedId}
      canAct={Boolean(source.action)}
      onOpen={(mode) => {
        if (row.url || (!tree?.hasChildren && source.action))
          void act(row, row.id, "open", undefined, mode).catch(
            (cause: unknown) => setActionError(failure(cause).message),
          );
        else tree?.toggle();
      }}
      onAction={(entry) => runEntry(row, row.id, entry)}
    />
  );
  const tileRows = tiles
    ? roots.filter((row) => !row.hasChildren && !hidden(row))
    : [];
  // An empty list that takes drops has no rows to drop between: its empty
  // sentence is the place to drop. It is there before the drag starts, so
  // a drag never adds space to the sidebar.
  // Drawn only once the section says it is empty, so its chrome and the
  // list never disagree (a skeleton above a sentence).
  const emptyDrop =
    capabilities.drop &&
    root.status === "ready" &&
    roots.length === 0 &&
    (contribution?.status.state ?? "empty") === "empty";
  return (
    <div
      className="sidebar-live-source"
      data-sidebar-source={sectionId}
      aria-busy={Boolean(root.fetching)}
    >
      {((tiles && tileRows.length > 0) || emptyDrop) && (
        <SourceTiles
          rows={tileRows}
          empty={
            tileRows.length === 0
              ? emptySentence(section?.empty, source.empty)
              : undefined
          }
          sectionId={sectionId}
          accepts={accepts}
          onDrop={dropInto}
          drag={drag}
          render={(row) => renderRow(row)}
        />
      )}
      <CollectionTree
        collection={collection}
        active={(contribution?.visible ?? true) && !awaitingSession}
        label={section?.title || source.title}
        className="cat-edge-fade"
        onViewport={fadeEdges}
        indent={14}
        height={section?.height}
        rowHeight={section?.rowHeight}
        project={project}
        tail={tail}
        selectedId={selectedId}
        initiallyExpanded={opensFirst}
        motionClasses={{
          enter: "animate-session-row-in",
          exit: "animate-session-row-out",
        }}
        renderStatus={() => null}
        dragAndDrop={dragAndDrop}
        renderItem={(row, tree) => renderRow(row, tree)}
      />
      {actionError && (
        <p role="alert" className="sidebar-empty-state text-danger">
          {actionError}
        </p>
      )}
      <p role="status" className={message ? "sidebar-empty-state" : "sr-only"}>
        {message ?? ""}
      </p>
      <ActionInputDialog
        request={inputRequest}
        onClose={() => setInputRequest(null)}
      />
    </div>
  );
}

/** A row with children opens the first time it loads when it says so. */
const opensFirst = (row: SidebarSourceItem) => row.collapsed === false;

/**
 * Root rows as a grid of icons that reorder and take drops like the tree;
 * empty, its sentence is the place to drop the first.
 */
function SourceTiles({
  rows,
  empty,
  sectionId,
  accepts,
  onDrop,
  drag,
  render,
}: {
  rows: readonly SidebarSourceItem[];
  /** The empty sentence, when there are no rows. */
  empty?: string;
  sectionId: string;
  accepts: (
    types: readonly string[],
    target: TreeDropTarget<SidebarSourceItem>,
  ) => boolean;
  onDrop: (
    transfer: DataTransfer,
    target: TreeDropTarget<SidebarSourceItem>,
  ) => void;
  drag: (row: SidebarSourceItem) => ReturnType<typeof sidebarItemDragSpec>;
  render: (row: SidebarSourceItem) => ReactNode;
}) {
  const [over, setOver] = useState<{
    id: string | null;
    position: "before" | "after" | "inside";
  } | null>(null);
  const targetOf = (
    event: ReactDragEvent<HTMLElement>,
    row?: SidebarSourceItem,
  ): TreeDropTarget<SidebarSourceItem> => {
    if (!row) return { item: null, position: "inside" };
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      item: row,
      position:
        (event.clientX - rect.left) / Math.max(1, rect.width) < 0.5
          ? "before"
          : "after",
    };
  };
  const handlers = (row?: SidebarSourceItem) => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const target = targetOf(event, row);
      if (
        (row && currentSidebarDrag()?.id === row.id) ||
        !accepts(event.dataTransfer.types, target)
      )
        return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect =
        event.dataTransfer.effectAllowed === "copy" ? "copy" : "move";
      setOver({ id: row?.id ?? null, position: target.position });
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      )
        return;
      setOver((current) =>
        current?.id === (row?.id ?? null) ? null : current,
      );
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const target = targetOf(event, row);
      if (!accepts(event.dataTransfer.types, target)) return;
      event.preventDefault();
      event.stopPropagation();
      setOver(null);
      onDrop(event.dataTransfer, target);
    },
  });
  useEffect(() => {
    const end = () => setOver(null);
    document.addEventListener("dragend", end);
    return () => document.removeEventListener("dragend", end);
  }, []);
  return (
    <ul
      aria-label="Tiles"
      data-drop-zone={sectionId}
      data-drop={over?.id === null ? over.position : undefined}
      {...handlers()}
      className={
        empty !== undefined
          ? "sidebar-empty-state rounded-md transition-colors duration-150 data-[drop]:bg-accent/10 data-[drop]:text-fg"
          : "grid grid-cols-4 gap-2 px-1 pb-2"
      }
    >
      {empty !== undefined && <li className="list-none">{empty}</li>}
      {rows.map((row) => (
        <li
          key={row.id}
          data-item-id={row.id}
          draggable
          data-drop={over?.id === row.id ? over.position : undefined}
          onDragStart={(event) => {
            const spec = drag(row);
            if (!spec) return;
            for (const [type, value] of Object.entries(spec.data))
              event.dataTransfer.setData(type, value);
            event.dataTransfer.effectAllowed = spec.effectAllowed ?? "copyMove";
          }}
          {...handlers(row)}
        >
          {render(row)}
        </li>
      ))}
    </ul>
  );
}

/** A chat's live details and commands, for any row whose address is the chat. */
function ChatInspector({
  projectId,
  row,
}: {
  projectId: string;
  row: SidebarSourceItem;
}) {
  const host = useSidebarHost();
  const session = row.data;
  const target = chatTarget(row.url);
  if (
    !host ||
    !target ||
    target.projectId !== projectId ||
    !isSession(session, target.sessionId)
  )
    return null;
  const agentId = session.agentId ?? host.defaultAgentId;
  const agent = host.agentsData?.agents.find((entry) => entry.id === agentId);
  return (
    <SidebarSessionInspector
      projectId={projectId}
      session={session}
      agent={agent}
      agents={host.agentsData?.agents}
      agentName={
        agent?.name ??
        (agentId ? host.projectAgentNames[agentId] : undefined) ??
        "Unknown agent"
      }
      onCommand={(command) => host.onSessionCommand(session, command)}
      onArchive={() => host.onSessionAction(session.id, "archive")}
    />
  );
}

/** A chats row's record is the session it lists. */
function isSession(
  value: Record<string, unknown> | undefined,
  id: string,
): value is Record<string, unknown> & AgentSession {
  return (
    value !== undefined &&
    value.id === id &&
    typeof value.createdAt === "string" &&
    "running" in value
  );
}

function SourceRow({
  row,
  projectId,
  tile,
  disclosure,
  active,
  canAct,
  onOpen,
  onAction,
}: {
  row: SidebarSourceItem;
  projectId: string;
  tile: boolean;
  disclosure?: { open: boolean; onToggle: () => void };
  active: boolean;
  /** Its source runs actions (a module, one of Work's lists). */
  canAct: boolean;
  onOpen: (mode: OpenMode) => void;
  onAction: (entry: SidebarMenuEntry) => Promise<void>;
}) {
  const contribution = useSidebarContribution();
  const overrides = sidebarItemPresentation({
    section: contribution?.section,
    id: row.id,
  });
  // What this row can do: its own entries, its address, and, for a source
  // with code behind it, any action a layout names for its rows.
  const supported = [
    ...[
      ...(row.menu ?? []),
      ...(row.contextMenu ?? []),
      ...(row.actions ?? []),
    ].map((entry) => entry.action),
    ...(row.url ? ["copy-url"] : []),
    ...(canAct
      ? [
          ...(overrides.menu ?? []),
          ...(overrides.contextMenu ?? []),
          ...(overrides.actions ?? []),
        ]
          .map((entry) => entry.action)
          .filter((action) => !openModeForAction(action))
      : []),
  ];
  // Work's own details for the chat a row names, wherever the row is from.
  const chat = chatTarget(row.url);
  const inspect =
    chat?.projectId === projectId && isSession(row.data, chat.sessionId);
  // A row standing for an open tab is that tab to an agent pointing at it,
  // while its list is in play here (Tabs placed on top leaves it to the
  // strip).
  const host = useSidebarHost();
  const tab =
    contribution?.relevant !== false && row.url && host?.openTab(row.url)
      ? row.url
      : undefined;
  const item = (
    <SidebarItemRow
      itemId={row.id}
      label={row.label}
      pointKey={tab}
      // A tile shows no label: its tooltip names it. A row's shows a page's
      // or file's address; Work's own (a tab key, a command, a chat link)
      // are not a person's to read.
      title={
        tile
          ? row.label
          : row.url?.startsWith("file:")
            ? row.url.slice("file:".length)
            : row.url && /^https?:/i.test(row.url)
              ? row.url
              : undefined
      }
      presentation={tile ? "tile" : "row"}
      icon={
        <RowIcon icon={row.icon} url={row.url} tone={row.tone} tile={tile} />
      }
      description={row.description}
      // A short identifier (#42, 3m) stays whole and the label gives way; a
      // long description (a path) shrinks first.
      keepDescription={(row.description?.length ?? 0) <= 8}
      badges={row.badges}
      progress={row.progress}
      trend={row.trend}
      signal={row.signal}
      activity={row.activity}
      active={active}
      resource={Boolean(row.url)}
      defaultOpenMode={row.open ?? contribution?.section.open ?? "replace"}
      // [] removes the overflow menu; entries join the open modes.
      menu={row.menu?.length === 0 ? [] : undefined}
      defaultMenu={row.menu}
      contextMenu={row.contextMenu}
      actions={row.actions}
      supportedActions={supported}
      preview={row.preview}
      previewContent={
        inspect ? <ChatInspector projectId={projectId} row={row} /> : undefined
      }
      disclosure={disclosure}
      onOpen={onOpen}
      onAction={onAction}
    />
  );
  // A row naming one of this project's chats says which, wherever it is.
  return chat?.projectId === projectId ? (
    <div data-session-id={chat.sessionId}>{item}</div>
  ) : (
    item
  );
}
