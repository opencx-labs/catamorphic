/* biome-ignore-all lint/a11y/noRedundantRoles: list-style resets need explicit list semantics */
import { FolderPlus, MessageSquare, Plus } from "lucide-react";
import { type DragEvent as ReactDragEvent, useEffect, useState } from "react";
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
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    const end = () => {
      setDropTarget(null);
    };
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
  useSidebarContent(
    error ? "error" : data === null ? "loading" : isEmpty ? "empty" : "ready",
  );
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
  const dropHandlers = (target: string) => ({
    onDragOver: (event: ReactDragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = "copy";
      setDropTarget(target);
    },
    onDragLeave: (event: ReactDragEvent<HTMLElement>) => {
      if (
        event.relatedTarget instanceof Node &&
        event.currentTarget.contains(event.relatedTarget)
      )
        return;
      setDropTarget((current) => (current === target ? null : current));
    },
    onDrop: (event: ReactDragEvent<HTMLElement>) => {
      if (!event.dataTransfer.types.includes(TAB_DRAG_TYPE)) return;
      event.preventDefault();
      event.stopPropagation();
      setDropTarget(null);
      const bookmark = readBookmarkDrop(event.dataTransfer);
      if (!bookmark) {
        setError("Open a page or send a chat message before pinning it.");
        return;
      }
      const pinned = target === "pinned" || target.startsWith("pinned-folder:");
      const folderId = target.includes("folder:")
        ? target.slice(target.indexOf("folder:") + 7)
        : undefined;
      perform(
        desktopApi
          .bookmarksPlace({
            projectId,
            profileId,
            ...bookmark,
            folderId,
            pinned,
          })
          .then(() => {
            const location = folderId
              ? (pinned ? data?.pinned : data?.project)?.folders.find(
                  (folder) => folder.id === folderId,
                )?.label
              : target === "pinned"
                ? "Pinned bookmarks"
                : "Bookmarks";
            setStatus(`Saved ${bookmark.label} to ${location ?? "folder"}.`);
          }),
      );
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
      onDragStart={(event) => {
        event.dataTransfer.setData(
          TAB_DRAG_TYPE,
          JSON.stringify({
            key: `bookmark:${bookmark.id}`,
            kind: "bookmark",
            title: bookmark.label,
            bookmarkUrl: bookmark.url,
          } satisfies TabDragPayload),
        );
        event.dataTransfer.setData("text/uri-list", bookmark.url);
        event.dataTransfer.effectAllowed = "copyMove";
      }}
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

  const renderTree = (
    scope: ProjectBookmarks,
    pinned: boolean,
    library = false,
    foldersOnly = false,
  ) => {
    type Entry = {
      id: string;
      parentId: string | null;
      label: string;
      hasChildren: boolean;
      bookmark?: Bookmark;
    };
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
        defaultExpanded={false}
        renderItem={(item, tree) =>
          item.bookmark ? (
            <div style={{ marginLeft: tree.depth * 14 }}>
              {row(item.bookmark, pinned, library)}
            </div>
          ) : (
            <div
              style={{ marginLeft: tree.depth * 14 }}
              data-bookmark-drop={`${pinned ? "pinned-folder" : "folder"}:${item.id}`}
              {...(library
                ? {}
                : dropHandlers(
                    `${pinned ? "pinned-folder" : "folder"}:${item.id}`,
                  ))}
            >
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
    <div
      data-bookmark-drop="root"
      {...dropHandlers("root")}
      className={`flex flex-col gap-2 rounded-md ${dropTarget === "root" ? "bg-accent/10 ring-1 ring-accent" : ""}`}
    >
      <h3 className="px-2 pt-1 text-xs font-medium text-fg-muted">Pinned</h3>
      <section
        className="max-h-[min(40vh,24rem)] overflow-y-auto overscroll-contain [scrollbar-gutter:stable]"
        aria-label="Pinned bookmarks scroll area"
      >
        {data && (
          <ul
            role="list"
            aria-label="Pinned bookmarks"
            data-bookmark-drop="pinned"
            {...dropHandlers("pinned")}
            className={`${dropTarget === "pinned" ? "rounded-md bg-accent/10 ring-1 ring-accent" : ""} ${
              pinnedStyle === "tiles"
                ? "grid grid-cols-4 gap-2 px-1 py-1"
                : "flex flex-col gap-0.5"
            }`}
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
      {data?.library &&
        (data.library.bookmarks.length > 0 ||
          data.library.folders.length > 0) && (
          <section
            aria-label="Bookmark library"
            onDragOver={(event) => {
              event.stopPropagation();
              event.dataTransfer.dropEffect = "none";
            }}
            onDrop={(event) => {
              event.preventDefault();
              event.stopPropagation();
            }}
            className="max-h-64 overflow-y-auto overscroll-contain"
          >
            <h3 className="sticky top-0 bg-bg px-2 py-2 text-xs font-medium text-fg-muted">
              Saved bookmarks
            </h3>
            <ul role="list" className="flex flex-col gap-0.5">
              {renderTree(data.library, false, true)}
            </ul>
          </section>
        )}
      <h3 className="px-2 pt-1 text-xs font-medium text-fg-muted">
        Project bookmarks
      </h3>
      <ul
        role="list"
        className="max-h-64 overflow-y-auto flex flex-col gap-0.5"
      >
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
