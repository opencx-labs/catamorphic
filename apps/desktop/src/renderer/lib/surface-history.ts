import {
  chatTabKey,
  orderedTabKeys,
  transitionWorkspace,
  type Workspace,
} from "./workspace-state.js";

/**
 * Back and forward between surfaces (ADR 0188): the places one project's
 * workspace was at, newest last. A place is the focused tab and whatever
 * floated over it (a chat or a surface): a chat stays open while the user
 * moves between tabs, so either changing is a step. Going back puts both
 * back as clicking there would; parts that have since closed are left
 * out, and places that would change nothing are skipped. Browser tabs
 * keep their own web history; the host routes presses on one there.
 */
export interface SurfaceLocation {
  tab?: string;
  overlay?: string;
}

export interface SurfaceHistory {
  entries: readonly SurfaceLocation[];
  /** The place the user is at now; -1 before the first. */
  index: number;
}

export const EMPTY_SURFACE_HISTORY: SurfaceHistory = { entries: [], index: -1 };

/** Enough to walk back through a working session, not an archive. */
const SURFACE_HISTORY_LIMIT = 50;

const samePlace = (a: SurfaceLocation, b: SurfaceLocation) =>
  a.tab === b.tab && a.overlay === b.overlay;

/** Where the user is in the workspace: the tab, and what floats over it. */
export function surfaceLocation(ws: Workspace): SurfaceLocation | null {
  const chat = ws.chats.find(
    (entry) => entry.localId === ws.activeChatId && entry.mode === "partial",
  );
  const overlay = chat ? chatTabKey(chat.localId) : ws.floatingKey;
  if (!ws.activeTabKey && !overlay) return null;
  return {
    ...(ws.activeTabKey ? { tab: ws.activeTabKey } : {}),
    ...(overlay ? { overlay } : {}),
  };
}

/** Arriving somewhere new drops the places ahead, as a browser does. */
export function visitSurface(
  history: SurfaceHistory,
  location: SurfaceLocation | null,
): SurfaceHistory {
  const current = history.entries[history.index];
  if (!location || (current && samePlace(current, location))) return history;
  const entries = [
    ...history.entries.slice(0, history.index + 1),
    location,
  ].slice(-SURFACE_HISTORY_LIMIT);
  return { entries, index: entries.length - 1 };
}

/**
 * Walking the list is not a visit: the place it arrived at replaces the
 * entry (only part of it may still be open), and nothing ahead is dropped.
 */
export function settleSurface(
  history: SurfaceHistory,
  location: SurfaceLocation | null,
): SurfaceHistory {
  if (!location || history.index < 0) return history;
  const entries = [...history.entries];
  entries[history.index] = location;
  return { ...history, entries };
}

/**
 * Puts the user back at a place, as clicking there would: its tab (a split
 * it belongs to stays), with what floated over it. A part that has since
 * closed, or changed presentation (a chat moved into a tab, or out of
 * one), stays as it is now.
 */
export function restoreSurface(
  ws: Workspace,
  location: SurfaceLocation,
): Workspace {
  const { tab, overlay } = location;
  const focused =
    tab && orderedTabKeys(ws, { includeCollapsed: true }).includes(tab)
      ? transitionWorkspace(ws, { type: "select", key: tab })
      : ws;
  const bare: Workspace = {
    ...focused,
    floatingKey: undefined,
    chats: focused.chats.map((chat) =>
      chat.mode === "partial" ? { ...chat, mode: "min" } : chat,
    ),
  };
  if (!overlay) return bare;
  const chat = overlay.startsWith("chat:")
    ? bare.chats.find((entry) => chatTabKey(entry.localId) === overlay)
    : undefined;
  const floats = overlay.startsWith("chat:")
    ? Boolean(chat && chat.mode !== "tab")
    : orderedTabKeys(bare, { includeCollapsed: true }).includes(overlay);
  return floats
    ? transitionWorkspace(bare, { type: "float", key: overlay })
    : bare;
}

/** Whether going to the place would change anything the user sees. */
export function surfaceChanges(ws: Workspace, location: SurfaceLocation) {
  const now = surfaceLocation(ws);
  const then = surfaceLocation(restoreSurface(ws, location));
  return !(now && then ? samePlace(now, then) : now === then);
}

/** The nearest place behind (-1) or ahead (1) that goes somewhere; null at either end. */
export function stepSurface(
  history: SurfaceHistory,
  direction: -1 | 1,
  goesSomewhere: (location: SurfaceLocation) => boolean,
): SurfaceHistory | null {
  for (
    let index = history.index + direction;
    index >= 0 && index < history.entries.length;
    index += direction
  ) {
    const entry = history.entries[index];
    if (entry && goesSomewhere(entry)) return { ...history, index };
  }
  return null;
}
