import type { JsonValue, SessionMetadata } from "@catamorphic/agent-protocol";
import type { CollectionPage, WorkflowClient } from "@catamorphic/app";
import type {
  OpenMode,
  SidebarInputValues,
  SidebarItem,
  SidebarSourceEffect,
  SidebarSurface,
} from "./sidebar.js";

/**
 * The current chat, regardless of whether a section uses when.session.
 * The source loads again when its title or metadata changes.
 */
export interface SidebarSourceSession {
  id: string;
  title: string | null;
  metadata: SessionMetadata;
}

/**
 * One row of a source (ADR 0234). Work's own lists and a person's modules
 * return the same shape, so a module can pass Work's rows through.
 */
export interface SidebarSourceItem extends SidebarItem {
  id: string;
  parentId?: string | null;
  hasChildren?: boolean;
  /**
   * Rows dragged onto it may go inside while it holds none yet (a chat
   * that has no tabs under it). A row with children always may.
   */
  acceptsChildren?: boolean;
  /**
   * The record behind the row (a chat's fields, a file's path), for code
   * that reads Work's lists. Never drawn.
   */
  data?: Record<string, unknown>;
}
/** Something dragged into a section from elsewhere: a page, chat, file or row. */
export interface SidebarDropPayload {
  kind: string;
  label: string;
  url?: string;
}

/**
 * Work, as a source sees it: lists and workflows declared by its package
 * access manifest. A workflow is how a source reaches secrets, company APIs and
 * connections: it runs under the run's own authorization and audit.
 */
export interface SidebarSourceWork extends WorkflowClient {
  /** Member-private, package-scoped JSON state; updates are conditional on the version read. */
  state: {
    read(request: { key: string }): Promise<{
      key: string;
      address: string;
      version: number;
      value: JsonValue;
    }>;
    write(request: {
      key: string;
      value: JsonValue;
      ifVersion: number;
    }): Promise<{
      key: string;
      address: string;
      version: number;
      value: JsonValue;
    }>;
    delete(request: {
      key: string;
      ifVersion: number;
    }): Promise<{ version: number }>;
  };
  /** Durable user notification, without starting an agent turn. */
  notify(request: {
    title: string;
    body?: string;
    route?: string;
    idempotencyKey: string;
  }): Promise<unknown>;
  /** Processes run within this package's allowed reach; application lifetime continues after UI quit. */
  processes: {
    start(request: {
      key: string;
      command: string;
      name?: string;
      lifetime: "view" | "application";
    }): Promise<CustomizationProcess>;
    list(): Promise<CustomizationProcess[]>;
    read(request: {
      key: string;
      cursor?: number;
      maxBytes?: number;
      waitMs?: number;
    }): Promise<CustomizationProcessOutput>;
    stop(request: { key: string }): Promise<CustomizationProcess>;
  };
  /** One page of a Work list by its bare name (`chats`, `files`). */
  read: (request: {
    source: string;
    parentId?: string | null;
    cursor?: string;
  }) => Promise<CollectionPage<SidebarSourceItem>>;
  /** Run an action of a Work list's row, as its menu would. */
  execute: (request: {
    source: string;
    itemId: string;
    action: string;
    mode?: OpenMode;
    values?: SidebarInputValues;
  }) => Promise<void>;
}

export interface CustomizationProcess {
  key: string;
  lifetime: "view" | "application";
  processId: string;
  command: string;
  name?: string;
  status: "running" | "exited";
  exitCode: number | null;
  startedAt: string;
  endedAt: string | null;
  /** Desired supervision state, separate from the current attempt's status. */
  enabled?: boolean;
  error?: string;
}
export interface CustomizationProcessOutput {
  chunk: string;
  cursor: number;
  nextCursor: number;
  more: boolean;
  outputBytes: number;
  status: "running" | "exited";
  exitCode: number | null;
}

/** What every handler is given. */
export interface SidebarSourceRequestContext {
  projectRoot: string;
  /** The current surface, independent from visibility predicates. */
  surface?: SidebarSurface;
  /** The current chat, including one owning the surface in front. */
  session?: SidebarSourceSession;
  /** Work's lists and workflows, as the section grants them. */
  work: SidebarSourceWork;
  signal: AbortSignal;
}

/**
 * The contract every source implements (ADR 0140, 0234): a person's module
 * in its Bun process, and each of Work's own lists in the window.
 */
export interface SidebarSourceModule {
  load: (
    request: SidebarSourceRequestContext & {
      parentId: string | null;
      cursor?: string;
      /**
       * What the user typed, only for a palette mode with search "source"
       * (ADR 0186). Absent for sidebar loads and palette-ranked modes.
       */
      query?: string;
    },
  ) => Promise<CollectionPage<SidebarSourceItem>>;
  subscribe?: (context: {
    projectRoot: string;
    invalidate: () => void;
  }) => (() => void) | Promise<() => void>;
  /**
   * A row's own action (`itemId`), or a header action (`itemId` ""). An
   * entry with `input` passes what the person typed as `values`. Return
   * `{ open, mode }` for Work to open a target afterwards, and `message`
   * to say what happened.
   */
  action?: (
    request: SidebarSourceRequestContext & {
      itemId: string;
      action: string;
      /** Opening is always action "open" with a separate mode. */
      mode?: OpenMode;
      values?: SidebarInputValues;
    },
  ) =>
    | void
    | SidebarSourceEffect
    | Promise<void>
    | Promise<SidebarSourceEffect | undefined>;
  /**
   * Dragging one of this source's own rows: place `itemId` under
   * `parentId` (null for the root) before `beforeId`, or last. Exporting
   * this makes every row draggable and every row a drop slot.
   */
  move?: (
    request: SidebarSourceRequestContext & {
      itemId: string;
      parentId: string | null;
      beforeId?: string;
    },
  ) => void | Promise<void>;
  /**
   * Dropping something from outside the section (a browser tab, a chat, a
   * bookmark, another section's row) at the same kind of slot.
   */
  drop?: (
    request: SidebarSourceRequestContext & {
      parentId: string | null;
      beforeId?: string;
      payload: SidebarDropPayload;
    },
  ) => void | Promise<void>;
  /**
   * The row for a target in front (`url`) that no loaded page holds, shown
   * past the loaded rows; null when it belongs elsewhere. `after` is the
   * last loaded row.
   */
  reveal?: (
    request: SidebarSourceRequestContext & {
      url: string;
      after?: SidebarSourceItem;
    },
  ) => Promise<SidebarSourceItem | null>;
}
