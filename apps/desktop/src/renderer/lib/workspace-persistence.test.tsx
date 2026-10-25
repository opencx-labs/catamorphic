// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  flushWorkspaceSaves,
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
