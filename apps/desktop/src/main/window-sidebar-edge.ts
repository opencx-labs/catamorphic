import { type BrowserWindow, screen } from "electron";

interface Bounds {
  x: number;
  y: number;
  width: number;
  height: number;
}

export type SidebarPointerZone = "edge" | "inside" | "outside";

export function sidebarPointerZone({
  cursor,
  windowBounds,
  contentBounds,
}: {
  cursor: { x: number; y: number };
  windowBounds: Bounds;
  contentBounds: Bounds;
}): SidebarPointerZone {
  if (
    cursor.x < windowBounds.x ||
    cursor.x >= windowBounds.x + windowBounds.width ||
    cursor.y < contentBounds.y ||
    cursor.y >= contentBounds.y + contentBounds.height
  ) {
    return "outside";
  }
  const x = cursor.x - contentBounds.x;
  // Include the native resize border: it does not deliver DOM hover events.
  if (x < 12) return "edge";
  return x < 260 ? "inside" : "outside";
}

/** Webview guests and native resize borders do not reliably forward hover
 * to the shell. Watch only while this window uses collapsed sidebar chrome;
 * no focus changes or input synthesis are involved. Coordinates are in DIP. */
export function watchSidebarEdge(window: BrowserWindow): () => void {
  const timer = setInterval(() => {
    if (window.isDestroyed() || !window.isVisible() || window.isMinimized()) {
      return;
    }
    window.webContents.send(
      "catamorphic:sidebar-pointer-zone",
      sidebarPointerZone({
        cursor: screen.getCursorScreenPoint(),
        windowBounds: window.getBounds(),
        contentBounds: window.getContentBounds(),
      }),
    );
  }, 100);
  timer.unref();
  const stop = () => {
    clearInterval(timer);
    window.removeListener("closed", stop);
  };
  window.once("closed", stop);
  return stop;
}
