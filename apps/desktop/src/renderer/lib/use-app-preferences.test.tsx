// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AppPrefs } from "../../shared/app-prefs.js";
import { useAppPreference, useAppPreferences } from "./use-app-preferences.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const ipc = vi.hoisted(() => ({
  listeners: new Set<(prefs: Record<string, unknown>) => void>(),
  resolve: (_prefs: Record<string, unknown>) => {},
  read: vi.fn<() => Promise<Record<string, unknown>>>(),
  write:
    vi.fn<(patch: Partial<AppPrefs>) => Promise<Record<string, unknown>>>(),
}));
vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    getPrefs: ipc.read,
    setPrefs: ipc.write,
    onPrefsChanged: (listener: (prefs: Record<string, unknown>) => void) => {
      ipc.listeners.add(listener);
      return () => ipc.listeners.delete(listener);
    },
  },
}));

let root: Root | undefined;
function pendingRead() {
  const pending = {
    resolve: (_prefs: Record<string, unknown>) => {},
    reject: (_cause: Error) => {},
  };
  const promise = new Promise<Record<string, unknown>>((resolve, reject) => {
    pending.resolve = resolve;
    pending.reject = reject;
  });
  return { ...pending, promise };
}
beforeEach(() => {
  vi.resetAllMocks();
  ipc.read.mockImplementation(
    () =>
      new Promise((resolve) => {
        ipc.resolve = resolve;
      }),
  );
});
afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  ipc.listeners.clear();
});

