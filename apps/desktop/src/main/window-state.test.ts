import { EventEmitter } from "node:events";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CASCADE_STEP,
  cascadeWindowState,
  fitToDisplays,
  freshWindowState,
  normalizeWindowSession,
  WindowStateStore,
} from "./window-state.js";

const workArea = { x: 0, y: 25, width: 1440, height: 875 };

describe("cascadeWindowState", () => {
  it("opens a step down and to the right, at the same size", () => {
    expect(
      cascadeWindowState({ x: 100, y: 80, width: 1000, height: 700 }, workArea),
    ).toEqual({
      x: 100 + CASCADE_STEP,
      y: 80 + CASCADE_STEP,
      width: 1000,
      height: 700,
      maximized: false,
      fullscreen: false,
    });
  });

  it("starts again from the work area's corner when a step would leave it", () => {
    expect(
      cascadeWindowState({ x: 0, y: 25, width: 1440, height: 875 }, workArea),
    ).toMatchObject({ x: 0, y: 25, width: 1440, height: 875 });
    expect(
      cascadeWindowState(
        { x: 400, y: 200, width: 1000, height: 600 },
        workArea,
      ),
    ).toMatchObject({ x: 424, y: 224 });
    expect(
      cascadeWindowState(
        { x: 430, y: 200, width: 1000, height: 600 },
        workArea,
      ),
    ).toMatchObject({ x: 0, y: 25 });
  });

  it("never opens larger than the work area", () => {
    expect(
      cascadeWindowState({ x: 0, y: 0, width: 3000, height: 2000 }, workArea),
    ).toMatchObject({ width: 1440, height: 875 });
  });
});

class StateTestWindow extends EventEmitter {
  bounds = { x: 40, y: 60, width: 1000, height: 650 };
  visible = true;
  minimized = false;
  maximized = false;
  fullscreen = false;
  destroyed = false;
  getNormalBounds() {
    return this.bounds;
  }
  isVisible() {
    return this.visible;
  }
  isMinimized() {
    return this.minimized;
  }
  isMaximized() {
    return this.maximized;
  }
  isFullScreen() {
    return this.fullscreen;
  }
  isDestroyed() {
    return this.destroyed;
  }
}

const temporaryDirectories: string[] = [];
afterEach(() => {
  vi.useRealTimers();
  for (const directory of temporaryDirectories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});
const storeFile = () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "work-window-state-"),
  );
  temporaryDirectories.push(directory);
  return path.join(directory, "window-state.json");
};
const stateFor = (profileId: string, projectId?: string) =>
  freshWindowState({
    profileId,
    projectId,
    state: {
      x: 40,
      y: 60,
      width: 1000,
      height: 650,
      maximized: false,
      fullscreen: false,
    },
  });

