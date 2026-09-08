/* biome-ignore-all lint/a11y/noRedundantRoles: list-style resets need explicit list semantics */
import {
  ChevronRight,
  Folder,
  FolderPlus,
  MessageSquare,
  Plus,
} from "lucide-react";
import { type DragEvent as ReactDragEvent, useEffect, useState } from "react";
import { parseChatBookmarkUrl } from "../../shared/bookmark-target.js";
import { readBookmarkDrop } from "../lib/bookmark-drag.js";
import {
  type Bookmark,
  type BookmarksData,
  desktopApi,
  type SidebarMenuEntry,
} from "../lib/desktop-api.js";
import { TAB_DRAG_TYPE, type TabDragPayload } from "../lib/tab-drag.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { SidebarItemRow } from "./sidebar-item-row.js";

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
  { label: "Unpin into this project", action: "unpin" },
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
  const [failed, setFailed] = useState(false);
  const iconUrl = (() => {
    try {
      const url = new URL(bookmark.url);
      return url.protocol === "https:" ? `${url.origin}/favicon.ico` : null;
    } catch {
      return null;
    }
  })();
  if (parseChatBookmarkUrl(bookmark.url))
    return <MessageSquare className="size-4 shrink-0" />;
  return !failed && iconUrl ? (
    <img
      src={iconUrl}
      alt=""
      referrerPolicy="no-referrer"
      className={`shrink-0 rounded-sm bg-white ${tile ? "size-4" : "size-5 p-0.5"}`}
      onError={() => setFailed(true)}
    />
  ) : (
    <span
      aria-hidden="true"
      className={`grid shrink-0 place-items-center font-medium text-fg-muted ${tile ? "size-4 text-sm" : "size-4"}`}
    >
      {bookmark.label.slice(0, 1).toUpperCase()}
    </span>
  );
}

