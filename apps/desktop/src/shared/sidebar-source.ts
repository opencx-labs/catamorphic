import type { SessionMetadata } from "@catamorphic/agent-protocol";
import type { CollectionPage, CollectionSource } from "@catamorphic/app";
import type { SidebarItem } from "./sidebar.js";

/**
 * The chat a session-scoped section (`when.session`) sits beside, given to
 * its source (ADR 0225): what agents record on the session reaches a
 * section the person wrote. The section loads again when it changes.
 */
export interface SidebarSourceSession {
  id: string;
  title: string | null;
  metadata: SessionMetadata;
}

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
      /**
       * What the user typed, only for a palette mode with search "source"
       * (ADR 0186). Absent for sidebar loads and palette-ranked modes.
       */
      query?: string;
      /** The chat beside a session-scoped section; absent elsewhere. */
      session?: SidebarSourceSession;
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
    session?: SidebarSourceSession;
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
    session?: SidebarSourceSession;
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
    session?: SidebarSourceSession;
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
  /** Palette modes with search "source" pass the typed query to load. */
  query?: string;
  itemId?: string;
  action?: string;
  beforeId?: string;
  payload?: SidebarDropPayload;
  /** A session-scoped section's chat (ADR 0225). */
  session?: SidebarSourceSession;
}
