import type { SidebarItem } from "../../shared/sidebar.js";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { childrenOf, pageOf, type SectionSource } from "./contract.js";

/** A static item worth a row: a link, an action, or a folder holding one. */
function shown(
  item: SidebarItem,
  keep: (item: SidebarItem) => boolean,
): boolean {
  if (item.hide || !keep(item)) return false;
  if (item.url || item.actions?.length) return true;
  return (item.items ?? []).some((child) => shown(child, keep));
}

/** A layout's static rows, flattened into one tree of rows. */
export function itemRows(
  items: readonly SidebarItem[],
  {
    ownerId,
    keep = () => true,
  }: { ownerId: string; keep?: (item: SidebarItem) => boolean },
): SidebarSourceItem[] {
  const rows: SidebarSourceItem[] = [];
  const visit = (entries: readonly SidebarItem[], parentId: string | null) => {
    for (const item of entries) {
      if (!shown(item, keep)) continue;
      const id = item.id ?? `${parentId ?? ownerId}/${item.url ?? item.label}`;
      const { items: children, when: _when, ...row } = item;
      rows.push({
        ...row,
        id,
        parentId,
        hasChildren: Boolean(children?.some((child) => shown(child, keep))),
        // A layout's folders start open unless they say otherwise.
        collapsed: item.collapsed === true,
        icon: item.icon ?? (item.url ? undefined : "Folder"),
      });
      visit(children ?? [], id);
    }
  };
  visit(items, null);
  return rows;
}

/**
 * A section's `items` as a source: links open their address, folders open
 * and close, and nothing else runs (there is no code behind them).
 */
export function itemsSource({
  items,
  ownerId,
  keep,
  title = "Links",
}: {
  items: readonly SidebarItem[];
  ownerId: string;
  keep?: (item: SidebarItem) => boolean;
  title?: string;
}): SectionSource {
  const rows = itemRows(items, { ownerId, keep });
  return {
    title,
    empty: "No links yet.",
    capabilities: () => ({ move: false, drop: false, reveal: false }),
    load: async ({ parentId, cursor }) =>
      pageOf(childrenOf(rows, parentId), cursor, 1000),
  };
}