describe("workspace window restoration", () => {
  it("preserves window groups, profiles, normal bounds, native modes and focus together", () => {
    vi.useFakeTimers();
    const store = new WindowStateStore<StateTestWindow>(storeFile());
    const first = new StateTestWindow();
    const second = new StateTestWindow();
    const firstState = stateFor("personal", "notes");
    const secondState = stateFor("team", "client");
    const firstProjects = ["notes", "research"];
    store.track({
      window: first,
      initial: firstState,
      workspace: () => ({
        profileId: "personal",
        projectIds: firstProjects,
        activeProjectId: "research",
      }),
    });
    store.track({
      window: second,
      initial: secondState,
      workspace: () => ({
        profileId: "team",
        projectIds: ["client"],
        activeProjectId: "client",
      }),
    });
    first.bounds = { x: -1200, y: 40, width: 920, height: 720 };
    first.maximized = true;
    second.fullscreen = true;
    second.emit("focus");
    first.emit("resize");
    second.visible = false;
    second.emit("hide");
    vi.advanceTimersByTime(300);
    expect(store.load()).toEqual({
      windows: [
        {
          ...firstState,
          projectIds: firstProjects,
          activeProjectId: "research",
          state: { ...first.bounds, maximized: true, fullscreen: false },
        },
        {
          ...secondState,
          visible: false,
          state: { ...second.bounds, maximized: false, fullscreen: true },
        },
      ],
      lastFocusedWindowId: secondState.id,
    });
    expect(
      fitToDisplays(store.load().windows[0]!.state, [{ workArea }]),
    ).not.toHaveProperty("x");
  });

  it("keeps the pre-quit set when windows close, hide or change focus during teardown", () => {
    const store = new WindowStateStore<StateTestWindow>(storeFile());
    const first = new StateTestWindow();
    const second = new StateTestWindow();
    for (const [window, profileId, projectId] of [
      [first, "one", "notes"],
      [second, "two", "work"],
    ] as const)
      store.track({
        window,
        initial: stateFor(profileId, projectId),
        workspace: () => ({
          profileId,
          projectIds: [projectId],
          activeProjectId: projectId,
        }),
      });
    first.emit("focus");
    store.freeze();
    const saved = fs.readFileSync(store.file, "utf8");
    first.visible = false;
    first.emit("hide");
    second.emit("focus");
    second.destroyed = true;
    second.emit("closed");
    first.destroyed = true;
    first.emit("closed");
    store.freeze();
    expect(fs.readFileSync(store.file, "utf8")).toBe(saved);
    expect(store.load().windows).toHaveLength(2);
  });

  it("resumes saving after an aborted restart and freezes the latest state on retry", () => {
    vi.useFakeTimers();
    const store = new WindowStateStore<StateTestWindow>(storeFile());
    const window = new StateTestWindow();
    store.track({
      window,
      initial: stateFor("one", "notes"),
      workspace: () => ({
        profileId: "one",
        projectIds: ["notes"],
        activeProjectId: "notes",
      }),
    });
    store.freeze();
    window.bounds = { x: 80, y: 120, width: 850, height: 620 };
    window.emit("resize");
    vi.advanceTimersByTime(300);
    expect(store.load().windows[0]?.state.width).toBe(1000);
    store.resume();
    vi.advanceTimersByTime(300);
    expect(store.load().windows[0]?.state.width).toBe(850);
    store.freeze();
    window.destroyed = true;
    window.emit("closed");
    expect(store.load().windows).toHaveLength(1);
    expect(store.load().windows[0]?.state.width).toBe(850);
  });

  it("removes truly closed empty windows while retaining hidden occupied windows", () => {
    const store = new WindowStateStore<StateTestWindow>(storeFile());
    const empty = new StateTestWindow();
    const occupied = new StateTestWindow();
    store.track({
      window: empty,
      initial: stateFor("one"),
      workspace: () => ({
        profileId: "one",
        projectIds: [],
      }),
    });
    store.track({
      window: occupied,
      initial: stateFor("one", "notes"),
      workspace: () => ({
        profileId: "one",
        projectIds: ["notes"],
        activeProjectId: "notes",
      }),
    });
    empty.destroyed = true;
    empty.emit("closed");
    occupied.visible = false;
    occupied.emit("hide");
    store.freeze();
    expect(store.load().windows).toMatchObject([
      { visible: false, projectIds: ["notes"] },
    ]);
  });

  it("retains native modes of a restored hidden window until its first show", () => {
    const store = new WindowStateStore<StateTestWindow>(storeFile());
    const window = new StateTestWindow();
    window.visible = false;
    const initial = stateFor("one", "notes");
    initial.visible = false;
    initial.state.maximized = true;
    store.track({
      window,
      initial,
      workspace: () => ({
        profileId: "one",
        projectIds: ["notes"],
        activeProjectId: "notes",
      }),
    });
    store.freeze();
    expect(store.load().windows[0]).toMatchObject({
      visible: false,
      state: { maximized: true },
    });
  });

  it("ignores malformed windows and gives duplicate projects only one owner", () => {
    const first = stateFor("one", "notes");
    const second = stateFor("one", "notes");
    expect(
      normalizeWindowSession({
        windows: [
          first,
          {},
          first,
          { ...second, projectIds: ["notes", "research", "research"] },
        ],
        lastFocusedWindowId: "missing",
      }),
    ).toMatchObject({
      windows: [
        first,
        { ...second, projectIds: ["research"], activeProjectId: "research" },
      ],
      lastFocusedWindowId: undefined,
    });
    expect(normalizeWindowSession({ width: 1200 })).toEqual({ windows: [] });
  });
});
