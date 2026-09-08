import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>(),
);
vi.mock("electron", () => ({
  BrowserWindow: { getAllWindows: () => [] },
  ipcMain: {
    handle: (key: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(key, handler),
  },
}));
vi.mock("@lydell/node-pty", () => ({
  spawn: () => {
    const events = new EventEmitter();
    return {
      onExit(callback: () => void) {
        events.on("exit", callback);
        return {
          dispose() {
            events.off("exit", callback);
          },
        };
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
  },
}));

import { registerTerminalSupport } from "./terminal.js";

describe("terminal sender cleanup", () => {
  it("removes window-destroyed listeners when terminals close", async () => {
    const terminals = registerTerminalSupport({
      current: null,
      broadcast: () => {},
    });
    const sender = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: () => {},
    });
    try {
      for (let i = 0; i < 100; i++) {
        const created = (await handlers.get("catamorphic:terminal-create")?.(
          { sender },
          {},
        )) as { sessionId: string };
        handlers.get("catamorphic:terminal-kill")?.({}, created.sessionId);
        expect(sender.listenerCount("destroyed")).toBe(0);
      }
      expect(terminals.hasActiveWork()).toBe(false);
    } finally {
      await terminals.dispose();
    }
  });
});
