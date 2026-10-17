import path from "node:path";
import {
  BrowserWindow,
  screen,
  systemPreferences,
  type WebContents,
} from "electron";
import { z } from "zod";
import type { DockSpot } from "../../shared/dock-position.js";
import type { VoiceBubbleState } from "../../shared/voice.js";
import {
  VOICE_BUBBLE_SIZE as SIZE,
  type VoiceBubbleDrag,
  type VoiceBubbleRest,
  type VoiceSpotsState,
  voiceBubbleDragAt,
  voiceBubbleRest,
  voiceSpotsLayout,
} from "../../shared/voice-bubble.js";

/** How long the bubble takes to go: its page's exit, then the window. */
const LEAVE_MS = 200;

/** The bubble's page moving it, as it arrives over IPC. */
export const voiceBubbleDragSchema = z.object({
  phase: z.enum(["start", "move", "end", "cancel"]),
  screenX: z.number(),
  reducedMotion: z.boolean(),
}) satisfies z.ZodType<VoiceBubbleDrag>;

/** Whose bubble it is: the profile its page reads, the project it wears. */
export interface BubblePlace {
  profileId: string;
  projectId: string | null;
}

/** The bubble's two pages: the microphone, and its resting spots. */
export type BubblePage = "bubble" | "spots";

/**
 * Voice's bubble (ADR 0236): while voice is on and Work is not in front,
 * the dock's microphone floats at the bottom of the screen the pointer is
 * on, left, in the middle or right, wherever the person dragged it last,
 * the same button with the same menu, so voice can be seen and stopped
 * from any app. The bubble never takes focus: dictation goes on into the
 * app in front. It comes and goes with its page's motion: the window hides
 * only once the page has eased out, and showing it again on the way out
 * turns it back. Dragged, the window follows the pointer along the bottom
 * of its screen while a second window, which never takes a click, shows
 * where it can rest, the one it would land on lit; let go, it glides
 * there, as the detached dock does.
 */
