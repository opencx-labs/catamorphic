/* biome-ignore-all lint/a11y/noRedundantRoles: list-style resets need explicit list semantics */

import {
  dropPositionFor,
  type TreeDragAndDrop,
  type TreeDropTarget,
} from "@catamorphic/app/ui";
import { FolderPlus, MessageSquare, Plus } from "lucide-react";
import { type DragEvent as ReactDragEvent, useEffect, useState } from "react";
import { orderedSiblings, siblingRanks } from "../../shared/bookmark-order.js";
import { parseChatBookmarkUrl } from "../../shared/bookmark-target.js";
import type { OpenMode } from "../../shared/open-mode.js";
import { readBookmarkDrop } from "../lib/bookmark-drag.js";
import {
  type Bookmark,
  type BookmarksData,
  desktopApi,
  type ProjectBookmarks,
  type SidebarMenuEntry,
} from "../lib/desktop-api.js";
import {
  currentSidebarDrag,
  isOwnSidebarDrag,
  readSidebarItemDrag,
  sidebarItemDragSpec,
} from "../lib/sidebar-drag.js";
import { TAB_DRAG_TYPE, type TabDragPayload } from "../lib/tab-drag.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";
import {
  projectSidebarItems,
  useSidebarContent,
  useSidebarContribution,
  useSidebarItemCount,
  useSidebarRefresh,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";
import { SidebarSubsection } from "./sidebar-subsection.js";
import { SidebarTree } from "./sidebar-tree.js";
import { SiteFavicon } from "./site-favicon.js";

const PROJECT_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Pin across projects", action: "pin" },
  { label: "Edit bookmark…", action: "edit" },
  { label: "Delete", action: "remove", danger: true },
];
const PINNED_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Unpin", action: "unpin" },
  { label: "Rename…", action: "rename" },
  { label: "Delete", action: "remove", danger: true },
];
const FOLDER_MENU: SidebarMenuEntry[] = [
  { label: "Rename folder…", action: "rename" },
  { label: "Remove folder, keep bookmarks", action: "remove", danger: true },
];

type BookmarkEdit =
  | { kind: "bookmark"; bookmark?: Bookmark }
  | { kind: "folder" }
  | { kind: "rename"; id: string; label: string };

function SiteIcon({
  bookmark,
  tile = false,
}: {
  bookmark: Bookmark;
  tile?: boolean;
}) {
  if (parseChatBookmarkUrl(bookmark.url))
    return <MessageSquare className="size-4 shrink-0" />;
  return (
    <SiteFavicon
      url={bookmark.url}
      faviconUrl={bookmark.faviconUrl}
      className={tile ? "size-4" : "size-3.5"}
    />
  );
}

