import { runInNewContext } from "node:vm";
import { describe, expect, it, vi } from "vitest";
import { SHELL_WINDOW_ARGUMENT } from "../shared/desktop-workspace.js";
import { installShellWindowClose } from "./shell-window-close.js";

describe("shell window close bridge", () => {
  it("routes raw DOM close through the proxied callback in the designated top-level shell", () => {
    const originalClose = vi.fn();
    const target = { close: originalClose };
    const requestClose = vi.fn();
    const executeInMainWorld = vi.fn((script: Electron.ExecutionScript) =>
      runInNewContext(`(${script.func.toString()})(...args)`, {
        window: target,
        args: script.args,
      }),
    );
    installShellWindowClose({
      bridge: { executeInMainWorld },
      requestClose,
      isMainFrame: true,
      argv: [SHELL_WINDOW_ARGUMENT],
    });
    expect(executeInMainWorld).toHaveBeenCalledOnce();
    expect(target.close()).toBeUndefined();
    expect(requestClose).toHaveBeenCalledOnce();
    expect(originalClose).not.toHaveBeenCalled();
  });

  it("preserves Chromium close in browsing pages, auxiliary surfaces and child frames", () => {
    const bridge = { executeInMainWorld: vi.fn() };
    for (const input of [
      { isMainFrame: true, argv: [] },
      { isMainFrame: false, argv: [SHELL_WINDOW_ARGUMENT] },
      { isMainFrame: true, argv: ["--surface=voice"] },
      { isMainFrame: true, argv: ["--surface=passkey"] },
    ])
      installShellWindowClose({ bridge, requestClose: vi.fn(), ...input });
    expect(bridge.executeInMainWorld).not.toHaveBeenCalled();
  });
});