export function createVoiceBubble(options: {
  /** The bubble's pages read the settings of this profile from now. */
  attach(contents: WebContents, profileId: string): void;
  /** Where a profile's bubble rests. */
  spotOf(profileId: string): DockSpot;
  /** The person dragged a profile's bubble to rest there. */
  saveSpot(profileId: string, spot: DockSpot): void;
}): {
  /** Shows the bubble for a profile and project, or takes it away (null). */
  show(place: BubblePlace | null): void;
  /** What the bubble's page shows now, for the page as it starts. */
  state(): VoiceBubbleState;
  /** What the spots' page shows now, for the page as it starts. */
  spotsState(): VoiceSpotsState;
  /** The bubble's page moves it along the bottom of its screen. */
  drag(input: VoiceBubbleDrag): void;
  /**
   * A profile's settings changed: its bubble glides to a spot edited
   * elsewhere (Settings, the profile's file).
   */
  prefsChanged(profileId: string): void;
  /** Which of the bubble's pages this is, if either. */
  pageOf(contents: WebContents): BubblePage | null;
  /** One of the bubble's windows, never a workspace. */
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
  /** The spot it rests at, or is gliding to. */
  let resting: DockSpot = "center";
  /** The attached profile's spot as last read: a change is an edit. */
  let known: DockSpot | null = null;
  /** A drag under way: where it began, and where it would land. */
  let drag: {
    x: number;
    left: number;
    rest: VoiceBubbleRest;
    target: DockSpot;
  } | null = null;
  // The resting spots' window: made once the bubble's first shows, so they
  // show from the first drag, and kept, hidden, for the rest of the
  // session (a second page, for a drag the person rarely makes, but one
  // that never waits on a page to load).
  let spots: BrowserWindow | null = null;
  let spotsReady = false;
  let spotsAttached: string | null = null;
  let spotsShown = false;
  let spotsLayout: Pick<VoiceSpotsState, "top" | "slots"> = {
    top: 0,
    slots: [],
  };
  let spotsLeaving: ReturnType<typeof setTimeout> | undefined;

  // Shown once its window is on screen, so the page eases in where it is
  // seen.
  const state = (): VoiceBubbleState => ({
    shown: wanted !== null && !!window && window.isVisible(),
    profileId: attached,
    projectId: worn?.projectId ?? null,
  });

  const spotsState = (): VoiceSpotsState => ({
    shown: spotsShown,
    // Let go, the spot it lands on stays lit as the spots ease out.
    target: drag?.target ?? resting,
    ...spotsLayout,
    profileId: spotsAttached,
    projectId: worn?.projectId ?? null,
  });

  const tell = () => {
    if (window && !window.isDestroyed())
      window.webContents.send("catamorphic:voice-bubble", state());
  };

  const tellSpots = () => {
    if (spots && !spots.isDestroyed())
      spots.webContents.send("catamorphic:voice-bubble-spots", spotsState());
  };

  const attach = (target: BrowserWindow, profileId: string) => {
    if (attached === profileId) return;
    attached = profileId;
    known = options.spotOf(profileId);
    options.attach(target.webContents, profileId);
  };

  const floating = (next: BrowserWindow) => {
    // Not `visibleOnFullScreen`: Electron implements that by turning the
    // whole app into a UIElement, which drops Work from the Dock and the
    // app switcher.
    if (process.platform === "linux")
      next.setVisibleOnAllWorkspaces(true, { skipTransformProcessType: true });
    if (process.platform === "darwin") next.excludedFromShownWindowsMenu = true;
  };

  const load = (next: BrowserWindow, surface: string) => {
    const url = process.env.ELECTRON_RENDERER_URL;
    void (
      url
        ? next.loadURL(`${url}/?surface=${surface}`)
        : next.loadFile(
            path.join(import.meta.dirname, "../renderer/index.html"),
            { query: { surface } },
          )
    ).catch(() => {});
  };

  // A panel on macOS: over full-screen apps and on every Space, and a
  // click on it never brings Work forward.
  const panel = (size: { width: number; height: number }) =>
    new BrowserWindow({
      ...(process.platform === "darwin" ? { type: "panel" } : {}),
      ...size,
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

  /** The spots' page reads the profile the bubble's does. */
  const attachSpots = () => {
    if (!spots || spots.isDestroyed() || !attached) return;
    if (spotsAttached === attached) return;
    spotsAttached = attached;
    options.attach(spots.webContents, attached);
  };

  const openSpots = () => {
    const next = panel({ width: SIZE, height: SIZE });
    // Under the bubble, and never in the way of a click.
    next.setAlwaysOnTop(true, "floating");
    next.setIgnoreMouseEvents(true);
    floating(next);
    next.once("ready-to-show", () => {
      if (spots !== next) return;
      spotsReady = true;
      if (drag) showSpots();
    });
    next.on("closed", () => {
      if (spots !== next) return;
      spots = null;
      spotsReady = false;
      spotsAttached = null;
    });
    spots = next;
    attachSpots();
    load(next, "bubble-spots");
  };

  const open = (first: BubblePlace) => {
    const next = panel({ width: SIZE, height: SIZE });
    // Above its resting spots while dragged.
    next.setAlwaysOnTop(true, "floating", 1);
    floating(next);
    next.once("ready-to-show", () => {
      if (window !== next) return;
      if (wanted) {
        place(next);
        tell();
      }
      if (!spots) openSpots();
    });
    next.on("closed", () => {
      if (window !== next) return;
      window = null;
      attached = null;
      known = null;
      drag = null;
      hideSpots();
    });
    window = next;
    attach(next, first.profileId);
    load(next, "voice");
  };

  /** At its spot on the screen the pointer is on, coming up. */
  const place = (target: BrowserWindow) => {
    const rest = voiceBubbleRest(
      screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea,
    );
    resting = attached ? options.spotOf(attached) : "center";
    known = attached ? resting : null;
    target.setBounds({
      x: rest.x[resting],
      y: rest.y,
      width: SIZE,
      height: SIZE,
    });
    target.showInactive();
  };

  /** To a spot on its screen, gliding unless motion is reduced. */
  const glide = (target: BrowserWindow, spot: DockSpot, animate: boolean) => {
    const rest = voiceBubbleRest(
      screen.getDisplayMatching(target.getBounds()).workArea,
    );
    resting = spot;
    target.setBounds(
      { x: rest.x[spot], y: rest.y, width: SIZE, height: SIZE },
      animate,
    );
  };

  const showSpots = () => {
    if (!spots || spots.isDestroyed() || !spotsReady || !drag) return;
    clearTimeout(spotsLeaving);
    spotsLeaving = undefined;
    attachSpots();
    const layout = voiceSpotsLayout(
      screen.getDisplayMatching(window?.getBounds() ?? spots.getBounds())
        .workArea,
    );
    spotsLayout = { top: layout.top, slots: layout.slots };
    spots.setBounds(layout.bounds);
    spotsShown = true;
    tellSpots();
    spots.showInactive();
    // Elsewhere the latest shown is on top.
    if (process.platform !== "darwin") window?.moveTop();
  };

  /** The spots ease out with the landing; then their window goes. */
  const hideSpots = () => {
    if (!spotsShown) return;
    spotsShown = false;
    tellSpots();
    clearTimeout(spotsLeaving);
    spotsLeaving = setTimeout(() => {
      spotsLeaving = undefined;
      if (!spotsShown && spots && !spots.isDestroyed()) spots.hide();
    }, LEAVE_MS);
  };

  return {
    show(next) {
      if (!next) {
        if (!wanted) return;
        wanted = null;
        // Going mid-drag, it is back at its spot: shown again before its
        // window hides, it is where it rests.
        if (drag && window && !window.isDestroyed())
          glide(window, resting, false);
        drag = null;
        hideSpots();
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
    spotsState,
    drag(input) {
      const target = window;
      if (!target || target.isDestroyed() || !target.isVisible() || !wanted)
        return;
      if (input.phase === "start") {
        const bounds = target.getBounds();
        drag = {
          x: input.screenX,
          left: bounds.x,
          rest: voiceBubbleRest(screen.getDisplayMatching(bounds).workArea),
          target: resting,
        };
        showSpots();
        return;
      }
      if (!drag) return;
      const at = voiceBubbleDragAt({
        rest: drag.rest,
        from: resting,
        left: drag.left + input.screenX - drag.x,
      });
      if (input.phase === "move") {
        target.setPosition(at.x, drag.rest.y);
        if (at.target !== drag.target) {
          drag.target = at.target;
          tellSpots();
        }
        return;
      }
      // Let go, it lands where it was headed; called off, it goes back.
      const spot = input.phase === "end" ? at.target : resting;
      drag = null;
      glide(target, spot, !input.reducedMotion);
      hideSpots();
      if (input.phase === "end" && attached) {
        try {
          options.saveSpot(attached, spot);
          known = spot;
        } catch (cause) {
          // It stays where it landed; its profile keeps the spot it had.
          console.warn("[voice] saving the bubble's spot failed:", cause);
        }
      }
    },
    prefsChanged(profileId) {
      if (profileId !== attached || !window || window.isDestroyed()) return;
      const spot = options.spotOf(profileId);
      if (spot === known) return;
      known = spot;
      // Moving to another profile's assistant reads its spot but keeps the
      // bubble where it is; only an edit moves it.
      if (!drag && wanted && window.isVisible() && spot !== resting)
        glide(
          window,
          spot,
          !systemPreferences.getAnimationSettings().prefersReducedMotion,
        );
    },
    pageOf: (contents) =>
      window && !window.isDestroyed() && contents === window.webContents
        ? "bubble"
        : spots && !spots.isDestroyed() && contents === spots.webContents
          ? "spots"
          : null,
    owns: (candidate) => candidate === window || candidate === spots,
    dispose() {
      clearTimeout(leaving);
      clearTimeout(spotsLeaving);
      if (window && !window.isDestroyed()) window.destroy();
      if (spots && !spots.isDestroyed()) spots.destroy();
      window = null;
      spots = null;
    },
  };
}
