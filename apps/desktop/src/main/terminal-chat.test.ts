import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import type { TerminalCreateInput } from "../shared/terminal.js";

const { handlers, spawn } = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  spawn: vi.fn(),
}));
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (key: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(key, handler),
  },
}));
vi.mock("@lydell/node-pty", () => ({ spawn }));

import type { ServerState } from "./ipc.js";
import { registerTerminalSupport } from "./terminal.js";

function shell() {
  const events = new EventEmitter();
  return {
    onExit(callback: () => void) {
      events.on("exit", callback);
      return { dispose: () => events.off("exit", callback) };
    },
    onData() {
      return { dispose() {} };
    },
    kill() {
      events.emit("exit", { exitCode: 0 });
    },
    write() {},
    resize() {},
  };
}

describe("user terminals in chat checkouts", () => {
  it("resolves the current chat assignment for each new shell and uses the project root without a chat", async () => {
    spawn.mockImplementation(shell);
    const resolve = vi.fn().mockResolvedValue("/checkouts/feature");
    const state = {
      current: {
        projectRoots: { get: () => "/project" },
        sessionCheckouts: { resolve },
      },
      broadcast: () => {},
    } as unknown as ServerState;
    const terminals = registerTerminalSupport(state);
    const sender = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: () => {},
    });
    const create = (input: TerminalCreateInput) =>
      handlers.get("catamorphic:terminal-create")?.({ sender }, input);
    try {
      const input = {
        projectId: "project",
        chat: { sessionId: "chat", remote: false },
      };
      expect(await create(input)).toMatchObject({ cwd: "/checkouts/feature" });
      expect(resolve).toHaveBeenLastCalledWith({
        projectId: "project",
        sessionId: "chat",
      });
      resolve.mockResolvedValue("/checkouts/updated");
      expect(await create(input)).toMatchObject({ cwd: "/checkouts/updated" });
      expect(await create({ projectId: "project" })).toMatchObject({
        cwd: "/project",
      });
      expect(resolve).toHaveBeenCalledTimes(2);
      expect(spawn.mock.calls.slice(-3).map((call) => call[2].cwd)).toEqual([
        "/checkouts/feature",
        "/checkouts/updated",
        "/project",
      ]);
    } finally {
      await terminals.dispose();
    }
  });

  it("refuses an unavailable worktree instead of silently starting in the project folder", async () => {
    spawn.mockClear();
    const resolve = vi
      .fn()
      .mockRejectedValue(new Error("The assigned worktree is unavailable."));
    const state = {
      current: {
        projectRoots: { get: () => "/project" },
        sessionCheckouts: { resolve },
      },
      broadcast: () => {},
    } as unknown as ServerState;
    const terminals = registerTerminalSupport(state);
    try {
      await expect(
        handlers.get("catamorphic:terminal-create")?.(
          { sender: {} },
          { projectId: "project", chat: { sessionId: "chat", remote: false } },
        ),
      ).rejects.toThrow("The assigned worktree is unavailable.");
      resolve.mockResolvedValue(undefined);
      await expect(
        handlers.get("catamorphic:terminal-create")?.(
          { sender: {} },
          { projectId: "project", chat: { sessionId: "chat", remote: false } },
        ),
      ).rejects.toThrow("This chat's working folder is unavailable.");
      expect(spawn).not.toHaveBeenCalled();
    } finally {
      await terminals.dispose();
    }
  });
});
