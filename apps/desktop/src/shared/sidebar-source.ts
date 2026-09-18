import type { CollectionPage, CollectionSource } from "@catamorphic/app";
import type { SidebarItem } from "./sidebar.js";

/** Ordinary local code. Bun supplies filesystem, fetch, subprocesses and packages. */
export interface SidebarSourceItem extends SidebarItem {
  id: string;
  parentId?: string | null;
  hasChildren?: boolean;
}
/** Something dragged into a section from elsewhere: a page, chat, file or row. */
export interface SidebarDropPayload {
  kind: string;
  label: string;
  url?: string;
}
export interface SidebarSourceModule {
  load: (
    request: Parameters<CollectionSource<SidebarSourceItem>["load"]>[0] & {
      projectRoot: string;
    },
  ) => Promise<CollectionPage<SidebarSourceItem>>;
  subscribe?: (context: {
    projectRoot: string;
    invalidate: () => void;
  }) => (() => void) | Promise<() => void>;
  action?: (request: {
    projectRoot: string;
    itemId: string;
    action: string;
    signal: AbortSignal;
  }) => unknown | Promise<unknown>;
  /**
   * Dragging one of this source's own rows: place `itemId` under
   * `parentId` (null for the root) before `beforeId`, or last. Exporting
   * this makes every row draggable and every row a drop slot.
   */
  move?: (request: {
    projectRoot: string;
    itemId: string;
    parentId: string | null;
    beforeId?: string;
    signal: AbortSignal;
  }) => unknown | Promise<unknown>;
  /**
   * Dropping something from outside the section (a browser tab, a chat, a
   * bookmark, another section's row) at the same kind of slot.
   */
  drop?: (request: {
    projectRoot: string;
    parentId: string | null;
    beforeId?: string;
    payload: SidebarDropPayload;
    signal: AbortSignal;
  }) => unknown | Promise<unknown>;
}
/** Which optional handlers a running source exports; drives drag targets. */
export interface SidebarSourceCapabilities {
  move: boolean;
  drop: boolean;
}
export interface SidebarSourceRequest {
  projectId: string;
  sectionId: string;
  requestId: string;
  method: "load" | "action" | "move" | "drop";
  parentId?: string | null;
  cursor?: string;
  itemId?: string;
  action?: string;
  beforeId?: string;
  payload?: SidebarDropPayload;
}
