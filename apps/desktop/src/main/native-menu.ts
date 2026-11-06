import {
  type BrowserWindow,
  Menu,
  type MenuItemConstructorOptions,
} from "electron";
import { isMenuSeparator, type MenuItem } from "../shared/menu.js";

/**
 * A menu's data as an OS menu, for windows with no room to draw one (the
 * detached dock's strip) or no workspace of their own (a sign-in popup).
 */
export function nativeMenuTemplate(
  items: readonly MenuItem[],
  pick: (action: string) => void,
): MenuItemConstructorOptions[] {
  return items.map((item): MenuItemConstructorOptions => {
    if (isMenuSeparator(item)) return { type: "separator" };
    return {
      label: item.detail ? `${item.label}  ${item.detail}` : item.label,
      enabled: !item.disabledReason,
      ...(item.submenu
        ? { submenu: nativeMenuTemplate(item.submenu, pick) }
        : item.checked === undefined
          ? {}
          : {
              type: item.setting ? ("checkbox" as const) : ("radio" as const),
              checked: item.checked,
            }),
      click: () => pick(item.action),
    };
  });
}

/**
 * Shows `items` as an OS menu at the pointer and resolves with the picked
 * action, or null when the menu closed without one.
 */
export function popupNativeMenu(
  window: BrowserWindow,
  items: readonly MenuItem[],
): Promise<string | null> {
  return new Promise((resolve) => {
    let picked: string | null = null;
    Menu.buildFromTemplate(
      nativeMenuTemplate(items, (action) => {
        picked = action;
      }),
    ).popup({
      // At the cursor: window-relative coordinates land off target on a
      // transparent strip, and a right-click puts the cursor here.
      window,
      // Closing fires before click on some platforms; settle after both.
      callback: () => setTimeout(() => resolve(picked), 0),
    });
  });
}