describe("useAppPreferences", () => {
  let observed: ReturnType<typeof useAppPreferences> | undefined;
  const poses: boolean[] = [];
  function current() {
    if (!observed) throw new Error("Preferences have not mounted");
    return observed;
  }
  function Probe() {
    observed = useAppPreferences();
    poses.push(observed.prefs.sidebarOpen);
    return null;
  }
  async function mount(canonical: Record<string, unknown>) {
    observed = undefined;
    poses.length = 0;
    ipc.read.mockImplementation(async () => ({ ...canonical }));
    ipc.write.mockImplementation(async (patch) => {
      Object.assign(canonical, patch);
      return { ...canonical };
    });
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe />));
  }

  it("keeps a revealed sidebar open when the previous collapse's snapshot arrives later", async () => {
    const canonical = { sidebarOpen: true };
    await mount(canonical);
    await act(async () => current().update({ sidebarOpen: false }));
    await act(async () => current().update({ sidebarOpen: true }));
    expect(current().prefs.sidebarOpen).toBe(true);
    const revealed = poses.length;
    await act(async () => {
      for (const listener of ipc.listeners) listener({ sidebarOpen: false });
    });
    expect(current().prefs.sidebarOpen).toBe(true);
    expect(poses.slice(revealed)).not.toContain(false);
    // A genuine external edit still applies, even with a stale hint payload.
    canonical.sidebarOpen = false;
    await act(async () => {
      for (const listener of ipc.listeners) listener({ sidebarOpen: true });
    });
    expect(current().prefs.sidebarOpen).toBe(false);
  });

  it("starts motion at the intent and sends only that explicit patch", async () => {
    const canonical = { sidebarOpen: true };
    await mount(canonical);
    const pending = { resolve: (_prefs: Record<string, unknown>) => {} };
    ipc.write.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          pending.resolve = resolve;
        }),
    );
    let saving: Promise<void> | undefined;
    act(() => {
      saving = current().update({ sidebarOpen: false });
    });
    expect(current().prefs.sidebarOpen).toBe(false);
    await act(async () => {});
    expect(ipc.write).toHaveBeenCalledExactlyOnceWith({ sidebarOpen: false });
    canonical.sidebarOpen = false;
    await act(async () => {
      pending.resolve({ ...canonical });
      await saving;
    });
    expect(current().prefs.sidebarOpen).toBe(false);
  });

  it("rolls a failed latest save back to current canonical preferences", async () => {
    const canonical = { sidebarOpen: true };
    await mount(canonical);
    ipc.write.mockRejectedValueOnce(new Error("The file cannot be saved"));
    await act(async () => current().update({ sidebarOpen: false }));
    expect(current().prefs.sidebarOpen).toBe(true);
    expect(current().error).toContain("Could not save preferences");
    expect(ipc.read.mock.calls.length).toBeGreaterThan(1);
  });

  it("ignores a read started before a newer intent, even before that save completes", async () => {
    const canonical = { sidebarOpen: true };
    await mount(canonical);
    const reading = pendingRead();
    const saving = pendingRead();
    ipc.read.mockReturnValueOnce(reading.promise);
    act(() => {
      for (const listener of ipc.listeners) listener({ sidebarOpen: true });
    });
    ipc.write.mockReturnValueOnce(saving.promise);
    let updated: Promise<void> | undefined;
    act(() => {
      updated = current().update({ sidebarOpen: false });
    });
    const intent = poses.length;
    await act(async () => reading.resolve({ sidebarOpen: true }));
    expect(current().prefs.sidebarOpen).toBe(false);
    expect(poses.slice(intent)).not.toContain(true);
    canonical.sidebarOpen = false;
    await act(async () => {
      saving.resolve({ ...canonical });
      await updated;
    });
  });

  it("does not let a hint read old canonical values while a local save is pending", async () => {
    const canonical = { sidebarOpen: true };
    await mount(canonical);
    const saving = pendingRead();
    ipc.write.mockReturnValueOnce(saving.promise);
    let updated: Promise<void> | undefined;
    act(() => {
      updated = current().update({ sidebarOpen: false });
    });
    const intent = poses.length;
    await act(async () => {
      for (const listener of ipc.listeners) listener({ sidebarOpen: true });
    });
    expect(current().prefs.sidebarOpen).toBe(false);
    expect(poses.slice(intent)).not.toContain(true);
    canonical.sidebarOpen = false;
    await act(async () => {
      saving.resolve({ ...canonical });
      await updated;
    });
    expect(current().prefs.sidebarOpen).toBe(false);
  });

  it("keeps overlapping patches to different keys until both writes settle", async () => {
    const canonical: { sidebarOpen: boolean; unreadSessionIds: string[] } = {
      sidebarOpen: true,
      unreadSessionIds: [],
    };
    await mount(canonical);
    const older = pendingRead();
    ipc.write.mockReturnValueOnce(older.promise);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = current().update({ sidebarOpen: false });
    });
    act(() => {
      second = current().update({ unreadSessionIds: ["new"] });
    });
    await act(async () => {});
    expect(current().prefs.sidebarOpen).toBe(false);
    expect(current().prefs.unreadSessionIds).toEqual(["new"]);
    canonical.sidebarOpen = false;
    await act(async () => {
      older.resolve({ ...canonical });
      await Promise.all([first, second]);
    });
    expect(current().prefs.sidebarOpen).toBe(false);
    expect(current().prefs.unreadSessionIds).toEqual(["new"]);
  });

  it("ignores old save completions and failures after a newer sidebar intent", async () => {
    const canonical = { sidebarOpen: true, rightSidebarOpen: false };
    await mount(canonical);
    const old = pendingRead();
    ipc.write.mockReturnValueOnce(old.promise);
    let first: Promise<void> | undefined;
    act(() => {
      first = current().update({ sidebarOpen: false });
    });
    let second: Promise<void> | undefined;
    act(() => {
      second = current().update({ sidebarOpen: true });
    });
    const revealed = poses.length;
    await act(async () => {
      old.resolve({ sidebarOpen: false });
      await Promise.all([first, second]);
    });
    expect(current().prefs.sidebarOpen).toBe(true);
    expect(poses.slice(revealed)).not.toContain(false);
    const failed = pendingRead();
    ipc.write.mockReturnValueOnce(failed.promise);
    let older: Promise<void> | undefined;
    act(() => {
      older = current().update({ rightSidebarOpen: true });
    });
    let newest: Promise<void> | undefined;
    act(() => {
      newest = current().update({ rightSidebarOpen: false });
    });
    await act(async () => {
      failed.reject(new Error("Old write failed"));
      await Promise.all([older, newest]);
    });
    expect(current().error).toBeNull();
    expect(current().prefs.rightSidebarOpen).toBe(false);
  });

  it("rolls back a failed latest patch after an older patch to another key settles", async () => {
    const canonical: { sidebarOpen: boolean; unreadSessionIds: string[] } = {
      sidebarOpen: true,
      unreadSessionIds: [],
    };
    await mount(canonical);
    const saving = pendingRead();
    ipc.write.mockReturnValueOnce(saving.promise);
    let first: Promise<void> | undefined;
    let second: Promise<void> | undefined;
    act(() => {
      first = current().update({ sidebarOpen: false });
    });
    ipc.write.mockRejectedValueOnce(new Error("Newest patch could not save"));
    act(() => {
      second = current().update({ unreadSessionIds: ["new"] });
    });
    await act(async () => {});
    expect(current().prefs.sidebarOpen).toBe(false);
    expect(current().error).toContain("Could not save preferences");
    canonical.sidebarOpen = false;
    await act(async () => {
      saving.resolve({ ...canonical });
      await Promise.all([first, second]);
    });
    expect(current().prefs.sidebarOpen).toBe(false);
    expect(current().prefs.unreadSessionIds).toEqual([]);
    expect(current().error).toContain("Could not save preferences");
  });

  it("keeps the initial loaded guard and ignores a superseded initial read", async () => {
    const canonical = { sidebarOpen: true };
    const initial = pendingRead();
    ipc.read.mockReturnValueOnce(initial.promise);
    await mount(canonical);
    expect(current().loaded).toBe(false);
    await act(async () => current().update({ sidebarOpen: false }));
    expect(current().loaded).toBe(true);
    expect(current().prefs.sidebarOpen).toBe(false);
    await act(async () => initial.resolve({ sidebarOpen: true }));
    expect(current().prefs.sidebarOpen).toBe(false);
  });

  it("awaits the new profile's canonical preferences and drops the previous read", async () => {
    const canonical = { sidebarOpen: false, lastProjectId: "previous" };
    await mount(canonical);
    const previous = pendingRead();
    ipc.read.mockReturnValueOnce(previous.promise);
    let previousReload: Promise<AppPrefs> | undefined;
    act(() => {
      previousReload = current().reload();
    });
    canonical.sidebarOpen = true;
    canonical.lastProjectId = "next";
    let next: AppPrefs | undefined;
    await act(async () => {
      next = await current().reload();
    });
    expect(next?.lastProjectId).toBe("next");
    expect(current().prefs.sidebarOpen).toBe(true);
    await act(async () => {
      previous.resolve({ sidebarOpen: false, lastProjectId: "previous" });
      await previousReload;
    });
    expect(current().prefs.lastProjectId).toBe("next");
    canonical.sidebarOpen = false;
    await act(async () =>
      window.dispatchEvent(new Event("catamorphic:profile-refetch")),
    );
    expect(current().prefs.sidebarOpen).toBe(false);
  });

  it("does not start a post-save read after its owner unmounts", async () => {
    const canonical = { sidebarOpen: true };
    await mount(canonical);
    const saving = pendingRead();
    ipc.write.mockReturnValueOnce(saving.promise);
    let update: Promise<void> | undefined;
    act(() => {
      update = current().update({ sidebarOpen: false });
    });
    // A file hint can already be waiting behind that save when the
    // workspace leaves. It must not start IPC after the owner is gone.
    act(() => {
      for (const listener of ipc.listeners) listener({ sidebarOpen: true });
    });
    const reads = ipc.read.mock.calls.length;
    act(() => root?.unmount());
    root = undefined;
    await act(async () => {
      saving.resolve({ sidebarOpen: false });
      await update;
    });
    expect(ipc.read).toHaveBeenCalledTimes(reads);
    expect(ipc.listeners.size).toBe(0);
  });
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
    await act(async () => root?.render(<Probe />));
    // The default, not yet read: what launch must not draw.
    expect(renders.at(-1)).toEqual([true, false]);
    await act(async () => ipc.resolve({ voiceInDock: false }));
    expect(renders.at(-1)).toEqual([false, true]);
    const count = renders.length;
    // Another choice changes, then a list: nothing to render.
    ipc.read.mockResolvedValue({ voiceInDock: false, dockCollapsed: true });
    await act(async () => {
      for (const listener of ipc.listeners)
        listener({ voiceInDock: false, dockCollapsed: true });
    });
    ipc.read.mockResolvedValue({ voiceInDock: false, unreadSessionIds: ["a"] });
    await act(async () => {
      for (const listener of ipc.listeners)
        listener({
          voiceInDock: false,
          dockCollapsed: true,
          unreadSessionIds: ["a"],
        });
    });
    expect(renders.length).toBe(count);
    ipc.read.mockResolvedValue({ voiceInDock: true });
    await act(async () => {
      for (const listener of ipc.listeners) listener({ voiceInDock: true });
    });
    expect(renders.at(-1)).toEqual([true, true]);
  });

  it("uses the same pending-write ordering without rendering unrelated keys", async () => {
    const canonical = { dockCollapsed: true, sidebarOpen: true };
    ipc.read.mockImplementation(async () => ({ ...canonical }));
    const renders: boolean[] = [];
    let change: ((value: boolean) => Promise<void>) | undefined;
    function Probe() {
      const [collapsed, update] = useAppPreference("dockCollapsed");
      change = update;
      renders.push(collapsed);
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe />));
    const saving = pendingRead();
    ipc.write.mockReturnValueOnce(saving.promise);
    let updated: Promise<void> | undefined;
    act(() => {
      updated = change?.(false);
    });
    expect(renders.at(-1)).toBe(false);
    const intent = renders.length;
    await act(async () => {
      for (const listener of ipc.listeners) listener({ dockCollapsed: true });
    });
    expect(renders.at(-1)).toBe(false);
    expect(renders.slice(intent)).not.toContain(true);
    canonical.dockCollapsed = false;
    await act(async () => {
      saving.resolve({ ...canonical });
      await updated;
    });
    const count = renders.length;
    canonical.sidebarOpen = false;
    await act(async () => {
      for (const listener of ipc.listeners)
        listener({ dockCollapsed: true, sidebarOpen: false });
    });
    expect(renders.length).toBe(count);
  });

  it("follows a different requested key without waiting for a file change", async () => {
    ipc.read.mockResolvedValue({ sidebarOpen: true, rightSidebarOpen: false });
    const values: boolean[] = [];
    function Probe({ name }: { name: "sidebarOpen" | "rightSidebarOpen" }) {
      const [value] = useAppPreference(name);
      values.push(value);
      return null;
    }
    root = createRoot(document.createElement("div"));
    await act(async () => root?.render(<Probe name="sidebarOpen" />));
    expect(values.at(-1)).toBe(true);
    await act(async () => root?.render(<Probe name="rightSidebarOpen" />));
    expect(values.at(-1)).toBe(false);
    expect(ipc.listeners.size).toBe(1);
  });
});
