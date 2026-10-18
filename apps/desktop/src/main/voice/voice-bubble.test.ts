import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DockSpot } from "../../shared/dock-position.js";
import {
  voiceBubbleRest,
  voiceSpotsLayout,
} from "../../shared/voice-bubble.js";

const hoisted = vi.hoisted(async () => {
  // A display 1000 wide under a 25 high menu bar.
  const workArea = { x: 0, y: 25, width: 1000, height: 775 };
  const { EventEmitter } = await import("node:events");
  /** A window that records what it was asked to do. */
  class FakeWindow extends EventEmitter {
    static all: FakeWindow[] = [];
    bounds = { x: 0, y: 0, width: 64, height: 64 };
    visible = false;
    destroyed = false;
    excludedFromShownWindowsMenu = false;
    /** setBounds calls, with whether they glide. */
    landings: { x: number; y: number; animate: boolean }[] = [];
    sent: { channel: string; value: unknown }[] = [];
    webContents = {
      send: (channel: string, value: unknown) =>
        this.sent.push({ channel, value }),
    };
    constructor(readonly options: Record<string, unknown>) {
      super();
      FakeWindow.all.push(this);
    }
    setAlwaysOnTop() {}
    setIgnoreMouseEvents() {}
    setVisibleOnAllWorkspaces() {}
    async loadURL() {}
    async loadFile() {}
    isDestroyed() {
      return this.destroyed;
    }
    isVisible() {
      return this.visible;
    }
    getBounds() {
      return { ...this.bounds };
    }
    setBounds(
      bounds: { x: number; y: number; width?: number; height?: number },
      animate = false,
    ) {
      this.bounds = { ...this.bounds, ...bounds };
      this.landings.push({ x: bounds.x, y: bounds.y, animate });
    }
    setPosition(x: number, y: number) {
      this.bounds = { ...this.bounds, x, y };
    }
    showInactive() {
      this.visible = true;
    }
    hide() {
      this.visible = false;
    }
    moveTop() {}
    destroy() {
      this.destroyed = true;
      this.emit("closed");
    }
    /** What its page was told last on a channel. */
    last(channel: string) {
      return this.sent.filter((sent) => sent.channel === channel).at(-1)?.value;
    }
  }
  return { FakeWindow, workArea };
});

vi.mock("electron", async () => {
  const { FakeWindow, workArea } = await hoisted;
  return {
    BrowserWindow: FakeWindow,
    systemPreferences: {
      getAnimationSettings: () => ({ prefersReducedMotion: false }),
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 500, y: 400 }),
      getDisplayNearestPoint: () => ({ workArea }),
      getDisplayMatching: () => ({ workArea }),
    },
  };
});

const fake = await hoisted;

const { createVoiceBubble } = await import("./voice-bubble.js");

const rest = voiceBubbleRest(fake.workArea);
const layout = voiceSpotsLayout(fake.workArea);

