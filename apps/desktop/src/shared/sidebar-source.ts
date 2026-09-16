import type { CollectionPage, CollectionSource } from "@catamorphic/app";
import type { SidebarItem } from "./sidebar.js";

/** Ordinary local code. Bun supplies filesystem, fetch, subprocesses and packages. */
export interface SidebarSourceItem extends SidebarItem {
  id: string;
  parentId?: string | null;
  hasChildren?: boolean;
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
}
export interface SidebarSourceRequest {
  projectId: string;
  sectionId: string;
  requestId: string;
  method: "load" | "action";
  parentId?: string | null;
  cursor?: string;
  itemId?: string;
  action?: string;
}
