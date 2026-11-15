import { orderedTabKeys, type Workspace } from "./workspace-state.js";

/**
 * The shown tabs by how recently the person looked at them: the one in
 * front, then the ones they left, newest first, then tabs never visited in
 * strip order.
 */
export function recentTabOrder(ws: Workspace): string[] {
  const shown = orderedTabKeys(ws);
  const open = new Set(shown);
  const front =
    ws.activeTabKey && open.has(ws.activeTabKey) ? [ws.activeTabKey] : [];
  const left = ws.recentTabKeys
    .filter((key) => open.has(key) && key !== ws.activeTabKey)
    .reverse();
  const seen = new Set([...front, ...left]);
  return [...front, ...left, ...shown.filter((key) => !seen.has(key))];
}

/**
 * One pass through the tabs by recency while the shortcut's modifier stays
 * down. The order is fixed when the pass starts: the tabs it goes through on
 * the way do not count as visits until it settles.
 */
export interface TabWalk {
  order: string[];
  /** The tab in front; -1 when the pass started with none. */
  index: number;
}

/** The pass after one more step, or null when there is no other tab. */
export function stepTabWalk({
  ws,
  walk,
  direction,
}: {
  ws: Workspace;
  walk: TabWalk | null;
  direction: -1 | 1;
}): TabWalk | null {
  const open = new Set(orderedTabKeys(ws));
  const current = walk?.order[walk.index];
  // Tabs closed since the pass started drop out of it.
  const kept = walk?.order.filter((key) => open.has(key)) ?? [];
  const started: TabWalk =
    current !== undefined && open.has(current)
      ? { order: kept, index: kept.indexOf(current) }
      : {
          order: recentTabOrder(ws),
          index: ws.activeTabKey && open.has(ws.activeTabKey) ? 0 : -1,
        };
  const count = started.order.length;
  if (count === 0 || (count === 1 && started.index === 0)) return null;
  const index =
    started.index === -1
      ? direction === 1
        ? 0
        : count - 1
      : (started.index + direction + count) % count;
  return { order: started.order, index };
}

/**
 * The pass is over: the tab it ended on is the newest, and the others keep
 * the order they had when it started.
 */
export function settledTabWalk(ws: Workspace, walk: TabWalk): Workspace {
  const front = walk.order[walk.index];
  if (front === undefined || front !== ws.activeTabKey) return ws;
  const walked = new Set(walk.order);
  const recentTabKeys = [
    ...ws.recentTabKeys.filter((key) => !walked.has(key)),
    ...walk.order.filter((key) => key !== front).reverse(),
  ];
  return recentTabKeys.length === ws.recentTabKeys.length &&
    recentTabKeys.every((key, at) => key === ws.recentTabKeys[at])
    ? ws
    : { ...ws, recentTabKeys };
}

/** The modifiers a shortcut was pressed with that can be held for a pass. */
export interface HeldModifiers {
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
}

export const holdsModifier = (keys: HeldModifiers): boolean =>
  keys.metaKey || keys.ctrlKey || keys.altKey;

/** Whether every modifier the pass started with is still down. */
export const stillHeld = (held: HeldModifiers, now: HeldModifiers): boolean =>
  (!held.metaKey || now.metaKey) &&
  (!held.ctrlKey || now.ctrlKey) &&
  (!held.altKey || now.altKey);
