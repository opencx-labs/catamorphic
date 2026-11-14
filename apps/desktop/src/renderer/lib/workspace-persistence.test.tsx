// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushWorkspaceSaves,
  forgetWorkspaceSave,
  useWorkspacePersistence,
} from "./workspace-persistence.js";
import { emptyWorkspace, type Workspace } from "./workspace-state.js";

const write = vi.hoisted(() =>
  vi.fn(async (_projectId: string, _snapshot: unknown) => {}),
);
vi.mock("./desktop-api.js", () => ({
  desktopApi: { workspaceStateSet: write },
}));

const named = (label: string): Workspace => ({
  ...emptyWorkspace(),
  tabs: [{ kind: "settings", name: "settings", label }],
});

function Probe({ workspace }: { workspace?: Workspace }) {
  useWorkspacePersistence({ projectId: "project", workspace });
  return null;
}

describe("workspace save handoff", () => {
  let root: Root;
  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    write.mockReset();
    write.mockResolvedValue(undefined);
    root = createRoot(document.createElement("div"));
  });
  afterEach(async () => {
    act(() => root.unmount());
    await flushWorkspaceSaves();
    vi.useRealTimers();
  });
  const render = (workspace?: Workspace) =>
    act(() => root.render(<Probe workspace={workspace} />));

  it("flushes the current snapshot immediately, before the debounce runs", async () => {
    render(named("Before"));
    render(named("Opened just before Quit"));
    expect(write).not.toHaveBeenCalled();
    await flushWorkspaceSaves();
    expect(write).toHaveBeenCalledOnce();
    expect(write).toHaveBeenCalledWith(
      "project",
      expect.objectContaining({
        tabs: [
          {
            kind: "settings",
            name: "settings",
            label: "Opened just before Quit",
          },
        ],
      }),
    );
  });

  it("waits for an older in-flight save before writing the shutdown snapshot", async () => {
    let finish = () => {};
    write.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    render(named("Older"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(write).toHaveBeenCalledOnce();
    render(named("Newest"));
    const flushed = flushWorkspaceSaves();
    await Promise.resolve();
    expect(write).toHaveBeenCalledOnce();
    finish();
    await flushed;
    expect(write).toHaveBeenLastCalledWith(
      "project",
      expect.objectContaining({
        tabs: [{ kind: "settings", name: "settings", label: "Newest" }],
      }),
    );
  });

  it("does not overwrite a workspace whose initial restoration is still pending", async () => {
    render();
    await flushWorkspaceSaves();
    expect(write).not.toHaveBeenCalled();
  });

  it("does not write a snapshot again while it is unchanged", async () => {
    render(named("Steady"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    // A new workspace object that serializes the same: nothing to store.
    render(named("Steady"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await flushWorkspaceSaves();
    expect(write).toHaveBeenCalledOnce();
    render(named("Changed"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(write).toHaveBeenCalledTimes(2);
    render(named("Steady"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(write).toHaveBeenCalledTimes(3);
  });

  it("writes an unchanged snapshot again once the window forgets the project", async () => {
    render(named("Moved away and back"));
    await flushWorkspaceSaves();
    expect(write).toHaveBeenCalledOnce();
    // Another window may have written the project in between.
    forgetWorkspaceSave("project");
    await flushWorkspaceSaves();
    expect(write).toHaveBeenCalledTimes(2);
  });

  it("writes an unchanged snapshot again at quit when its write in flight fails", async () => {
    let fail = (_error: Error) => {};
    write.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          fail = reject;
        }),
    );
    render(named("In flight"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    expect(write).toHaveBeenCalledOnce();
    const flushed = flushWorkspaceSaves();
    fail(new Error("Database write failed"));
    await expect(flushed).resolves.toBeUndefined();
    expect(write).toHaveBeenCalledTimes(2);
    expect(write).toHaveBeenLastCalledWith(
      "project",
      expect.objectContaining({
        tabs: [{ kind: "settings", name: "settings", label: "In flight" }],
      }),
    );
  });

  it("reports a failed flush and permits saving the current snapshot on retry", async () => {
    render(named("Latest"));
    write.mockRejectedValueOnce(new Error("Database write failed"));
    await expect(flushWorkspaceSaves()).rejects.toThrow(
      "Database write failed",
    );
    await flushWorkspaceSaves();
    expect(write).toHaveBeenCalledTimes(2);
  });
});
