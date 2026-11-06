import {
  type BookmarkScope,
  parseChatBookmarkUrl,
} from "../../shared/bookmark-target.js";
import type { SidebarMenuEntry } from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import {
  type Bookmark,
  type BookmarksData,
  desktopApi,
  type ProjectBookmarks,
} from "../lib/desktop-api.js";
import { tabKey } from "../lib/workspace-types.js";
import {
  capabilitiesOf,
  childrenOf,
  invalidateBranches,
  pageOf,
  type SectionSource,
} from "./contract.js";
import type { WorkSourceDeps } from "./deps.js";

/**
 * How many times one profile's bookmarks for a project changed in this
 * window: part of the cache key, so a read after a change never joins one
 * that started before it, and an older read is never cancelled under a list.
 */
const generations = new Map<string, number>();
const scopeKeyOf = (projectId: string, profileId: string) =>
  `${profileId}\u0000${projectId}`;

/** One profile's bookmarks for the project, through the window's cache. */
export function readBookmarks(
  deps: WorkSourceDeps,
  profileId: string,
): Promise<BookmarksData> {
  return deps.queryClient.fetchQuery({
    queryKey: [
      "desktop",
      "bookmarks",
      profileId,
      deps.projectId,
      generations.get(scopeKeyOf(deps.projectId, profileId)) ?? 0,
    ],
    staleTime: 1000,
    queryFn: () =>
      desktopApi.bookmarksGet({ projectId: deps.projectId, profileId }),
  });
}

/** Calls `listener` when this profile's bookmarks for the project change. */
export function onBookmarksChange(
  deps: WorkSourceDeps,
  listener: () => void,
): () => void {
  return desktopApi.onBookmarksChanged((change) => {
    if (
      change.profileId !== deps.profileId ||
      (change.projectId && change.projectId !== deps.projectId)
    )
      return;
    const key = scopeKeyOf(deps.projectId, change.profileId);
    generations.set(key, (generations.get(key) ?? 0) + 1);
    listener();
  });
}

/**
 * What the sidebar keeps above the open tabs: the project's bookmarks and
 * the pinned pages. A tab open on one of these is listed there, not twice.
 */
export function savedAddresses(data: BookmarksData): Set<string> {
  return new Set(
    [...data.project.bookmarks, ...data.pinned.bookmarks].map(
      (bookmark) => bookmark.url,
    ),
  );
}

/** The window's open tabs by the address they would be saved under. */
function openTabs(deps: WorkSourceDeps): Map<string, string> {
  return new Map(
    deps
      .host()
      .tabs.flatMap((tab): [string, string][] =>
        tab.bookmarkUrl ? [[tab.bookmarkUrl, tabKey(tab)]] : [],
      ),
  );
}

/** What the address field holds, as the web address it names. */
export function webAddress(input: string): string {
  const typed = input.trim();
  const parsed = new URL(
    /^[a-z][a-z\d+.-]*:/i.test(typed) ? typed : `https://${typed}`,
  );
  if (!["http:", "https:"].includes(parsed.protocol))
    throw new Error("Enter an http or https address.");
  return parsed.href;
}

function bookmarkMenu(
  scope: BookmarkScope,
  bookmark: Bookmark,
): SidebarMenuEntry[] {
  // A saved chat keeps its address: it names a conversation.
  const chat = parseChatBookmarkUrl(bookmark.url) !== null;
  return [
    { label: "Copy link", action: "copy-url" },
    scope === "pinned"
      ? { label: "Unpin", action: "unpin" }
      : { label: "Pin across projects", action: "pin" },
    {
      label: "Edit…",
      action: "edit",
      input: {
        title: "Edit bookmark",
        fields: [
          { name: "label", label: "Name", value: bookmark.label },
          ...(chat
            ? []
            : [
                {
                  name: "url",
                  label: "Address",
                  value: bookmark.url,
                  placeholder: "https://example.com",
                },
              ]),
        ],
      },
    },
    { label: "Delete", action: "remove", danger: true },
  ];
}

