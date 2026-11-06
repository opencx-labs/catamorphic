export type {
  SidebarDropPayload,
  SidebarSourceItem,
  SidebarSourceModule,
  SidebarSourceRequestContext,
  SidebarSourceSession,
  SidebarSourceWork,
} from "@catamorphic/work-customization";

import type {
  SidebarDropPayload,
  SidebarSourceItem,
  SidebarSourceSession,
} from "@catamorphic/work-customization";
import {
  type OpenMode,
  rowTargetAllowed,
  type SidebarSourceEffect,
  type SidebarSurface,
} from "./sidebar.js";

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
  mode?: OpenMode;
  values?: Record<string, string>;
  beforeId?: string;
  payload?: SidebarDropPayload;
  url?: string;
  after?: SidebarSourceItem;
  surface?: SidebarSurface;
  /** The current chat, independent of visibility. */
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
      mode?: OpenMode;
      values?: Record<string, string>;
    }
  | { op: "call" | "start"; workflow: string; input?: unknown }
  | { op: "poll-run"; runId: string }
  | { op: "state-read"; key: string }
  | {
      op: "state-write";
      key: string;
      value: import("@catamorphic/agent-protocol").JsonValue;
      ifVersion: number;
    }
  | { op: "state-delete"; key: string; ifVersion: number }
  | {
      op: "notify";
      title: string;
      body?: string;
      route?: string;
      idempotencyKey: string;
    }
  | {
      op: "process-start";
      key: string;
      command: string;
      name?: string;
      lifetime: "view" | "application";
    }
  | { op: "process-list" }
  | {
      op: "process-read";
      key: string;
      cursor?: number;
      maxBytes?: number;
      waitMs?: number;
    }
  | { op: "process-stop"; key: string };