describe("createVoiceBubble", () => {
  let spots: Record<string, DockSpot>;
  let saved: [string, DockSpot][];
  /** The profiles the bubble's pages were told to read, in turn. */
  let reads: string[];
  let bubble: ReturnType<typeof createVoiceBubble>;

  beforeEach(() => {
    vi.useFakeTimers();
    fake.FakeWindow.all = [];
    spots = { a: "left", b: "right" };
    saved = [];
    reads = [];
    bubble = createVoiceBubble({
      attach: (_contents, profileId) => reads.push(profileId),
      spotOf: (profileId) => spots[profileId] ?? "center",
      saveSpot: (profileId, spot) => {
        spots[profileId] = spot;
        saved.push([profileId, spot]);
      },
    });
  });

  afterEach(() => {
    bubble.dispose();
    vi.useRealTimers();
  });

  /** Shows profile a's bubble, its page ready; its spots' window too. */
  const shown = () => {
    bubble.show({ profileId: "a", projectId: "p" });
    const [window] = fake.FakeWindow.all;
    if (!window) throw new Error("no bubble window");
    window.emit("ready-to-show");
    const spotsWindow = fake.FakeWindow.all[1];
    if (!spotsWindow) throw new Error("no spots window");
    spotsWindow.emit("ready-to-show");
    return { window, spotsWindow };
  };

  it("comes up at the spot its profile rests at, its spots ready in its profile", () => {
    const { window, spotsWindow } = shown();
    expect(window.visible).toBe(true);
    expect(window.bounds).toMatchObject({ x: rest.x.left, y: rest.y });
    expect(spotsWindow.visible).toBe(false);
    // The bubble's page, then the spots' page as it loads.
    expect(reads).toEqual(["a", "a"]);
  });

  it("follows a drag, shows where it can rest, and glides to where it lands", () => {
    const { window, spotsWindow } = shown();
    const startX = rest.x.left + 32;
    bubble.drag({ phase: "start", screenX: startX, reducedMotion: false });
    expect(spotsWindow.visible).toBe(true);
    expect(spotsWindow.bounds).toMatchObject(layout.bounds);
    expect(spotsWindow.last("catamorphic:voice-bubble-spots")).toMatchObject({
      shown: true,
      target: "left",
      slots: layout.slots,
      profileId: "a",
      projectId: "p",
    });

    // Past the right spot: held there, headed right.
    bubble.drag({
      phase: "move",
      screenX: startX + 2000,
      reducedMotion: false,
    });
    expect(window.bounds).toMatchObject({ x: rest.x.right, y: rest.y });
    expect(spotsWindow.last("catamorphic:voice-bubble-spots")).toMatchObject({
      target: "right",
    });

    // Let go nearer the right than the middle: the right.
    const towardRight = rest.x.center + 0.6 * (rest.x.right - rest.x.center);
    bubble.drag({
      phase: "end",
      screenX: startX + towardRight - rest.x.left,
      reducedMotion: false,
    });
    expect(window.landings.at(-1)).toEqual({
      x: rest.x.right,
      y: rest.y,
      animate: true,
    });
    expect(saved).toEqual([["a", "right"]]);
    // The spot it landed on stays lit as the spots ease out.
    expect(spotsWindow.last("catamorphic:voice-bubble-spots")).toMatchObject({
      shown: false,
      target: "right",
    });
    vi.advanceTimersByTime(200);
    expect(spotsWindow.visible).toBe(false);
  });

  it("goes back where it was when a drag is called off, unsaved", () => {
    const { window } = shown();
    bubble.drag({ phase: "start", screenX: 60, reducedMotion: false });
    bubble.drag({ phase: "move", screenX: 600, reducedMotion: false });
    bubble.drag({ phase: "cancel", screenX: 0, reducedMotion: false });
    expect(window.landings.at(-1)).toEqual({
      x: rest.x.left,
      y: rest.y,
      animate: true,
    });
    expect(saved).toEqual([]);
  });

  it("lands at once when motion is reduced", () => {
    const { window } = shown();
    bubble.drag({ phase: "start", screenX: 60, reducedMotion: true });
    bubble.drag({ phase: "end", screenX: 560, reducedMotion: true });
    expect(window.landings.at(-1)).toEqual({
      x: rest.x.center,
      y: rest.y,
      animate: false,
    });
  });

  it("glides to a spot edited elsewhere, and stays put for another profile", () => {
    const { window } = shown();
    spots.a = "center";
    bubble.prefsChanged("a");
    expect(window.landings.at(-1)).toEqual({
      x: rest.x.center,
      y: rest.y,
      animate: true,
    });
    const landed = window.landings.length;
    // Profile b rests on the right; moving to its assistant keeps the
    // bubble where the person sees it.
    bubble.show({ profileId: "b", projectId: "q" });
    bubble.prefsChanged("b");
    expect(window.landings).toHaveLength(landed);
    expect(window.bounds.x).toBe(rest.x.center);
  });

  it("keeps where it landed when its spot cannot be saved", () => {
    const failing = createVoiceBubble({
      attach: () => {},
      spotOf: () => "left",
      saveSpot: () => {
        throw new Error("prefs.json is not valid");
      },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      failing.show({ profileId: "a", projectId: "p" });
      const window = fake.FakeWindow.all.at(-1);
      if (!window) throw new Error("no bubble window");
      window.emit("ready-to-show");
      failing.drag({ phase: "start", screenX: 60, reducedMotion: false });
      failing.drag({ phase: "end", screenX: 560, reducedMotion: false });
      failing.prefsChanged("a");
      expect(window.bounds.x).toBe(rest.x.center);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
      failing.dispose();
    }
  });

  it("ends a drag when it goes, back at its spot, and ignores moves after", () => {
    const { window, spotsWindow } = shown();
    bubble.drag({ phase: "start", screenX: 60, reducedMotion: false });
    bubble.drag({ phase: "move", screenX: 400, reducedMotion: false });
    bubble.show(null);
    expect(window.bounds.x).toBe(rest.x.left);
    bubble.drag({ phase: "move", screenX: 900, reducedMotion: false });
    expect(window.bounds.x).toBe(rest.x.left);
    vi.advanceTimersByTime(200);
    expect(window.visible).toBe(false);
    expect(spotsWindow.visible).toBe(false);
  });
});