/** Profile-wide favorites, project bookmarks, and recursive folders share one store. */
export function BookmarksNav({
  projectId,
  profileId,
  pinnedStyle = "tiles",
  defaultOpenMode = "replace",
  menuOverride,
  onOpen,
}: {
  projectId: string;
  profileId: string;
  pinnedStyle?: "tiles" | "list";
  defaultOpenMode?: OpenMode;
  menuOverride?: SidebarMenuEntry[];
  onOpen: (url: string, mode?: OpenMode) => void | Promise<void>;
}) {
  const contribution = useSidebarContribution();
  const [data, setData] = useState<BookmarksData | null>(null);
  const [edit, setEdit] = useState<BookmarkEdit | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  const [gridDrop, setGridDrop] = useState<{
    id: string | null;
    position: "before" | "after" | "inside";
  } | null>(null);
  useEffect(() => {
    const end = () => setGridDrop(null);
    document.addEventListener("dragend", end);
    document.addEventListener("drop", end);
    return () => {
      document.removeEventListener("dragend", end);
      document.removeEventListener("drop", end);
    };
  }, []);
  const isEmpty =
    !data ||
    (data.pinned.bookmarks.length === 0 &&
      data.pinned.folders.length === 0 &&
      data.project.bookmarks.length === 0 &&
      data.project.folders.length === 0 &&
      !data.library?.bookmarks.length &&
      !data.library?.folders.length);
  useSidebarItemCount(
    pinnedStyle === "tiles"
      ? projectSidebarItems(
          data?.pinned.bookmarks ?? [],
          contribution?.section,
        ).filter(
          (item) => !contribution?.section.itemOverrides?.[item.id]?.hide,
        ).length
      : 0,
  );
  useSidebarContent({
    state: data === null ? "loading" : isEmpty ? "empty" : "ready",
    empty: "No bookmarks yet.",
  });
  useEffect(() => {
    let cancelled = false;
    setEdit(null);
    setData(null);
    void desktopApi.bookmarksGet({ projectId, profileId }).then((loaded) => {
      if (!cancelled) setData(loaded);
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.profileId !== profileId) return;
      if (change.projectId === projectId && change.project) {
        setData({
          project: change.project,
          pinned: change.pinned,
          library: change.library,
        });
      } else if (change.projectId === null) {
        setData((current) =>
          current
            ? { ...current, pinned: change.pinned, library: change.library }
            : current,
        );
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, profileId]);

  useSidebarRefresh(async () => {
    try {
      setData(await desktopApi.bookmarksGet({ projectId, profileId }));
      setError(null);
    } catch (cause) {
      setError(String(cause));
    }
  });
  const perform = (operation: Promise<unknown>) => {
    setError(null);
    void operation.catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Could not update bookmarks.",
      ),
    );
  };
  const open = (url: string, mode?: OpenMode) =>
    perform(Promise.resolve().then(() => onOpen(url, mode)));
  /**
   * One drag model for the three bookmark lists. A list accepts its own
   * rows (reorder, reparent) and, except the library archive, pages and
   * chats dragged from tabs or other sections. Folders are the only
   * "inside" targets; everything else lands before or after a sibling.
   */
  type Scope = "project" | "pinned" | "library";
  type Entry = {
    id: string;
    parentId: string | null;
    label: string;
    hasChildren: boolean;
    bookmark?: Bookmark;
  };
  const sectionId = contribution?.section.id ?? "bookmarks";
  const scopeData = (scope: Scope): ProjectBookmarks | undefined =>
    scope === "project"
      ? data?.project
      : scope === "pinned"
        ? data?.pinned
        : data?.library;
  const acceptsExternal = (scope: Scope) => scope !== "library";
  const accepts = (
    scope: Scope,
    types: readonly string[],
    target: TreeDropTarget<Entry>,
  ) => {
    if (target.position === "inside" && target.item && !target.item.hasChildren)
      return false;
    if (isOwnSidebarDrag(types, sectionId, scope)) {
      const drag = currentSidebarDrag();
      if (!drag || drag.id === target.item?.id) return false;
      // A folder never lands inside its own subtree.
      if (drag.kind === "folder") {
        const folders = scopeData(scope)?.folders ?? [];
        let cursor: string | undefined =
          target.position === "inside"
            ? target.item?.id
            : (target.item?.parentId ?? undefined);
        while (cursor) {
          if (cursor === drag.id) return false;
          cursor = folders.find((folder) => folder.id === cursor)?.parentId;
        }
      }
      return true;
    }
    return acceptsExternal(scope) && types.includes(TAB_DRAG_TYPE);
  };
  /** Folder and sibling for a target: inside a folder, or beside a row. */
  const slotFor = (scope: Scope, target: TreeDropTarget<Entry>) => {
    if (!target.item) return { folderId: undefined, beforeId: undefined };
    if (target.position === "inside")
      return { folderId: target.item.id, beforeId: undefined };
    const folderId = target.item.parentId ?? undefined;
    if (target.position === "before")
      return { folderId, beforeId: target.item.id };
    // After: before whatever follows the target among all its siblings.
    const lists = scopeData(scope);
    const siblings = lists
      ? orderedSiblings(lists, folderId).map((sibling) => sibling.id)
      : [];
    const index = siblings.indexOf(target.item.id);
    return {
      folderId,
      beforeId: index >= 0 ? siblings[index + 1] : undefined,
    };
  };
  const dropInto = (
    scope: Scope,
    transfer: DataTransfer,
    target: TreeDropTarget<Entry>,
  ) => {
    const own = isOwnSidebarDrag(transfer.types, sectionId, scope)
      ? readSidebarItemDrag(transfer)
      : null;
    if (own) {
      const slot = slotFor(scope, target);
      perform(
        desktopApi.bookmarksMove({
          projectId,
          profileId,
          scope,
          id: own.id,
          folderId: slot.folderId ?? null,
          beforeId: slot.beforeId,
        }),
      );
      return;
    }
    const bookmark = readBookmarkDrop(transfer);
    if (!bookmark) {
      setError("Open a page or send a chat message before pinning it.");
      return;
    }
    const slot = slotFor(scope, target);
    perform(
      desktopApi
        .bookmarksPlace({
          projectId,
          profileId,
          ...bookmark,
          folderId: slot.folderId,
          beforeId: slot.beforeId,
          pinned: scope === "pinned",
        })
        .then(() => {
          const location = slot.folderId
            ? scopeData(scope)?.folders.find(
                (folder) => folder.id === slot.folderId,
              )?.label
            : scope === "pinned"
              ? "Pinned bookmarks"
              : "Bookmarks";
          setStatus(`Saved ${bookmark.label} to ${location ?? "folder"}.`);
        }),
    );
  };
  const dragAndDropFor = (scope: Scope): TreeDragAndDrop<Entry> => ({
    drag: (entry) =>
      sidebarItemDragSpec(
        {
          sectionId,
          scope,
          id: entry.id,
          parentId: entry.parentId,
          kind: entry.hasChildren ? "folder" : "item",
          label: entry.label,
          url: entry.bookmark?.url,
        },
        entry.bookmark
          ? {
              key: `bookmark:${entry.bookmark.id}`,
              kind: "bookmark",
              title: entry.bookmark.label,
              bookmarkUrl: entry.bookmark.url,
            }
          : undefined,
      ),
    accept: (types, target) => accepts(scope, types, target),
    onDrop: (transfer, target) => dropInto(scope, transfer, target),
  });
  /** The pinned tile grid is not a tree; it shares the same policy. */
  const gridEntry = (bookmark: Bookmark): Entry => ({
    id: bookmark.id,
    parentId: null,
    label: bookmark.label,
    hasChildren: false,
    bookmark,
  });
  const gridTarget = (
    event: ReactDragEvent<HTMLElement>,
    bookmark?: Bookmark,
  ): TreeDropTarget<Entry> =>
    bookmark
      ? {
          item: gridEntry(bookmark),
          position:
            pinnedStyle === "tiles"
              ? (event.clientX -
                  event.currentTarget.getBoundingClientRect().left) /
                  Math.max(
                    1,
                    event.currentTarget.getBoundingClientRect().width,
                  ) <
                0.5
                ? "before"
                : "after"
              : dropPositionFor({
                  clientY: event.clientY,
                  rect: event.currentTarget.getBoundingClientRect(),
                  allowInside: false,
                }),
        }
      : { item: null, position: "inside" };
  const gridHandlers = (bookmark?: Bookmark) => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      const target = gridTarget(event, bookmark);
      if (
        (bookmark && currentSidebarDrag()?.id === bookmark.id) ||
        !accepts("pinned", event.dataTransfer.types, target)
      ) {
        if (bookmark) setGridDrop(null);
        return;
      }
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect =
        event.dataTransfer.effectAllowed === "copy" ? "copy" : "move";
      setGridDrop({ id: bookmark?.id ?? null, position: target.position });
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      )
        return;
      setGridDrop((current) =>
        current?.id === (bookmark?.id ?? null) ? null : current,
      );
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      const target = gridTarget(event, bookmark);
      if (!accepts("pinned", event.dataTransfer.types, target)) return;
      event.preventDefault();
      event.stopPropagation();
      setGridDrop(null);
      dropInto("pinned", event.dataTransfer, target);
    },
  });
  const runAction = (
    entry: SidebarMenuEntry,
    bookmark: Bookmark,
    pinned: boolean,
  ) => {
    const scope = { projectId, profileId, id: bookmark.id };
    switch (entry.action) {
      case "open":
        open(bookmark.url);
        break;
      case "open-tab":
        open(bookmark.url, "tab");
        break;
      case "open-here":
        open(bookmark.url, "replace");
        break;
      case "copy-url":
        perform(navigator.clipboard.writeText(bookmark.url));
        break;
      case "pin":
        perform(desktopApi.bookmarksPin(scope));
        break;
      case "unpin":
        perform(desktopApi.bookmarksUnpin(scope));
        break;
      case "edit":
        setEdit(
          pinned
            ? { kind: "rename", id: bookmark.id, label: bookmark.label }
            : { kind: "bookmark", bookmark },
        );
        break;
      case "rename":
        setEdit({ kind: "rename", id: bookmark.id, label: bookmark.label });
        break;
      case "remove":
        perform(
          pinned
            ? desktopApi.bookmarksRemovePinned(scope)
            : desktopApi.bookmarksRemove(scope),
        );
        break;
    }
  };
  const row = (bookmark: Bookmark, pinned: boolean, library = false) => (
    <li
      key={bookmark.id}
      draggable
      data-drop={gridDrop?.id === bookmark.id ? gridDrop.position : undefined}
      onDragStart={(event) => {
        const spec = sidebarItemDragSpec(
          {
            sectionId,
            scope: "pinned",
            id: bookmark.id,
            parentId: bookmark.folderId ?? null,
            kind: "item",
            label: bookmark.label,
            url: bookmark.url,
          },
          {
            key: `bookmark:${bookmark.id}`,
            kind: "bookmark",
            title: bookmark.label,
            bookmarkUrl: bookmark.url,
          } satisfies TabDragPayload,
        );
        for (const [type, value] of Object.entries(spec.data))
          event.dataTransfer.setData(type, value);
        event.dataTransfer.effectAllowed = "copyMove";
      }}
      {...gridHandlers(bookmark)}
    >
      <SidebarItemRow
        itemId={bookmark.id}
        presentation={pinned && pinnedStyle === "tiles" ? "tile" : "row"}
        label={bookmark.label}
        title={`${bookmark.label} · ${bookmark.url}`}
        icon={
          <SiteIcon
            key={bookmark.url}
            bookmark={bookmark}
            tile={pinned && pinnedStyle === "tiles"}
          />
        }
        menu={menuOverride}
        defaultMenu={
          pinned
            ? PINNED_MENU
            : library
              ? PROJECT_MENU.map((entry) =>
                  entry.action === "edit"
                    ? { label: "Rename…", action: "rename" }
                    : entry,
                )
              : PROJECT_MENU
        }
        resource
        defaultOpenMode={defaultOpenMode}
        onOpen={(mode) => open(bookmark.url, mode)}
        onAction={(entry) =>
          library && entry.action === "remove"
            ? perform(
                desktopApi.bookmarksRemoveLibrary({
                  projectId,
                  profileId,
                  id: bookmark.id,
                }),
              )
            : runAction(entry, bookmark, pinned)
        }
      />
    </li>
  );

  const treeRow = (bookmark: Bookmark, pinned: boolean, library = false) => (
    <SidebarItemRow
      itemId={bookmark.id}
      label={bookmark.label}
      title={`${bookmark.label} · ${bookmark.url}`}
      icon={<SiteIcon key={bookmark.url} bookmark={bookmark} />}
      menu={menuOverride}
      defaultMenu={
        pinned
          ? PINNED_MENU
          : library
            ? PROJECT_MENU.map((entry) =>
                entry.action === "edit"
                  ? { label: "Rename…", action: "rename" }
                  : entry,
              )
            : PROJECT_MENU
      }
      resource
      defaultOpenMode={defaultOpenMode}
      onOpen={(mode) => open(bookmark.url, mode)}
      onAction={(entry) =>
        library && entry.action === "remove"
          ? perform(
              desktopApi.bookmarksRemoveLibrary({
                projectId,
                profileId,
                id: bookmark.id,
              }),
            )
          : runAction(entry, bookmark, pinned)
      }
    />
  );

  const renderTree = (
    scope: ProjectBookmarks,
    pinned: boolean,
    library = false,
    foldersOnly = false,
  ) => {
    const scopeName: Scope = library
      ? "library"
      : pinned
        ? "pinned"
        : "project";
    const folderIds = new Set(scope.folders.map((folder) => folder.id));
    const items: Entry[] = [
      ...scope.folders.map((folder) => ({
        id: folder.id,
        parentId: folder.parentId ?? null,
        label: folder.label,
        hasChildren: true,
      })),
      ...scope.bookmarks
        .filter(
          (bookmark) =>
            !foldersOnly ||
            Boolean(bookmark.folderId && folderIds.has(bookmark.folderId)),
        )
        .map((bookmark) => ({
          id: bookmark.id,
          parentId: bookmark.folderId ?? null,
          label: bookmark.label,
          hasChildren: false,
          bookmark,
        })),
    ];
    // The tree lists each parent's children in the order it meets them, so
    // one global sort by sibling rank orders every level at once.
    const ranks = siblingRanks(scope);
    items.sort((a, b) => (ranks.get(a.id) ?? 0) - (ranks.get(b.id) ?? 0));
    return (
      <SidebarTree
        items={items}
        label={
          library
            ? "Saved bookmarks"
            : pinned
              ? "Pinned folders"
              : "Project bookmarks"
        }
        // Long lists scroll inside the tree itself; a scrolling wrapper
        // around a virtualized tree gives two competing scrollbars.
        height={pinned ? undefined : 256}
        defaultExpanded={false}
        dragAndDrop={dragAndDropFor(scopeName)}
        renderItem={(item, tree) =>
          item.bookmark ? (
            <div style={{ marginLeft: tree.depth * 14 }}>
              {treeRow(item.bookmark, pinned, library)}
            </div>
          ) : (
            <div style={{ marginLeft: tree.depth * 14 }}>
              <SidebarItemRow
                itemId={item.id}
                label={item.label}
                icon="Folder"
                menu={FOLDER_MENU}
                disclosure={{ open: tree.expanded, onToggle: tree.toggle }}
                expanded={tree.expanded}
                onOpen={tree.toggle}
                onAction={(entry) => {
                  if (entry.action === "rename")
                    setEdit({ kind: "rename", id: item.id, label: item.label });
                  else if (entry.action === "remove")
                    perform(
                      (library
                        ? desktopApi.bookmarksRemoveLibrary
                        : pinned
                          ? desktopApi.bookmarksRemovePinned
                          : desktopApi.bookmarksRemove)({
                        projectId,
                        profileId,
                        id: item.id,
                      }),
                    );
                }}
              />
            </div>
          )
        }
      />
    );
  };

  return (
    <div className="flex flex-col gap-2">
      {/* The section title already says "Bookmarks": the profile-wide pins
          and the saved library are unlabelled groups, and the project list
          is the one labelled, collapsible group. */}
      <SidebarSubsection>
        <section
          className="max-h-[min(40vh,24rem)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
          aria-label="Pinned bookmarks scroll area"
        >
          {data && (
            <ul
              role="list"
              aria-label="Pinned bookmarks"
              data-drop-zone="pinned"
              data-drop={gridDrop?.id === null ? gridDrop.position : undefined}
              {...gridHandlers()}
              className={
                pinnedStyle === "tiles"
                  ? "grid grid-cols-4 gap-2 px-1 py-1"
                  : "flex flex-col gap-0.5"
              }
            >
              {data.pinned.bookmarks.filter((bookmark) => !bookmark.folderId)
                .length === 0 && (
                <li className="col-span-4 px-2 py-3 text-center text-xs text-fg-muted">
                  Drop a tab here to pin across projects
                </li>
              )}
              {projectSidebarItems(data.pinned.bookmarks, contribution?.section)
                .filter(
                  (bookmark) =>
                    !contribution?.section.itemOverrides?.[bookmark.id]?.hide,
                )
                .filter((bookmark) => !bookmark.folderId)
                .map((bookmark) => row(bookmark, true))}
            </ul>
          )}
          {data && (
            <ul role="list" className="flex flex-col gap-0.5">
              {renderTree(data.pinned, true, false, true)}
            </ul>
          )}
        </section>
      </SidebarSubsection>
      {data?.library &&
        (data.library.bookmarks.length > 0 ||
          data.library.folders.length > 0) && (
          <SidebarSubsection>
            <section aria-label="Bookmark library">
              <ul role="list" className="flex flex-col gap-0.5">
                {renderTree(data.library, false, true)}
              </ul>
            </section>
          </SidebarSubsection>
        )}
      <SidebarSubsection label="This project" collapsible>
        <ul role="list" className="flex flex-col gap-0.5">
          {data && renderTree(data.project, false)}
        </ul>
        <div className="flex items-center gap-1 px-1">
          <button
            type="button"
            onClick={() => setEdit({ kind: "bookmark" })}
            className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-1 text-xs text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
          >
            <Plus className="size-4 shrink-0" />
            Add bookmark
          </button>
          <ShortcutHint label="New bookmark folder">
            <button
              type="button"
              aria-label="New bookmark folder"
              onClick={() => setEdit({ kind: "folder" })}
              className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            >
              <FolderPlus className="size-4 shrink-0" />
            </button>
          </ShortcutHint>
        </div>
      </SidebarSubsection>
      {error && (
        <p role="alert" className="px-2 text-xs text-danger">
          {error}
        </p>
      )}
      <p role="status" className="sr-only">
        {status}
      </p>
      <Modal open={edit !== null} onClose={() => setEdit(null)} width={400}>
        {edit && (
          <BookmarkForm
            key={JSON.stringify(edit)}
            edit={edit}
            projectId={projectId}
            profileId={profileId}
            folders={data?.project.folders ?? []}
            onClose={() => setEdit(null)}
          />
        )}
      </Modal>
    </div>
  );
}

