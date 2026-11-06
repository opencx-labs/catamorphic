// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppPreference } from "./use-app-preferences.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const ipc = vi.hoisted(() => ({
  listeners: new Set<(prefs: Record<string, unknown>) => void>(),
  resolve: (_prefs: Record<string, unknown>) => {},
}));
vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    getPrefs: () =>
      new Promise((resolve) => {
        ipc.resolve = resolve;
      }),
    setPrefs: vi.fn(),
    onPrefsChanged: (listener: (prefs: Record<string, unknown>) => void) => {
      ipc.listeners.add(listener);
      return () => ipc.listeners.delete(listener);
    },
  },
}));

let root: Root | undefined;
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  ipc.listeners.clear();
});

describe("useAppPreference", () => {
  it("says when it has read the choice, and calls its caller only when that choice changes", async () => {
    const renders: [boolean, boolean][] = [];
    function Probe() {
      const [voiceInDock, , loaded] = useAppPreference("voiceInDock");
      renders.push([voiceInDock, loaded]);
      return null;
    }
    root = createRoot(document.createElement("div"));
    act(() => root?.render(<Probe />));
    // The default, not yet read: what launch must not draw.
    expect(renders.at(-1)).toEqual([true, false]);
    await act(async () => ipc.resolve({ voiceInDock: false }));
    expect(renders.at(-1)).toEqual([false, true]);
    const count = renders.length;
    // Another choice changes, then a list: nothing to render.
    act(() => {
      for (const listener of ipc.listeners)
        listener({ voiceInDock: false, dockCollapsed: true });
    });
    act(() => {
      for (const listener of ipc.listeners)
        listener({
          voiceInDock: false,
          dockCollapsed: true,
          unreadSessionIds: ["a"],
        });
    });
    expect(renders.length).toBe(count);
    act(() => {
      for (const listener of ipc.listeners) listener({ voiceInDock: true });
    });
    expect(renders.at(-1)).toEqual([true, true]);
  });
});
