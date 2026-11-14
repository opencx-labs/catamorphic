import { tabKey, type WorkspaceTab } from "./workspace-types.js";

export interface RenderedTab {
  /** React key: the tab's own, or its departing copy's after a pin change. */
  id: string;
  tab: WorkspaceTab;
  exiting: boolean;
  /** Width a departing tab collapses from (px); unmeasured: the widest. */
  width?: number;
}

/** A pinned or unpinned tab leaves its old place as this copy of itself. */
const pinGhostId = (key: string) => `${key}\u0000pin`;

/**
 * Merge incoming tabs with the previous render list so removed tabs stay
 * mounted (near their old position) while their exit animation plays. The
 * width collapse of an exiting tab is what slides its neighbors over.
 * Surviving tabs follow the INCOMING order — drag-reordering must move
 * them, not freeze them at their first-render positions. A tab whose pin
 * changed is both: a copy of its old self collapses where it stood while
 * the tab itself enters at its new place, as a pin or a full tab.
 */
export function mergeRendered(
  previous: RenderedTab[],
  tabs: WorkspaceTab[],
  widthOf: (id: string) => number | undefined = () => undefined,
): RenderedTab[] {
  const incoming = new Map(tabs.map((tab) => [tabKey(tab), tab]));
  const merged: RenderedTab[] = tabs.map((tab) => ({
    id: tabKey(tab),
    tab,
    exiting: false,
  }));
  const repinned = new Set(
    previous.flatMap((entry) => {
      const next = !entry.exiting && incoming.get(entry.id);
      return next && Boolean(next.pinned) !== Boolean(entry.tab.pinned)
        ? [entry.id]
        : [];
    }),
  );
  previous.forEach((entry, index) => {
    const ghost = repinned.has(entry.id);
    // A copy still leaving from an earlier pin change gives way to this one.
    const stale =
      entry.id !== tabKey(entry.tab) && repinned.has(tabKey(entry.tab));
    if (stale || (!ghost && incoming.has(entry.id))) return;
    // After the tab it followed, wherever that went; else where it stood.
    const anchor = index > 0 ? previous[index - 1]?.id : undefined;
    const anchorAt = merged.findIndex((rendered) => rendered.id === anchor);
    const at = anchorAt >= 0 ? anchorAt + 1 : Math.min(index, merged.length);
    // Pinned where it stood (the pins ended there): the pin leads its copy.
    const after = ghost && !entry.tab.pinned && merged[at]?.id === entry.id;
    merged.splice(after ? at + 1 : at, 0, {
      id: ghost ? pinGhostId(entry.id) : entry.id,
      tab: entry.tab,
      exiting: true,
      width: entry.exiting ? entry.width : widthOf(entry.id),
    });
  });
  return merged;
}