/** The fields that name a page to save. */
const ADD_BOOKMARK: SidebarMenuEntry["input"] = {
  title: "Add bookmark",
  submit: "Add",
  fields: [
    { name: "url", label: "Address", placeholder: "https://" },
    { name: "label", label: "Name" },
  ],
};

function folderMenu(scope: BookmarkScope, label: string): SidebarMenuEntry[] {
  return [
    // New pages are the project's; pinned is filled by pinning.
    ...(scope !== "project"
      ? []
      : [{ label: "Add bookmark…", action: "add", input: ADD_BOOKMARK }]),
    {
      label: "Rename folder…",
      action: "rename-folder",
      input: {
        title: "Rename folder",
        fields: [{ name: "label", label: "Name", value: label }],
      },
    },
    {
      label: "Remove folder, keep bookmarks",
      action: "remove",
      danger: true,
    },
  ];
}

function rowsOf(
  scope: BookmarkScope,
  list: ProjectBookmarks,
  open: ReadonlyMap<string, string>,
) {
  const folders: SidebarSourceItem[] = list.folders.map((folder) => ({
    id: folder.id,
    parentId: folder.parentId ?? null,
    hasChildren: true,
    label: folder.label,
    icon: "Folder",
    menu: folderMenu(scope, folder.label),
    data: { folder: true, scope },
  }));
  const bookmarks: SidebarSourceItem[] = list.bookmarks.map((bookmark) => ({
    id: bookmark.id,
    parentId: bookmark.folderId ?? null,
    label: bookmark.label,
    url: bookmark.url,
    // A favicon seen on the page; otherwise the address decides the glyph.
    ...(bookmark.faviconUrl ? { icon: bookmark.faviconUrl } : {}),
    // Open in a tab, the bookmark stands for it: the tab closes from here.
    ...(open.has(bookmark.url)
      ? {
          actions: [
            { label: `Close ${bookmark.label}`, action: "close", icon: "X" },
          ],
        }
      : {}),
    menu: bookmarkMenu(scope, bookmark),
    data: {
      url: bookmark.url,
      faviconUrl: bookmark.faviconUrl ?? null,
      scope,
    },
  }));
  // Folders before bookmarks, each in the store's order.
  return [...folders, ...bookmarks];
}

/** A page shown pinned above leaves the lists below while it is pinned. */
function unpinned(data: BookmarksData, list: ProjectBookmarks) {
  const pinned = new Set(
    data.pinned.bookmarks.flatMap((bookmark) => [bookmark.id, bookmark.url]),
  );
  return {
    ...list,
    bookmarks: list.bookmarks.filter(
      (bookmark) => !pinned.has(bookmark.id) && !pinned.has(bookmark.url),
    ),
  };
}

/**
 * `work:pinned` (pages pinned across this profile's projects),
 * `work:bookmarks` (this project's) and `work:library` (a browser's
 * imported bookmarks): one store, three lists. Each takes pages, chats and
 * other rows dropped into it (the library only from itself) and reorders
 * its own rows.
 */
