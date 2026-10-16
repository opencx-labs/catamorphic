import type { CollectionChange, CollectionPage } from "@catamorphic/app";
import type { SidebarSourceEffect } from "../../shared/sidebar.js";
import type {
  SidebarDropPayload,
  SidebarSourceCapabilities,
  SidebarSourceItem,
  SidebarSourceSession,
} from "../../shared/sidebar-source.js";

/**
 * One source, as the window runs it (ADR 0234): a person's module behind
 * IPC, one of Work's lists, or a section's static items. The same contract
 * as `SidebarSourceModule`, minus what the window supplies itself (the
 * project root and `work`). Nothing that draws a section knows which kind
 * it has.
 */
export interface SourceRequest {
  /** The chat beside a session-scoped section (`when.session`). */
  session?: SidebarSourceSession;
  signal: AbortSignal;
}

export interface SectionSource {
  /** The heading a section shows when its layout gives none. */
  title: string;
  /** The sentence an empty section shows when its layout gives none. */
  empty: string;
  load: (
    request: SourceRequest & {
      parentId: string | null;
      cursor?: string;
      /** A palette mode with search "source" passes what was typed. */
      query?: string;
      /**
       * Rows the reader would take at once: a whole-list read asks for
       * more than a scrolled list's page. A hint; a source keeps its bound.
       */
      size?: number;
    },
  ) => Promise<CollectionPage<SidebarSourceItem>>;
  /**
   * Live changes, shared by every view of one collection. `branchSize`
   * tells a cheap poll how many rows a branch holds already.
   */
  subscribe?: (
    publish: (change: CollectionChange<SidebarSourceItem>) => void,
    context: {
      session?: SidebarSourceSession;
      /** Every branch this view has read (the root first). */
      branches: () => readonly (string | null)[];
      branchSize: (parentId: string | null) => number;
      /** The subscription itself failed (or recovered, with undefined). */
      fail: (error: string | undefined) => void;
    },
  ) => () => void;
  /**
   * A row's own action, or a header action (itemId ""). A row without a
   * `url` receives the open verbs (`open`, `open-tab`, ...) here too.
   */
  action?: (
    request: SourceRequest & {
      itemId: string;
      action: string;
      values?: Record<string, string>;
    },
  ) => Promise<SidebarSourceEffect | undefined>;
  move?: (
    request: SourceRequest & {
      itemId: string;
      parentId: string | null;
      beforeId?: string;
    },
  ) => Promise<void>;
  drop?: (
    request: SourceRequest & {
      parentId: string | null;
      beforeId?: string;
      payload: SidebarDropPayload;
    },
  ) => Promise<void>;
  reveal?: (
    request: SourceRequest & { url: string; after?: SidebarSourceItem },
  ) => Promise<SidebarSourceItem | null>;
  /**
   * What the source can do. A module reports it with its pages; Work's
   * lists know it up front.
   */
  capabilities: () => SidebarSourceCapabilities;
}

/** Read every branch a view has loaded again (a list changed somewhere). */
export function invalidateBranches(
  publish: (change: CollectionChange<SidebarSourceItem>) => void,
  branches: readonly (string | null)[],
  options: { quiet?: boolean } = {},
) {
  for (const parentId of branches.length ? branches : [null])
    publish({ type: "invalidate", parentId, ...options });
}

/** What a source exports decides what it can do. */
export function capabilitiesOf(
  source: Pick<SectionSource, "move" | "drop" | "reveal">,
): SidebarSourceCapabilities {
  return {
    move: Boolean(source.move),
    drop: Boolean(source.drop),
    reveal: Boolean(source.reveal),
  };
}

/** One page, cut from rows already in memory. */
export function pageOf<T>(
  rows: readonly T[],
  cursor: string | undefined,
  size = 100,
): CollectionPage<T> {
  const offset = cursor ? Number(cursor) : 0;
  if (!Number.isSafeInteger(offset) || offset < 0)
    throw new Error("Invalid collection cursor");
  return {
    items: rows.slice(offset, offset + size),
    ...(offset + size < rows.length ? { cursor: String(offset + size) } : {}),
  };
}

/** The rows of one parent from a flat list of rows of every parent. */
export function childrenOf(
  rows: readonly SidebarSourceItem[],
  parentId: string | null,
): SidebarSourceItem[] {
  return rows.filter((row) => (row.parentId ?? null) === parentId);
}
