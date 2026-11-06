/**
 * How the detached dock lets clicks on its empty space reach the screen
 * behind it, decided once by the main process and handed to the dock
 * window in its URL (`clicks=`):
 * - `pass-through`: the window ignores clicks where nothing is drawn while
 *   the platform keeps forwarding pointer moves to it (macOS, Windows);
 * - `shape`: the window takes the shape of what it draws (Linux on X11,
 *   which cannot forward moves to a click-through window);
 * - `keep`: neither is available (Wayland), so the dock keeps every click
 *   inside its window.
 */
export type DockClicks = "pass-through" | "shape" | "keep";

export function dockClicksFor(input: {
  platform: string;
  /** The window system is Wayland (Electron's ozone platform). */
  wayland: boolean;
}): DockClicks {
  if (input.platform === "darwin" || input.platform === "win32")
    return "pass-through";
  return input.wayland ? "keep" : "shape";
}

export function parseDockClicks(value: string | null): DockClicks {
  return value === "pass-through" || value === "shape" ? value : "keep";
}