export function bookmarksSource(
  deps: WorkSourceDeps,
  scope: BookmarkScope,
): SectionSource {
  const profileId = () => {
    if (!deps.profileId) throw new Error("Bookmarks need a profile.");
    return deps.profileId;
  };
  const read = () => readBookmarks(deps, profileId());
  // The library is a browser's imported bookmarks: no tab stands for one.
  const opened = () =>
    scope === "library" ? new Map<string, string>() : openTabs(deps);
  const target = () => ({ projectId: deps.projectId, profileId: profileId() });
  const source: SectionSource = {
    title:
      scope === "pinned"
        ? "Pinned"
        : scope === "library"
          ? "Library"
          : "Bookmarks",
    empty:
      scope === "pinned"
        ? "Drop a tab here to pin it across projects"
        : scope === "library"
          ? "No imported bookmarks."
          : "No bookmarks yet.",
    capabilities: () => capabilitiesOf(source),
    load: async ({ parentId, cursor }) => {
      const data = await read();
      const list =
        scope === "pinned"
          ? data.pinned
          : scope === "library"
            ? data.library && unpinned(data, data.library)
            : unpinned(data, data.project);
      return pageOf(
        childrenOf(list ? rowsOf(scope, list, opened()) : [], parentId),
        cursor,
        1000,
      );
    },
    subscribe: (publish, { branches }) => {
      const reread = () => invalidateBranches(publish, branches());
      const stops = [
        onBookmarksChange(deps, reread),
        // A tab opening or closing on a bookmark changes its row.
        ...(scope === "library" ? [] : [deps.onWindowChange("tabs", reread)]),
      ];
      return () => {
        for (const stop of stops) stop();
      };
    },
    action: async ({ itemId, action, values }) => {
      const label = values?.label?.trim() ?? "";
      if (action === "close") {
        const data = await read();
        const list = scope === "pinned" ? data.pinned : data.project;
        const url = list.bookmarks.find((entry) => entry.id === itemId)?.url;
        const key = url && opened().get(url);
        if (!key) throw new Error("This bookmark is not open.");
        deps.host().closeTab(key);
      } else if (action === "add") {
        if (scope !== "project")
          throw new Error("Add bookmarks to the project's list.");
        const address = webAddress(values?.url ?? "");
        await desktopApi.bookmarksAdd({
          ...target(),
          label: label || new URL(address).hostname,
          url: address,
          // From a folder's menu, into that folder; from the header, the top.
          ...(itemId ? { folderId: itemId } : {}),
        });
      } else if (action === "new-folder") {
        if (!label) throw new Error("Name the folder.");
        await desktopApi.bookmarksAddFolder({ ...target(), label });
      } else if (action === "pin")
        await desktopApi.bookmarksPin({ ...target(), id: itemId });
      else if (action === "unpin")
        await desktopApi.bookmarksUnpin({ ...target(), id: itemId });
      else if (action === "edit") {
        const data = await read();
        const list =
          scope === "pinned"
            ? data.pinned
            : scope === "library"
              ? data.library
              : data.project;
        const bookmark = list?.bookmarks.find((entry) => entry.id === itemId);
        if (!bookmark) throw new Error("This bookmark is gone.");
        if (!label) throw new Error("Name the bookmark.");
        await desktopApi.bookmarksUpdate({
          ...target(),
          scope,
          id: itemId,
          label,
          // Unchanged, the address is left as it is (it may be one an agent
          // wrote that the form would refuse).
          ...(values?.url === undefined || values.url === bookmark.url
            ? {}
            : { url: webAddress(values.url) }),
        });
      } else if (action === "rename-folder") {
        if (!label) throw new Error("Name the folder.");
        await desktopApi.bookmarksRenameFolder({
          ...target(),
          scope,
          id: itemId,
          label,
        });
      } else if (action === "remove")
        await desktopApi.bookmarksRemove({ ...target(), scope, id: itemId });
      else throw new Error("Bookmarks do not support that action");
      return undefined;
    },
    move: async ({ itemId, parentId, beforeId }) => {
      await desktopApi.bookmarksMove({
        ...target(),
        scope,
        id: itemId,
        folderId: parentId,
        beforeId,
      });
    },
    ...(scope === "library"
      ? {}
      : {
          drop: async ({ parentId, beforeId, payload }) => {
            if (!payload.url)
              throw new Error(
                "Open a page or send a chat message before saving it.",
              );
            await desktopApi.bookmarksPlace({
              ...target(),
              label: payload.label,
              url: payload.url,
              folderId: parentId ?? undefined,
              beforeId,
              pinned: scope === "pinned",
            });
          },
        }),
  };
  return source;
}
