import {
  dangerLast,
  isMenuSeparator,
  type MenuSeparator,
  menuGroups,
} from "./menu.js";
import { OPEN_ACTIONS, openModeForAction } from "./open-mode.js";
import {
  isHostAction,
  type OpenMode,
  type SidebarMenuEntry,
} from "./sidebar.js";

/** One opening choice per mode/destination. Explicit entries replace automatic looks. */
export function composeSidebarMenu({
  resource,
  entries = [],
  url,
  defaultMode = "replace",
}: {
  resource: boolean;
  entries: readonly (SidebarMenuEntry | MenuSeparator)[];
  url?: string;
  defaultMode?: OpenMode;
}): (SidebarMenuEntry | MenuSeparator)[] {
  const key = (entry: SidebarMenuEntry) => {
    const mode =
      entry.action === "open" ? defaultMode : openModeForAction(entry.action);
    return mode
      ? JSON.stringify([
          mode,
          entry.url === undefined || entry.url === url ? "row" : entry.url,
        ])
      : isHostAction(entry.action)
        ? JSON.stringify([entry.action, entry.url ?? url ?? "row"])
        : undefined;
  };
  const explicit = new Map<string, SidebarMenuEntry>();
  for (const e of entries)
    if (!isMenuSeparator(e)) {
      const k = key(e);
      if (k) explicit.set(k, e);
    }
  const standard: SidebarMenuEntry[] = resource
    ? OPEN_ACTIONS.map((e) => explicit.get(key(e) ?? "") ?? e)
    : [];
  const seen = new Set(standard.flatMap((e) => key(e) ?? []));
  const remaining = entries.filter((e) => {
    if (isMenuSeparator(e)) return true;
    const k = key(e);
    if (!k) return true;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return menuGroups(standard, dangerLast(remaining));
}
