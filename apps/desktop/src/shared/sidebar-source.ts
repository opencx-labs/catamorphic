import type { SessionMetadata } from "@catamorphic/agent-protocol";
import type { CollectionPage } from "@catamorphic/app";
import {
  rowTargetAllowed,
  type SidebarItem,
  type SidebarSourceEffect,
} from "./sidebar.js";

/**
 * The chat a session-scoped section (`when.session`) sits beside, given to
 * its source (ADR 0226): what agents record on the session reaches a
 * section the person wrote. The section loads again when it changes.
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
 * Work, as a source sees it (ADR 0234): the lists its section's
 * `collections` grant names, and the workflows its `workflows` grant
 * names. A workflow is how a source reaches secrets, company APIs and
 * connections: it runs under the run's own authorization and audit.
 */
export interface SidebarSourceWork {
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
    values?: Record<string, string>;
  }) => Promise<void>;
  /** Run a project workflow and wait for its output. */
  call: (request: { workflow: string; input?: unknown }) => Promise<unknown>;
}

/** What every handler is given. */
interface SidebarSourceRequestContext {
  projectRoot: string;
  /** The chat beside a session-scoped section; absent elsewhere. */
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
      values?: Record<string, string>;
    },
  ) => unknown | Promise<unknown>;
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
  ) => unknown | Promise<unknown>;
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
  ) => unknown | Promise<unknown>;
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

/** Read an action's result as an effect; anything else is no effect. */
export function sidebarSourceEffect(
  value: unknown,
): SidebarSourceEffect | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const open = "open" in value ? value.open : undefined;
  const mode = "mode" in value ? value.mode : undefined;
  const message = "message" in value ? value.message : undefined;
  // Only commands that open something (ROW_COMMANDS), and a bounded address.
  const target =
    typeof open === "string" &&
    open &&
    open.length <= 8192 &&
    rowTargetAllowed(open)
      ? open
      : undefined;
  const effect: SidebarSourceEffect = {
    ...(target ? { open: target } : {}),
    ...(target &&
    (mode === "replace" ||
      mode === "tab" ||
      mode === "side" ||
      mode === "floating")
      ? { mode }
      : {}),
    ...(typeof message === "string" && message
      ? { message: message.slice(0, 280) }
      : {}),
  };
  return effect.open || effect.message ? effect : undefined;
}

/** Which optional handlers a running source exports; drives drag targets. */
export interface SidebarSourceCapabilities {
  move: boolean;
  drop: boolean;
  reveal: boolean;
}
export interface SidebarSourceRequest {
  projectId: string;
  sectionId: string;
  requestId: string;
  method: "load" | "action" | "move" | "drop" | "reveal";
  parentId?: string | null;
  cursor?: string;
  /** Palette modes with search "source" pass the typed query to load. */
  query?: string;
  itemId?: string;
  action?: string;
  values?: Record<string, string>;
  beforeId?: string;
  payload?: SidebarDropPayload;
  url?: string;
  after?: SidebarSourceItem;
  /** A session-scoped section's chat (ADR 0226). */
  session?: SidebarSourceSession;
}

/**
 * A module asking Work for something while it handles a request: routed to
 * the window that asked, checked against the section's grants there.
 */
export type SidebarSourceWorkCall =
  | {
      op: "read";
      source: string;
      parentId?: string | null;
      cursor?: string;
    }
  | {
      op: "execute";
      source: string;
      itemId: string;
      action: string;
      values?: Record<string, string>;
    }
  | { op: "call"; workflow: string; input?: unknown };
