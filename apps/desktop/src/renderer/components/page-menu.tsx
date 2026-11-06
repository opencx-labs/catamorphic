import { type RefObject, useEffect, useRef, useState } from "react";
import type { PageContextMenu } from "../../shared/menu.js";
import { desktopApi } from "../lib/desktop-api.js";
import { type MenuAt, MenuPortal } from "./menu.js";

/** The page element a menu belongs to: a `<webview>`. */
interface MenuGuest extends Element {
  getWebContentsId: () => number;
  focus: () => void;
}

/**
 * A web page's context menu (ADR 0221). Main reads the right-click (a
 * link, an email address, an image, selected text, a text field, the page)
 * and builds the entries; the page's own screen draws them where the click
 * was, like every other menu of the app, and hands the pick back to main.
 * Leaving the menu, or picking from it, gives the page its focus back.
 */
export function PageMenu({
  guest,
  visible,
}: {
  guest: RefObject<MenuGuest | null>;
  /** The page is on screen; a menu leaves with a page that goes. */
  visible: boolean;
}) {
  const [shown, setShown] = useState<{
    menu: PageContextMenu;
    at: MenuAt;
    open: boolean;
  } | null>(null);
  const answered = useRef(false);

  useEffect(
    () =>
      desktopApi.onBrowserContextMenu((menu) => {
        const view = guest.current;
        let own = false;
        try {
          own = view?.getWebContentsId() === menu.guestId;
        } catch {
          // The guest is not attached; the menu is another page's.
        }
        if (!view || !own) return;
        answered.current = false;
        setShown({
          menu,
          at: { pointer: { x: menu.x, y: menu.y } },
          open: true,
        });
      }),
    [guest],
  );

  const close = (action: string | null, { refocus = true } = {}) => {
    if (!shown || answered.current) return;
    answered.current = true;
    setShown((current) => current && { ...current, open: false });
    // Before the pick reaches main: Paste and the other edits act on the
    // page's focused field, so the page has its focus back first.
    if (refocus)
      try {
        guest.current?.focus();
      } catch {
        // The page went away with its menu.
      }
    void desktopApi
      .browserContextMenuPick({ menuId: shown.menu.menuId, action })
      .catch(() => {});
  };
  const closeRef = useRef(close);
  closeRef.current = close;
  // A tab switched away from by key takes its menu with it.
  const orphaned = Boolean(shown?.open) && !visible;
  useEffect(() => {
    if (orphaned) closeRef.current(null, { refocus: false });
  }, [orphaned]);

  if (!shown) return null;
  return (
    <MenuPortal
      open={shown.open}
      at={shown.at}
      anchor={guest}
      label="Page"
      entries={shown.menu.items}
      onPick={(entry) => close(entry.action)}
      onDismiss={() => close(null)}
      onExited={() => setShown(null)}
    />
  );
}
