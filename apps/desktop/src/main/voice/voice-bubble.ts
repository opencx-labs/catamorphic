import path from "node:path";
import { BrowserWindow, screen, type WebContents } from "electron";
import type { VoiceBubbleState } from "../../shared/voice.js";

const SIZE = 64;
/** Above the bottom of the screen, where the dock sits in a window. */
const MARGIN = 28;
/** How long the bubble takes to go: its page's exit, then the window. */
const LEAVE_MS = 200;

/** Whose bubble it is: the profile its page reads, the project it wears. */
export interface BubblePlace {
  profileId: string;
  projectId: string | null;
}

/**
 * Voice's bubble (ADR 0236): while voice is on and Work is not in front,
 * the dock's microphone floats at the bottom of the screen the pointer is
 * on, the same button with the same menu, so voice can be seen and
 * stopped from any app. A detached dock already floats there. The bubble
 * never takes focus: dictation goes on into the app in front. It comes and
 * goes with its page's motion: the window hides only once the page has
 * eased out, and showing it again on the way out turns it back.
 */
export function createVoiceBubble(options: {
  /** The bubble's page reads the settings of this profile from now. */
  attach(contents: WebContents, profileId: string): void;
}): {
  /** Shows the bubble for a profile and project, or takes it away (null). */
  show(place: BubblePlace | null): void;
  /** What the bubble's page shows now, for the page as it starts. */
  state(): VoiceBubbleState;
  /** The bubble's window, never a workspace. */
  owns(window: BrowserWindow): boolean;
  dispose(): void;
} {
  let window: BrowserWindow | null = null;
  /** Where it shows, or null while it is away or going. */
  let wanted: BubblePlace | null = null;
  /** Where it showed last: its colours stay while it goes. */
  let worn: BubblePlace | null = null;
  /** The profile its page reads. */
  let attached: string | null = null;
  let leaving: ReturnType<typeof setTimeout> | undefined;

  // Shown once its window is on screen, so the page eases in where it is
  // seen.
  const state = (): VoiceBubbleState => ({
    shown: wanted !== null && !!window && window.isVisible(),
    profileId: attached,
    projectId: worn?.projectId ?? null,
  });

  const tell = () => {
    if (window && !window.isDestroyed())
      window.webContents.send("catamorphic:voice-bubble", state());
  };

  const attach = (target: BrowserWindow, profileId: string) => {
    if (attached === profileId) return;
    attached = profileId;
    options.attach(target.webContents, profileId);
  };

  const open = (first: BubblePlace) => {
    const next = new BrowserWindow({
      // A panel on macOS: over full-screen apps and on every Space, and a
      // click on it never brings Work forward.
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
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
    // Not `visibleOnFullScreen`: Electron implements that by turning the
    // whole app into a UIElement, which drops Work from the Dock and the
    // app switcher.
    if (process.platform === "linux")
      next.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
    if (process.platform === "darwin") next.excludedFromShownWindowsMenu = true;
    next.once("ready-to-show", () => {
      if (window !== next || !wanted) return;
      place(next);
      tell();
    });
    next.on("closed", () => {
      if (window !== next) return;
      window = null;
      attached = null;
    });
    window = next;
    attach(next, first.profileId);
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
    show(next) {
      if (!next) {
        if (!wanted) return;
        wanted = null;
        if (!window || window.isDestroyed()) return;
        // The page eases out; then the window goes.
        tell();
        clearTimeout(leaving);
        const going = window;
        leaving = setTimeout(() => {
          leaving = undefined;
          if (!wanted && !going.isDestroyed()) going.hide();
        }, LEAVE_MS);
        return;
      }
      const same =
        wanted?.profileId === next.profileId &&
        wanted.projectId === next.projectId;
      if (same && window && !window.isDestroyed()) return;
      clearTimeout(leaving);
      leaving = undefined;
      wanted = next;
      worn = next;
      if (!window || window.isDestroyed()) {
        open(next);
        return;
      }
      attach(window, next.profileId);
      if (!window.isVisible()) place(window);
      tell();
    },
    state,
    owns: (candidate) => candidate === window,
    dispose() {
      clearTimeout(leaving);
      if (window && !window.isDestroyed()) window.destroy();
      window = null;
    },
  };
}