function BookmarkForm({
  edit,
  projectId,
  profileId,
  folders,
  onClose,
}: {
  edit: BookmarkEdit;
  projectId: string;
  profileId: string;
  folders: BookmarksData["project"]["folders"];
  onClose: () => void;
}) {
  const [label, setLabel] = useState(
    edit.kind === "rename"
      ? edit.label
      : edit.kind === "bookmark"
        ? (edit.bookmark?.label ?? "")
        : "",
  );
  const [url, setUrl] = useState(
    edit.kind === "bookmark" ? (edit.bookmark?.url ?? "") : "",
  );
  const [folderId, setFolderId] = useState(
    edit.kind === "bookmark" ? (edit.bookmark?.folderId ?? "") : "",
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const title =
    edit.kind === "folder"
      ? "New folder"
      : edit.kind === "rename"
        ? "Rename"
        : edit.bookmark
          ? "Edit bookmark"
          : "Add bookmark";
  const save = async () => {
    if (pending) return;
    setPending(true);
    setError(null);
    try {
      const scope = { projectId, profileId };
      if (edit.kind === "folder")
        await desktopApi.bookmarksAddFolder({ ...scope, label });
      else if (edit.kind === "rename")
        await desktopApi.bookmarksRename({ ...scope, id: edit.id, label });
      else {
        const parsed = new URL(url.includes(":") ? url : `https://${url}`);
        if (!["http:", "https:"].includes(parsed.protocol))
          throw new Error("Enter an http or https address.");
        const input = {
          ...scope,
          label: label.trim() || parsed.hostname,
          url: parsed.href,
        };
        if (edit.bookmark)
          await desktopApi.bookmarksUpdate({
            ...input,
            id: edit.bookmark.id,
            folderId: folderId || null,
          });
        else
          await desktopApi.bookmarksAdd({
            ...input,
            folderId: folderId || undefined,
          });
      }
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Could not save bookmark.",
      );
    } finally {
      setPending(false);
    }
  };
  return (
    <form
      className="flex flex-col gap-4 p-5"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <h2 className="text-base font-semibold text-balance">{title}</h2>
      <label className="flex flex-col gap-1.5 text-sm">
        Name
        <input
          name="bookmarkName"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          required={edit.kind !== "bookmark"}
          className="field h-8 rounded-md px-2 text-sm"
        />
      </label>
      {edit.kind === "bookmark" && (
        <>
          <label className="flex flex-col gap-1.5 text-sm">
            Address
            <input
              name="bookmarkUrl"
              value={url}
              onChange={(event) => setUrl(event.target.value)}
              required
              placeholder="https://example.com"
              className="field h-8 rounded-md px-2 text-sm"
            />
          </label>
          <label className="flex flex-col gap-1.5 text-sm">
            Folder
            <select
              name="bookmarkFolder"
              value={folderId}
              onChange={(event) => setFolderId(event.target.value)}
              className="field h-8 rounded-md px-2 text-sm"
            >
              <option value="">No folder</option>
              {folders.map((folder) => (
                <option key={folder.id} value={folder.id}>
                  {folder.label}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onClose}
          className="h-8 cursor-pointer rounded-md px-3 text-sm text-fg-muted hover:bg-bg-overlay"
        >
          Cancel
        </button>
        <PendingButton
          type="submit"
          pending={pending}
          className="h-8 cursor-pointer rounded-md bg-accent px-3 text-sm text-accent-fg disabled:opacity-50"
        >
          Save
        </PendingButton>
      </div>
    </form>
  );
}
