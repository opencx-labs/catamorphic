import { createCollection } from "@catamorphic/app";
import { CollectionTree, useCollection } from "@catamorphic/app/ui";
import { useAgentSessionFields } from "@catamorphic/react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  SidebarSourceCapabilities,
  SidebarSourceItem,
  SidebarSourceSession,
} from "../../shared/sidebar-source.js";
import { readBookmarkDrop } from "../lib/bookmark-drag.js";
import { desktopApi } from "../lib/desktop-api.js";
import {
  currentSidebarDrag,
  isOwnSidebarDrag,
  readSidebarItemDrag,
  sidebarItemDragSpec,
} from "../lib/sidebar-drag.js";
import { TAB_DRAG_TYPE } from "../lib/tab-drag.js";
import { SessionAccess } from "./session-details.js";
import {
  projectSidebarItems,
  sidebarItemPresentation,
  useSidebarContent,
  useSidebarContribution,
  useSidebarItemCount,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";

function sourceError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

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

/** One collection owns cache, cancellation, subscriptions and paged branches. */
export function SidebarLiveSource({ projectId }: { projectId: string }) {
  const section = useSidebarContribution()?.section;
  // A session-scoped section reads its chat where the chat is read.
  return section?.when?.session === true ? (
    <SessionAccess projectId={projectId}>
      <LiveSourceRows projectId={projectId} />
    </SessionAccess>
  ) : (
    <LiveSourceRows projectId={projectId} />
  );
}

function LiveSourceRows({ projectId }: { projectId: string }) {
  const contribution = useSidebarContribution();
  const section = contribution?.section;
  const sectionId = section?.id ?? "";
  const api = desktopApi;
  const [subscriptionError, setSubscriptionError] = useState<string>();
  const [capabilities, setCapabilities] = useState<SidebarSourceCapabilities>({
    move: false,
    drop: false,
  });
  const publishRef = useRef<((event: { type: "invalidate" }) => void) | null>(
    null,
  );
  // A session-scoped section (`when.session`) is given the chat in front
  // (ADR 0225), and keeps the one it showed while it leaves.
  const sessionScoped = section?.when?.session === true;
  const surfaceSessionId = sessionScoped
    ? contribution?.surface.sessionId
    : undefined;
  const [sessionId, setSessionId] = useState(surfaceSessionId);
  if (surfaceSessionId && surfaceSessionId !== sessionId)
    setSessionId(surfaceSessionId);
  const { fields } = useAgentSessionFields(
    projectId,
    sessionScoped ? sessionId : undefined,
  );
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: switching the configured module, or the chat a session-scoped section shows, must replace its cache and release old leases.
  const collection = useMemo(
    () =>
      createCollection<SidebarSourceItem>({
        source: {
          load: async ({ parentId, cursor, signal }) => {
            if (!api) throw new Error("Desktop connection unavailable.");
            const requestId = crypto.randomUUID();
            const cancel = () => {
              void api.sidebarSourceCancel(requestId);
            };
            signal.addEventListener("abort", cancel, { once: true });
            try {
              signal.throwIfAborted();
              const page = await api.sidebarSourceRequest({
                projectId,
                sectionId,
                requestId,
                method: "load",
                parentId,
                cursor,
                ...withSession(),
              });
              signal.throwIfAborted();
              if (!page) throw new Error("Source returned no collection page.");
              const reported = (
                page as { capabilities?: SidebarSourceCapabilities }
              ).capabilities;
              if (reported)
                setCapabilities((current) =>
                  current.move === reported.move &&
                  current.drop === reported.drop
                    ? current
                    : reported,
                );
              return page;
            } catch (cause) {
              throw sourceError(cause);
            } finally {
              signal.removeEventListener("abort", cancel);
            }
          },
          subscribe: (publish) => {
            if (!api) return () => {};
            publishRef.current = publish;
            let released = false;
            const leaseId = crypto.randomUUID();
            const unsubscribe = api.onSidebarSourceChanged((event) => {
              if (event.leaseId !== leaseId) return;
              setSubscriptionError(event.error);
              if (!event.error) publish({ type: "invalidate" });
            });
            setSubscriptionError(undefined);
            void api
              .sidebarSourceSubscribe({ projectId, sectionId, leaseId })
              .catch((cause) => {
                if (!released) setSubscriptionError(sourceError(cause).message);
              });
            return () => {
              released = true;
              unsubscribe();
              void api.sidebarSourceUnsubscribe(leaseId);
            };
          },
        },
      }),
    [
      api,
      projectId,
      sectionId,
      section?.source?.module,
      sessionScoped ? sessionId : undefined,
    ],
  );
  // A relevant hidden section keeps only a root availability lease. The native
  // tree owns expanded branch leases while visible, matching built-in sources.
  const active =
    (contribution?.relevant ?? true) &&
    ((contribution?.visible ?? true) || section?.hideEmpty === true) &&
    (!sessionScoped || session !== undefined);
  const { root } = useCollection({
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
  const loaded = useRef({ collection, sessionKey });
  const stale = useRef(false);
  useEffect(() => {
    const previous = loaded.current;
    loaded.current = { collection, sessionKey };
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
  const project = useCallback(
    (items: readonly SidebarSourceItem[]) =>
      projectSidebarItems(items, section).filter(
        (item) =>
          !sidebarItemPresentation({ section, id: item.id }).hide && !item.hide,
      ),
    [section],
  );
  const count = project(
    root.ids.flatMap((id) => {
      const item = collection.getItem(id);
      return item ? [item] : [];
    }),
  ).length;
  useSidebarItemCount(count);
  const refresh = useCallback(() => {
    setSubscriptionError(undefined);
    return collection.load();
  }, [collection]);
  useSidebarRefresh(refresh);
  useSidebarContent({
    state:
      root.status === "error" || subscriptionError
        ? "error"
        : root.status === "idle" || root.status === "loading"
          ? "loading"
          : count
            ? "ready"
            : "empty",
    refreshing: root.fetching && root.ids.length > 0,
    idle: !root.fetching,
    error: subscriptionError ?? root.error,
    retry: refresh,
    empty: "No items yet.",
  });
  const title = section?.title ?? "Items";
  const request = (
    input: Omit<
      Parameters<typeof api.sidebarSourceRequest>[0],
      "projectId" | "sectionId" | "requestId"
    >,
  ) =>
    api
      .sidebarSourceRequest({
        projectId,
        sectionId,
        requestId: crypto.randomUUID(),
        ...withSession(),
        ...input,
      })
      .catch((cause: unknown) => {
        throw sourceError(cause);
      });
  /** Before: the target itself. After: whatever follows it among its siblings. */
  const slotFor = (target: {
    item: SidebarSourceItem | null;
    position: "before" | "after" | "inside";
  }) => {
    if (!target.item) return { parentId: null, beforeId: undefined };
    if (target.position === "inside")
      return { parentId: target.item.id, beforeId: undefined };
    const parentId = target.item.parentId ?? null;
    if (target.position === "before")
      return { parentId, beforeId: target.item.id };
    const siblings = collection.getBranch(parentId).ids;
    const index = siblings.indexOf(target.item.id);
    return { parentId, beforeId: index >= 0 ? siblings[index + 1] : undefined };
  };
  return (
    <div
      className="sidebar-live-source"
      data-sidebar-source={sectionId}
      aria-busy={Boolean(root.fetching)}
    >
      <CollectionTree
        collection={collection}
        active={contribution?.visible ?? true}
        label={title}
        height={section?.height}
        rowHeight={section?.rowHeight}
        project={project}
        motionClasses={{
          enter: "animate-session-row-in",
          exit: "animate-session-row-out",
        }}
        renderStatus={() => null}
        dragAndDrop={{
          drag: (item) =>
            sidebarItemDragSpec(
              {
                sectionId,
                id: item.id,
                parentId: item.parentId ?? null,
                kind: item.hasChildren ? "folder" : "item",
                label: item.label,
                url: item.url,
              },
              item.url
                ? {
                    key: `${sectionId}:${item.id}`,
                    kind: "bookmark",
                    title: item.label,
                    bookmarkUrl: item.url,
                  }
                : undefined,
            ),
          accept: (types, target) => {
            if (target.position === "inside" && !target.item?.hasChildren)
              return false;
            if (isOwnSidebarDrag(types, sectionId)) {
              const drag = currentSidebarDrag();
              return (
                capabilities.move &&
                drag !== null &&
                drag.id !== target.item?.id
              );
            }
            return capabilities.drop && types.includes(TAB_DRAG_TYPE);
          },
          onDrop: (transfer, target) => {
            const slot = slotFor(target);
            const own = isOwnSidebarDrag(transfer.types, sectionId)
              ? readSidebarItemDrag(transfer)
              : null;
            const call = own
              ? request({ method: "move", itemId: own.id, ...slot })
              : (() => {
                  const dropped = readBookmarkDrop(transfer);
                  if (!dropped)
                    return Promise.reject(
                      new Error(
                        "Only pages, chats and bookmarks can be dropped here.",
                      ),
                    );
                  const raw = transfer.getData(TAB_DRAG_TYPE);
                  let kind = "bookmark";
                  try {
                    kind = String(JSON.parse(raw).kind ?? kind);
                  } catch {}
                  return request({
                    method: "drop",
                    ...slot,
                    payload: { kind, label: dropped.label, url: dropped.url },
                  });
                })();
            void call.catch((cause: unknown) =>
              setSubscriptionError(
                cause instanceof Error ? cause.message : String(cause),
              ),
            );
          },
        }}
        renderItem={(item, tree) => (
          <SidebarItemRow
            itemId={item.id}
            label={item.label}
            description={item.description}
            icon={item.icon ?? "Circle"}
            badges={item.badges}
            progress={item.progress}
            menu={item.menu}
            contextMenu={item.contextMenu}
            actions={item.actions}
            preview={item.preview}
            style={{ marginLeft: tree.depth * 14 }}
            resource={Boolean(item.url)}
            disclosure={
              tree.hasChildren
                ? { open: tree.expanded, onToggle: tree.toggle }
                : undefined
            }
            supportedActions={[
              ...(item.actions ?? []),
              ...(item.menu ?? []),
              ...(item.contextMenu ?? []),
            ].map((entry) => entry.action)}
            onOpen={(mode) => {
              if (item.url) contribution?.open(item.url, mode);
              else if (tree.hasChildren) tree.toggle();
            }}
            onAction={async (entry) => {
              if (!api) throw new Error("Desktop connection unavailable.");
              if (entry.url) {
                contribution?.open(entry.url, "replace");
                return;
              }
              if (entry.action === "copy-url" && item.url) {
                await navigator.clipboard.writeText(item.url);
                return;
              }
              if (!entry.action.startsWith("run:"))
                throw new Error("This source action needs a run: name.");
              await api
                .sidebarSourceRequest({
                  projectId,
                  sectionId,
                  requestId: crypto.randomUUID(),
                  method: "action",
                  itemId: item.id,
                  action: entry.action.slice(4),
                  ...withSession(),
                })
                .catch((cause: unknown) => {
                  throw sourceError(cause);
                });
              // The worker also publishes invalidation through the
              // subscription, but that lease may still be settling; the
              // user's own action must show regardless.
              publishRef.current?.({ type: "invalidate" });
            }}
          />
        )}
      />
    </div>
  );
}
