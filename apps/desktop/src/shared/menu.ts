/**
 * Menus as plain data: the app's in-window menus draw them, and a menu
 * built in main (a page's context menu) crosses IPC in the same shape.
 */
export interface MenuEntry {
  label: string;
  action: string;
  danger?: boolean;
  disabledReason?: string;
  /** The entry in force: the pick among several, or a setting that is on. */
  checked?: boolean;
  /** A setting the entry turns on and off, not one pick among several. */
  setting?: boolean;
  /** A quieter note after the label, such as a voice's description. */
  detail?: string;
  /** Opens a nested menu; the entry itself picks nothing. */
  submenu?: readonly MenuItem[];
}

/** A rule between groups of entries. */
export interface MenuSeparator {
  separator: true;
}

export type MenuItem = MenuEntry | MenuSeparator;

export const MENU_SEPARATOR: MenuSeparator = { separator: true };

export function isMenuSeparator(
  item: MenuItem | { separator?: unknown },
): item is MenuSeparator {
  return "separator" in item && item.separator === true;
}

/**
 * Groups joined by one rule each. Empty groups leave no rule behind, so
 * a menu never starts, ends or doubles up on one.
 */
export function menuGroups<T extends MenuEntry>(
  ...groups: readonly (readonly (T | MenuSeparator)[])[]
): (T | MenuSeparator)[] {
  const items: (T | MenuSeparator)[] = [];
  for (const group of groups) {
    const entries = trimSeparators(group);
    if (entries.length === 0) continue;
    if (items.length > 0) items.push(MENU_SEPARATOR);
    items.push(...entries);
  }
  return items;
}

/** Drops rules at either end and rules next to each other. */
function trimSeparators<T extends MenuEntry>(
  items: readonly (T | MenuSeparator)[],
): (T | MenuSeparator)[] {
  const out: (T | MenuSeparator)[] = [];
  for (const item of items) {
    if (isMenuSeparator(item)) {
      const last = out.at(-1);
      if (last && !isMenuSeparator(last)) out.push(item);
    } else out.push(item);
  }
  const last = out.at(-1);
  if (last && isMenuSeparator(last)) out.pop();
  return out;
}

/** A page's context menu, built in main for the window showing the page. */
export interface PageContextMenu {
  /** The page (its WebContents id) the right-click was in. */
  guestId: number;
  menuId: string;
  /** Where the right-click was, in the window's CSS pixels. */
  x: number;
  y: number;
  items: MenuItem[];
}
