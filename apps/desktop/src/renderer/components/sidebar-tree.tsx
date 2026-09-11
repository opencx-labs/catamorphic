import {
  Tree,
  type TreeItem,
  type TreeRenderContext,
} from "@catamorphic/app/ui";
import { type ReactNode, useMemo } from "react";
import {
  projectSidebarItems,
  sidebarItemPresentation,
  useSidebarContribution,
  useSidebarItemCount,
} from "./sidebar-contribution.js";
import { SidebarItemRow } from "./sidebar-item-row.js";

/** Every desktop collection uses the public tree with host-owned row chrome. */
export function SidebarTree<T extends TreeItem>({
  items,
  label,
  renderItem,
  selectedId,
  defaultExpanded = true,
  height,
  rowHeight,
  loadChildren,
}: {
  items: readonly T[];
  label: string;
  selectedId?: string;
  defaultExpanded?: boolean;
  height?: number;
  rowHeight?: number;
  loadChildren?: (id: string) => void;
  renderItem: (item: T, context: TreeRenderContext) => ReactNode;
}) {
  const contribution = useSidebarContribution();
  const section = contribution?.section;
  const filtered = useMemo(
    () =>
      projectSidebarItems(items, section).filter(
        (item) =>
          !sidebarItemPresentation({ section, id: item.id }).hide &&
          !("hide" in item && item.hide === true),
      ),
    [items, section],
  );
  useSidebarItemCount(filtered.length);
  type Entry = {
    id: string;
    parentId?: string | null;
    hasChildren?: boolean;
    collapsed?: boolean;
    item?: T;
    group?: string;
  };
  const entries = useMemo(() => {
    const groupBy = section?.source?.groupBy;
    const groups = new Map<string, Entry>();
    const ids = new Set(filtered.map((item) => item.id));
    const nodes: Entry[] = filtered.map((item) => {
      if (!groupBy || (item.parentId && ids.has(item.parentId)))
        return { ...item, item };
      const group = String(
        Object.entries(item).find(([key]) => key === groupBy)?.[1] ?? "Other",
      );
      const id = `group:${group}`;
      groups.set(id, { id, group, hasChildren: true });
      return { ...item, parentId: id, item };
    });
    return [...groups.values(), ...nodes];
  }, [filtered, section?.source?.groupBy]);
  return (
    <Tree
      items={entries}
      motionClasses={{
        enter: "animate-session-row-in",
        exit: "animate-session-row-out",
      }}
      label={label}
      selectedId={selectedId}
      defaultExpanded={defaultExpanded}
      height={section?.height ?? height}
      rowHeight={section?.rowHeight ?? rowHeight}
      loadChildren={loadChildren}
      renderItem={(entry, context) =>
        entry.item ? (
          renderItem(entry.item, context)
        ) : (
          <SidebarItemRow
            itemId={entry.id}
            label={entry.group ?? "Group"}
            icon="Folder"
            disclosure={{ open: context.expanded, onToggle: context.toggle }}
            onOpen={context.toggle}
            onAction={() => {}}
          />
        )
      }
    />
  );
}
