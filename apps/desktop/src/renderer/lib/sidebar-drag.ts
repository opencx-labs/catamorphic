import type { TreeDragSpec } from "@catamorphic/app/ui";
import { TAB_DRAG_TYPE, type TabDragPayload } from "./tab-drag.js";

/**
 * One payload for every sidebar row. Sections accept or refuse a drop by
 * section and scope; the payload's data is only readable on drop, so the
 * live drag is also kept here for dragover decisions in the same window.
 */
export const SIDEBAR_ITEM_DRAG_TYPE = "application/x-catamorphic-sidebar-item";

export interface SidebarItemDragPayload {
  sectionId: string;
  /** A section may hold several independent lists (bookmarks: project, pinned, library). */
  scope?: string;
  id: string;
  parentId: string | null;
  kind: "item" | "folder";
  label: string;
  url?: string;
}

let current: SidebarItemDragPayload | null = null;
if (typeof document !== "undefined") {
  // The payload is readable inside dragstart; remember it for the dragover
  // decisions that follow, where the browser hides everything but types.
  document.addEventListener("dragstart", (event) => {
    const raw = event.dataTransfer?.getData(SIDEBAR_ITEM_DRAG_TYPE);
    if (!raw) return;
    try {
      current = JSON.parse(raw) as SidebarItemDragPayload;
    } catch {
      current = null;
    }
  });
  document.addEventListener("dragend", () => {
    current = null;
  });
  document.addEventListener("drop", () => {
    current = null;
  });
}

/** The sidebar row being dragged right now, if the drag started here. */
export const currentSidebarDrag = () => current;

/** What a sidebar row offers when dragged: itself, and its link when it has one. */
export function sidebarItemDragSpec(
  payload: SidebarItemDragPayload,
  tab?: TabDragPayload,
): TreeDragSpec {
  const data: Record<string, string> = {
    [SIDEBAR_ITEM_DRAG_TYPE]: JSON.stringify(payload),
  };
  if (tab) data[TAB_DRAG_TYPE] = JSON.stringify(tab);
  if (payload.url) data["text/uri-list"] = payload.url;
  return { data, effectAllowed: "copyMove" };
}

export function readSidebarItemDrag(
  transfer: DataTransfer,
): SidebarItemDragPayload | null {
  const raw = transfer.getData(SIDEBAR_ITEM_DRAG_TYPE);
  if (!raw) return current;
  try {
    return JSON.parse(raw) as SidebarItemDragPayload;
  } catch {
    return current;
  }
}

/** A drag of one of this section's own rows, in this scope. */
export function isOwnSidebarDrag(
  types: readonly string[],
  sectionId: string,
  scope?: string,
): boolean {
  if (!types.includes(SIDEBAR_ITEM_DRAG_TYPE)) return false;
  const drag = current;
  return (
    drag !== null &&
    drag.sectionId === sectionId &&
    (drag.scope ?? "") === (scope ?? "")
  );
}
