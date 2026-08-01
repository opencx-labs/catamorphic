import {
  Bookmark as BookmarkIcon,
  ChevronRight,
  Folder,
  Pin,
  PinOff,
  Trash2,
} from "lucide-react";
import { useEffect, useState } from "react";
import {
  type Bookmark,
  type BookmarksData,
  desktopApi,
} from "../lib/desktop-api.js";

/**
 * Per-project bookmarks with one level of folders, plus the profile-wide
 * "Pinned" group on top. Pinning moves a bookmark out of the project so
 * it follows the user across projects (pinned = "mine", project = "the
 * work's"); pinning whole sections/items was considered and rejected —
 * one pinnable thing keeps the model simple.
 */
export function BookmarksNav({
  projectId,
  profileId,
  onOpen,
}: {
  projectId: string;
  profileId: string;
  onOpen: (url: string) => void;
}) {
  const [data, setData] = useState<BookmarksData | null>(null);

  useEffect(() => {
    let cancelled = false;
    void desktopApi
      .bookmarksGet({ projectId, profileId })
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.projectId === projectId && change.profileId === profileId) {
        setData({ project: change.project, pinned: change.pinned });
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, profileId]);

  if (!data) return null;
  const { project, pinned } = data;
  const rootBookmarks = project.bookmarks.filter(
    (bookmark) => !bookmark.folderId,
  );

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

  const row = (bookmark: Bookmark, isPinned: boolean) => (
    <li key={bookmark.id}>
      <div className="group flex h-7 items-center rounded-md transition-colors duration-150 hover:bg-bg-overlay/60">
        <button
          type="button"
          onClick={() => onOpen(bookmark.url)}
          className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-[13px] text-fg-muted hover:text-fg"
          title={bookmark.url}
        >
          {isPinned ? (
            <Pin className="size-3.5 shrink-0 text-fg-faint" />
          ) : (
            <BookmarkIcon className="size-3.5 shrink-0 text-fg-faint" />
          )}
          <span className="truncate">{bookmark.label}</span>
        </button>
        <button
          type="button"
          onClick={() =>
            void (isPinned
              ? desktopApi.bookmarksUnpin({
                  projectId,
                  profileId,
                  id: bookmark.id,
                })
              : desktopApi.bookmarksPin({
                  projectId,
                  profileId,
                  id: bookmark.id,
                }))
          }
          className="hidden size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-fg group-hover:grid"
          aria-label={isPinned ? "Unpin into this project" : "Pin across projects"}
          title={isPinned ? "Unpin into this project" : "Pin across projects"}
        >
          {isPinned ? (
            <PinOff className="size-3" />
          ) : (
            <Pin className="size-3" />
          )}
        </button>
        <button
          type="button"
          onClick={() =>
            void (isPinned
              ? desktopApi.bookmarksRemovePinned({
                  projectId,
                  profileId,
                  id: bookmark.id,
                })
              : desktopApi.bookmarksRemove({
                  projectId,
                  profileId,
                  id: bookmark.id,
                }))
          }
          className="mr-1 hidden size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-danger group-hover:grid"
          aria-label={`Delete bookmark ${bookmark.label}`}
        >
          <Trash2 className="size-3" />
        </button>
      </div>
    </li>
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