/** Profile-wide favorites, project bookmarks, and shallow folders share one store. */
export function BookmarksNav({
  projectId,
  profileId,
  pinnedStyle = "tiles",
  menuOverride,
  onEmptyChange,
  onOpen,
}: {
  projectId: string;
  profileId: string;
  pinnedStyle?: "tiles" | "list";
  menuOverride?: SidebarMenuEntry[];
  onEmptyChange?: (empty: boolean) => void;
  onOpen: (url: string, mode?: "tab" | "replace") => void | Promise<void>;
}) {
  const [data, setData] = useState<BookmarksData | null>(null);
  const [edit, setEdit] = useState<BookmarkEdit | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [status, setStatus] = useState("");
  useEffect(() => {
    const start = (event: DragEvent) => {
      if (event.dataTransfer?.types.includes(TAB_DRAG_TYPE)) setDragging(true);
    };
    const end = () => {
      setDragging(false);
      setDropTarget(null);
    };
    document.addEventListener("dragstart", start);
    document.addEventListener("dragend", end);
    document.addEventListener("drop", end);
    return () => {
      document.removeEventListener("dragstart", start);
      document.removeEventListener("dragend", end);
      document.removeEventListener("drop", end);
    };
  }, []);
  const isEmpty =
    !data ||
    (data.pinned.length === 0 &&
      data.project.bookmarks.length === 0 &&
      data.project.folders.length === 0);
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);
  useEffect(() => {
    let cancelled = false;
    setEdit(null);
    setExpanded([]);
    setData(null);
    void desktopApi.bookmarksGet({ projectId, profileId }).then((loaded) => {
      if (!cancelled) setData(loaded);
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.profileId !== profileId) return;
      if (change.projectId === projectId && change.project) {
        setData({ project: change.project, pinned: change.pinned });
      } else if (change.projectId === null) {
        setData((current) =>
          current ? { ...current, pinned: change.pinned } : current,
        );
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, profileId]);

  const perform = (operation: Promise<unknown>) => {
    setError(null);
    void operation.catch((cause: unknown) =>
      setError(
        cause instanceof Error ? cause.message : "Could not update bookmarks.",
      ),
    );
  };
  const open = (url: string, mode?: "tab" | "replace") =>
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
      setDragging(false);
      setDropTarget(null);
      const bookmark = readBookmarkDrop(event.dataTransfer);
      if (!bookmark) {
        setError("Open a page or send a chat message before pinning it.");
        return;
      }
      const folderId = target.startsWith("folder:")
        ? target.slice(7)
        : undefined;
      perform(
        desktopApi
          .bookmarksPlace({
            projectId,
            profileId,
            ...bookmark,
            folderId,
            pinned: target === "pinned",
          })
          .then(() => {
            if (folderId)
              setExpanded((current) =>
                current.includes(folderId) ? current : [...current, folderId],
              );
            const location = folderId
              ? data?.project.folders.find((folder) => folder.id === folderId)
                  ?.label
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
  const row = (bookmark: Bookmark, pinned: boolean) => (
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
        menu={menuOverride ?? (pinned ? PINNED_MENU : PROJECT_MENU)}
        onOpen={() => open(bookmark.url)}
        onAction={(entry) => runAction(entry, bookmark, pinned)}
      />
    </li>
  );

  return (
    <div
      data-bookmark-drop="root"
      {...dropHandlers("root")}
      className={`flex flex-col gap-2 rounded-md ${dropTarget === "root" ? "bg-accent/10 ring-1 ring-accent" : ""}`}
    >
      {data && (data.pinned.length > 0 || dragging) && (
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
          {data.pinned.length === 0 && dragging && (
            <li className="col-span-4 px-2 py-3 text-center text-xs text-fg-muted">
              Pin across projects
            </li>
          )}
          {data.pinned.map((bookmark) => row(bookmark, true))}
        </ul>
      )}
      <ul role="list" className="flex flex-col gap-0.5">
        {data?.project.bookmarks
          .filter((bookmark) => !bookmark.folderId)
          .map((bookmark) => row(bookmark, false))}
        {data?.project.folders.map((folder) => {
          const open = expanded.includes(folder.id);
          const children = data.project.bookmarks.filter(
            (bookmark) => bookmark.folderId === folder.id,
          );
          return (
            <li
              key={folder.id}
              data-bookmark-drop={`folder:${folder.id}`}
              {...dropHandlers(`folder:${folder.id}`)}
              className={
                dropTarget === `folder:${folder.id}`
                  ? "rounded-md bg-accent/10 ring-1 ring-accent"
                  : ""
              }
            >
              <SidebarItemRow
                label={folder.label}
                icon={<Folder className="size-4 shrink-0" />}
                end={
                  <ChevronRight
                    className={`size-3 shrink-0 transition-transform duration-150 ${open ? "rotate-90" : ""}`}
                  />
                }
                menu={FOLDER_MENU}
                onOpen={() =>
                  setExpanded((current) =>
                    open
                      ? current.filter((id) => id !== folder.id)
                      : [...current, folder.id],
                  )
                }
                expanded={open}
                onAction={(entry) => {
                  if (entry.action === "rename")
                    setEdit({
                      kind: "rename",
                      id: folder.id,
                      label: folder.label,
                    });
                  if (entry.action === "remove")
                    perform(
                      desktopApi.bookmarksRemove({
                        projectId,
                        profileId,
                        id: folder.id,
                      }),
                    );
                }}
              />
              <div
                className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"}`}
                inert={!open ? true : undefined}
                aria-hidden={!open}
              >
                <div className="overflow-hidden">
                  <ul role="list" className="flex flex-col gap-0.5 pl-4">
                    {children.map((bookmark) => row(bookmark, false))}
                  </ul>
                  {children.length === 0 && (
                    <p className="px-4 py-2 text-xs text-fg-muted">
                      Drop a tab or chat here.
                    </p>
                  )}
                </div>
              </div>
            </li>
          );
        })}
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
