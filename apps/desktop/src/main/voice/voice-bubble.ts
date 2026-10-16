import path from "node:path";
import { BrowserWindow, screen, type WebContents } from "electron";

const SIZE = 64;
/** Above the bottom of the screen, where the dock sits in a window. */
const MARGIN = 28;

/**
 * Voice's bubble (ADR 0236): while voice is on and Work is not in front,
 * the dock's microphone floats at the bottom of the screen the pointer is
 * on, the same button with the same menu, so voice can be seen and
 * stopped from any app. A detached dock already floats there. The bubble
 * never takes focus: dictation goes on into the app in front.
 */
export function createVoiceBubble(options: {
  /** The bubble reads the settings of the profile voice belongs to. */
  attach(contents: WebContents): void;
  /** A new bubble window, which reads no profile yet. */
  created(): void;
}): {
  show(shown: boolean): void;
  /** The bubble's window, never a workspace. */
  owns(window: BrowserWindow): boolean;
  dispose(): void;
} {
  let window: BrowserWindow | null = null;
  let wanted = false;

  const open = () => {
    const next = new BrowserWindow({
      width: SIZE,
      height: SIZE,
      show: false,
      frame: false,
      transparent: true,
      resizable: false,
      focusable: false,
      skipTaskbar: true,
      hasShadow: false,
      roundedCorners: false,
      alwaysOnTop: true,
      backgroundColor: "#00000000",
      webPreferences: {
        preload: path.join(import.meta.dirname, "../preload/index.cjs"),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    next.setAlwaysOnTop(true, "floating");
    next.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
    if (process.platform === "darwin") next.excludedFromShownWindowsMenu = true;
    next.once("ready-to-show", () => {
      if (window === next && wanted) place(next);
    });
    next.on("closed", () => {
      if (window === next) window = null;
    });
    window = next;
    options.created();
    options.attach(next.webContents);
    const url = process.env.ELECTRON_RENDERER_URL;
    void (
      url
        ? next.loadURL(`${url}/?surface=voice`)
        : next.loadFile(
            path.join(import.meta.dirname, "../renderer/index.html"),
            { query: { surface: "voice" } },
          )
    ).catch(() => {});
  };

  const place = (target: BrowserWindow) => {
    const { workArea } = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    target.setBounds({
      x: Math.round(workArea.x + (workArea.width - SIZE) / 2),
      y: Math.round(workArea.y + workArea.height - SIZE - MARGIN),
      width: SIZE,
      height: SIZE,
    });
    target.showInactive();
  };

  return {
    show(shown) {
      if (shown === wanted) return;
      wanted = shown;
      if (!shown) {
        if (window && !window.isDestroyed()) window.hide();
        return;
      }
      if (!window || window.isDestroyed()) open();
      else {
        options.attach(window.webContents);
        place(window);
      }
    },
    owns: (candidate) => candidate === window,
    dispose() {
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
