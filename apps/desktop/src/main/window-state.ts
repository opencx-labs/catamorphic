import fs from "node:fs";
import path from "node:path";
import { type BrowserWindow, screen } from "electron";

/**
 * Window placement that survives a relaunch: size, position, and whether
 * the window was maximized/fullscreen. App-level (`window-state.json` in
 * userData), not per profile — where a window sits is a fact about this
 * machine's screens, not about who's signed in. Saved on every settle of a
 * move/resize (debounced) and on close; restored bounds are validated
 * against the current display set so a laptop unplugged from its monitor
 * doesn't open its window off-screen.
 */
export interface WindowState {
  x?: number;
  y?: number;
  width: number;
  height: number;
  maximized: boolean;
  fullscreen: boolean;
}

export const DEFAULT_WINDOW_STATE: WindowState = {
  width: 1200,
  height: 800,
  maximized: false,
  fullscreen: false,
};

const SAVE_DEBOUNCE_MS = 300;

export function normalizeWindowState(raw: unknown): WindowState {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const num = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const width = num(record.width);
  const height = num(record.height);
  return {
    ...(num(record.x) !== undefined ? { x: num(record.x) } : {}),
    ...(num(record.y) !== undefined ? { y: num(record.y) } : {}),
    width: width && width > 0 ? width : DEFAULT_WINDOW_STATE.width,
    height: height && height > 0 ? height : DEFAULT_WINDOW_STATE.height,
    maximized: record.maximized === true,
    fullscreen: record.fullscreen === true,
  };
}

/**
 * Drop a saved position that no display can show anymore (at least a
 * usable corner of the window must land inside some display's work area);
 * a window with no position lets Electron center it.
 */
export function fitToDisplays(
  state: WindowState,
  displays: Array<{
    workArea: { x: number; y: number; width: number; height: number };
  }>,
): WindowState {
  if (state.x === undefined || state.y === undefined) return state;
  const MIN_VISIBLE = 100;
  const visible = displays.some(({ workArea }) => {
    const overlapX =
      Math.min(state.x! + state.width, workArea.x + workArea.width) -
      Math.max(state.x!, workArea.x);
    const overlapY =
      Math.min(state.y! + state.height, workArea.y + workArea.height) -
      Math.max(state.y!, workArea.y);
    return overlapX >= MIN_VISIBLE && overlapY >= MIN_VISIBLE;
  });
  if (visible) return state;
  const { x: _x, y: _y, ...rest } = state;
  return rest;
}

export class WindowStateStore {
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {}

  load(): WindowState {
    try {
      const state = normalizeWindowState(
        JSON.parse(fs.readFileSync(this.file, "utf-8")),
      );
      return fitToDisplays(state, screen.getAllDisplays());
    } catch {
      return { ...DEFAULT_WINDOW_STATE };
    }
  }

  save(state: WindowState): void {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, `${JSON.stringify(state, null, 2)}\n`);
    } catch {
      // Best-effort: a failed save only costs the next launch's placement.
    }
  }

  /** Read the live window into a state, keeping the last normal bounds
   * when it's maximized/fullscreen (so un-maximizing after a relaunch
   * lands where it used to). */
  capture(window: BrowserWindow, previous: WindowState): WindowState {
    const maximized = window.isMaximized();
    const fullscreen = window.isFullScreen();
    if (maximized || fullscreen) {
      return { ...previous, maximized, fullscreen };
    }
    const bounds = window.getBounds();
    return { ...bounds, maximized: false, fullscreen: false };
  }

  /** Follow a window for its lifetime, persisting placement as it settles. */
  track(window: BrowserWindow, initial: WindowState): void {
    let last = initial;
    const update = () => {
      if (window.isDestroyed()) return;
      last = this.capture(window, last);
    };
    const scheduleSave = () => {
      update();
      if (this.debounce) clearTimeout(this.debounce);
      this.debounce = setTimeout(() => this.save(last), SAVE_DEBOUNCE_MS);
    };
    for (const event of [
      "resize",
      "move",
      "maximize",
      "unmaximize",
      "enter-full-screen",
      "leave-full-screen",
    ] as const) {
      window.on(event as "resize", scheduleSave);
    }
    // Close is the one moment that must not be debounced away.
    window.on("close", () => {
      if (this.debounce) clearTimeout(this.debounce);
      update();
      this.save(last);
    });
  }
}
