import {
  Bookmark as BookmarkIcon,
  ChevronRight,
  Folder,
  Pin,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  type Bookmark,
  type BookmarksData,
  desktopApi,
  type SidebarMenuEntry,
} from "../lib/desktop-api.js";
import { SidebarItemRow } from "./sidebar-item-row.js";

/** Fallbacks when sidebar.js doesn't override the section's menu. */
const PROJECT_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Pin across projects", action: "pin" },
  { label: "Rename…", action: "rename" },
  { label: "Delete", action: "remove", danger: true },
];

const PINNED_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Unpin into this project", action: "unpin" },
  { label: "Rename…", action: "rename" },
  { label: "Delete", action: "remove", danger: true },
];

/**
 * Per-project bookmarks with one level of folders, plus the profile-wide
 * "pinned" group on top. Rows are the shared SidebarItemRow, so a
 * bookmark and a config-defined custom item behave identically.
 */
export function BookmarksNav({
  projectId,
  profileId,
  menuOverride,
  onOpen,
}: {
  projectId: string;
  profileId: string;
  /** `menu` from sidebar.js for this section, if the user set one. */
  menuOverride?: SidebarMenuEntry[];
  onOpen: (url: string, mode?: "tab" | "replace") => void;
}) {
  const [data, setData] = useState<BookmarksData | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void desktopApi.bookmarksGet({ projectId, profileId }).then((loaded) => {
      if (!cancelled) setData(loaded);
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.profileId !== profileId) return;
      if (change.projectId === projectId && change.project) {
        setData({ project: change.project, pinned: change.pinned });
      } else if (change.projectId === null) {
        // Profile-wide change (e.g. browser import): pinned only.
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

  if (!data) return null;
  const { project, pinned } = data;

  if (
    pinned.length === 0 &&
    project.bookmarks.length === 0 &&
    project.folders.length === 0
  ) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">
        Bookmark pages with the star in the address bar.
      </p>
    );
  }

  const runAction = (
    entry: SidebarMenuEntry,
    bookmark: Bookmark,
    isPinned: boolean,
  ) => {
    const scope = { projectId, profileId, id: bookmark.id };
    switch (entry.action) {
      case "open":
        onOpen(bookmark.url);
        break;
      case "open-tab":
        onOpen(bookmark.url, "tab");
        break;
      case "open-here":
        onOpen(bookmark.url, "replace");
        break;
      case "copy-url":
        void navigator.clipboard.writeText(bookmark.url);
        break;
      case "pin":
        void desktopApi.bookmarksPin(scope);
        break;
      case "unpin":
        void desktopApi.bookmarksUnpin(scope);
        break;
      case "rename":
        setRenamingId(bookmark.id);
        break;
      case "remove":
        void (isPinned
          ? desktopApi.bookmarksRemovePinned(scope)
          : desktopApi.bookmarksRemove(scope));
        break;
    }
  };

  const row = (bookmark: Bookmark, isPinned: boolean) => (
    <li key={bookmark.id}>
      <SidebarItemRow
        label={bookmark.label}
        title={bookmark.url}
        icon={
          isPinned ? (
            <Pin className="size-3.5 shrink-0 text-fg-faint" />
          ) : (
            <BookmarkIcon className="size-3.5 shrink-0 text-fg-faint" />
          )
        }
        menu={menuOverride ?? (isPinned ? PINNED_MENU : PROJECT_MENU)}
        onOpen={() => onOpen(bookmark.url)}
        onAction={(entry) => runAction(entry, bookmark, isPinned)}
        renaming={renamingId === bookmark.id}
        onRenameSubmit={(label) => {
          setRenamingId(null);
          if (label.trim() && label !== bookmark.label) {
            void desktopApi.bookmarksRename({
              projectId,
              profileId,
              id: bookmark.id,
              label,
            });
          }
        }}
        onRenameCancel={() => setRenamingId(null)}
      />
    </li>
  );

  const rootBookmarks = project.bookmarks.filter(
    (bookmark) => !bookmark.folderId,
  );

  return (
    <ul className="flex flex-col gap-0.5">
      {pinned.map((bookmark) => row(bookmark, true))}
      {rootBookmarks.map((bookmark) => row(bookmark, false))}
      {project.folders.map((folder) => (
        <BookmarkFolderRow key={folder.id} label={folder.label}>
          {project.bookmarks
            .filter((bookmark) => bookmark.folderId === folder.id)
            .map((bookmark) => row(bookmark, false))}
        </BookmarkFolderRow>
      ))}
    </ul>
  );
}

function BookmarkFolderRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <li>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay/60 hover:text-fg"
        aria-expanded={open}
      >
        <ChevronRight
          className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${open ? "rotate-90" : ""}`}
        />
        <Folder className="size-3.5 shrink-0 text-fg-faint" />
        <span className="truncate">{label}</span>
      </button>
      {open && <ul className="ml-5 flex flex-col gap-0.5">{children}</ul>}
    </li>
  );
}
