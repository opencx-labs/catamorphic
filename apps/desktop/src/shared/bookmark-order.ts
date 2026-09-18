/**
 * Folders and bookmarks under one parent share a single order. Entries
 * carry an explicit `position`; entries from before positions existed
 * sort after them, folders first, in stored order. Both the store and the
 * sidebar tree read siblings through this so they always agree.
 */
export interface OrderedEntry {
  id: string;
  position?: number;
}
export interface OrderedScope {
  folders: Array<OrderedEntry & { parentId?: string }>;
  bookmarks: Array<OrderedEntry & { folderId?: string }>;
}
export interface Sibling {
  id: string;
  kind: "folder" | "bookmark";
}

const rank = (entry: OrderedEntry, fallback: number) =>
  entry.position ?? Number.MAX_SAFE_INTEGER - 1_000_000 + fallback;

export function orderedSiblings(
  scope: OrderedScope,
  parentId: string | undefined,
): Sibling[] {
  const folders = scope.folders
    .map((folder, index) => ({ folder, index }))
    .filter(({ folder }) => (folder.parentId ?? undefined) === parentId);
  const bookmarks = scope.bookmarks
    .map((bookmark, index) => ({ bookmark, index }))
    .filter(({ bookmark }) => (bookmark.folderId ?? undefined) === parentId);
  return [
    ...folders.map(({ folder, index }) => ({
      id: folder.id,
      kind: "folder" as const,
      key: rank(folder, index),
    })),
    ...bookmarks.map(({ bookmark, index }) => ({
      id: bookmark.id,
      kind: "bookmark" as const,
      key: rank(bookmark, folders.length + index),
    })),
  ]
    .sort((a, b) => a.key - b.key)
    .map(({ id, kind }) => ({ id, kind }));
}

/** Display rank of every entry in a scope, by id. */
export function siblingRanks(scope: OrderedScope): Map<string, number> {
  const ranks = new Map<string, number>();
  const parents = new Set<string | undefined>([
    undefined,
    ...scope.folders.map((folder) => folder.id),
  ]);
  for (const parentId of parents)
    orderedSiblings(scope, parentId).forEach((sibling, index) => {
      ranks.set(sibling.id, index);
    });
  return ranks;
}
