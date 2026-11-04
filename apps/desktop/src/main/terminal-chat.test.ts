vi.mock("./shell-ipc.js", async () => ({
  shellIpcMain: (await import("electron")).ipcMain,
  shellSurfaceFor: () => "workspace",
}));

import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
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
import { registerTerminalSupport as registerTerminalSupportWithPolicy } from "./terminal.js";

const registerTerminalSupport = (
  ...args: Parameters<typeof registerTerminalSupportWithPolicy>
) =>
  registerTerminalSupportWithPolicy(args[0], args[1], args[2], {
    canAccessProject: () => true,
    profileFor: () => "profile",
  });

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
  it("authorizes every operation by window and profile, and preserves a legitimate project handoff", async () => {
    spawn.mockImplementation(shell);
    const contents = () =>
      Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        send: () => {},
      }) as unknown as WebContents;
    const owner = contents();
    const next = contents();
    const foreign = contents();
    let ownerProfile = "profile";
    const policy = {
      profileFor: (sender: WebContents) =>
        sender === foreign
          ? "foreign"
          : sender === owner
            ? ownerProfile
            : "profile",
      canAccessProject: (_projectId: string, sender: WebContents) =>
        sender !== foreign && (sender !== owner || ownerProfile === "profile"),
    };
    const state = {
      current: { projectRoots: { get: () => "/project" } },
      broadcast: () => {},
    } as unknown as ServerState;
    const terminals = registerTerminalSupportWithPolicy(
      state,
      undefined,
      (_projectId, sender) => sender === next,
      policy,
    );
    const call = (channel: string, sender: WebContents, ...args: unknown[]) =>
      handlers.get(`catamorphic:terminal-${channel}`)?.({ sender }, ...args);
    try {
      expect(() => call("create", foreign, { projectId: "project" })).toThrow(
        "another profile",
      );
      expect(() => call("create", owner, { cols: Number.NaN })).toThrow();
      expect(() => call("create", owner, { rows: 1_000_000 })).toThrow();
      const created = (await call("create", owner, {
        projectId: "project",
      })) as { sessionId: string };
      for (const sender of [next, foreign]) {
        expect(() =>
          call("write", sender, created.sessionId, "danger\r"),
        ).toThrow("another Work window");
        expect(() => call("resize", sender, created.sessionId, 80, 24)).toThrow(
          "another Work window",
        );
        expect(() => call("kill", sender, created.sessionId)).toThrow(
          "another Work window",
        );
        expect(() => call("buffer", sender, created.sessionId)).toThrow(
          "another Work window",
        );
      }
      ownerProfile = "foreign";
      expect(() => call("write", owner, created.sessionId, "danger\r")).toThrow(
        "another Work window",
      );
      ownerProfile = "profile";
      expect(() => call("write", owner, created.sessionId, {})).toThrow();
      expect(() =>
        call("resize", owner, created.sessionId, 80.5, 24),
      ).toThrow();
      terminals.handOff("project", owner);
      expect(call("adopt", foreign, created.sessionId, "project")).toBeNull();
      expect(call("adopt", next, created.sessionId, "project")).toEqual({
        buffer: "",
      });
      expect(() => call("write", owner, created.sessionId, "danger\r")).toThrow(
        "another Work window",
      );
      expect(() =>
        call("write", next, created.sessionId, "safe\r"),
      ).not.toThrow();
      expect(() => call("kill", next, created.sessionId)).not.toThrow();
    } finally {
      await terminals.dispose();
    }
  });

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
