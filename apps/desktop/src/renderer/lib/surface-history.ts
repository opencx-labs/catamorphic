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
 * back; parts that have since closed are left out, and places with
 * nothing left are skipped. Browser tabs keep their own web history; the
 * host routes back and forward there when the press lands on one.
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

const isOpen = (ws: Workspace, key: string | undefined): key is string =>
  Boolean(key) &&
  (orderedTabKeys(ws, { includeCollapsed: true }).includes(key as string) ||
    ws.chats.some((chat) => chatTabKey(chat.localId) === key));

/** Whether anything of the place is still open in the workspace. */
export function surfaceExists(ws: Workspace, location: SurfaceLocation) {
  return isOpen(ws, location.tab) || isOpen(ws, location.overlay);
}

/** The nearest open place behind (-1) or ahead (1); null at either end. */
export function stepSurface(
  history: SurfaceHistory,
  direction: -1 | 1,
  exists: (location: SurfaceLocation) => boolean,
): SurfaceHistory | null {
  for (
    let index = history.index + direction;
    index >= 0 && index < history.entries.length;
    index += direction
  ) {
    const entry = history.entries[index];
    if (entry && exists(entry)) return { ...history, index };
  }
  return null;
}

/** Puts the user back at a place: its tab, with what floated over it. */
export function restoreSurface(
  ws: Workspace,
  location: SurfaceLocation,
): Workspace {
  const focused = isOpen(ws, location.tab)
    ? transitionWorkspace(ws, { type: "focus", key: location.tab })
    : ws;
  const bare: Workspace = {
    ...focused,
    floatingKey: undefined,
    chats: focused.chats.map((chat) =>
      chat.mode === "partial" ? { ...chat, mode: "min" } : chat,
    ),
  };
  return isOpen(bare, location.overlay)
    ? transitionWorkspace(bare, { type: "float", key: location.overlay })
    : bare;
}
