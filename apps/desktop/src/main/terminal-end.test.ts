import { EventEmitter } from "node:events";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

const handlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>(),
);
/** What every window heard, in order. */
const heard = vi.hoisted(() => [] as { channel: string; payload: unknown }[]);
/** The shells started, latest last: tests move their foreground process. */
const shells = vi.hoisted(
  () =>
    [] as {
      process: string;
      print(data: string): void;
      exit(code: number): void;
    }[],
);
vi.mock("electron", () => ({
  BrowserWindow: {
    getAllWindows: () => [
      {
        isDestroyed: () => false,
        webContents: {
          send: (channel: string, payload: unknown) =>
            heard.push({ channel, payload }),
        },
      },
    ],
  },
  ipcMain: {
    handle: (key: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(key, handler),
  },
}));
vi.mock("./shell-integration.js", () => ({
  shellIntegration: async () => null,
  shellBinShimDir: async () => null,
}));
vi.mock("@lydell/node-pty", () => ({
  spawn: (file: string) => {
    const events = new EventEmitter();
    const shell = {
      process: path.basename(file),
      print: (data: string) => events.emit("data", data),
      exit: (exitCode: number) => events.emit("exit", { exitCode }),
      onExit(callback: () => void) {
        events.on("exit", callback);
        return { dispose: () => events.off("exit", callback) };
      },
      onData(callback: () => void) {
        events.on("data", callback);
        return { dispose: () => events.off("data", callback) };
      },
      kill() {
        events.emit("exit", { exitCode: 0 });
      },
      write() {},
      resize() {},
    };
    shells.push(shell);
    return shell;
  },
}));

import { registerTerminalSupport } from "./terminal.js";

const until = async (check: () => boolean, ms = 3_000) => {
  const deadline = Date.now() + ms;
  while (!check() && Date.now() < deadline)
    await new Promise((resolve) => setTimeout(resolve, 20));
  expect(check()).toBe(true);
};

/** The news about one session, in the order windows heard it. */
const newsFor = (sessionId: string) =>
  heard.flatMap(({ channel, payload }) =>
    typeof payload === "object" &&
    payload !== null &&
    "sessionId" in payload &&
    payload.sessionId === sessionId &&
    channel !== "catamorphic:terminal-data"
      ? [{ channel, payload }]
      : [],
  );

const support = () =>
  registerTerminalSupport({ current: null, broadcast: () => {} });

afterEach(() => {
  heard.length = 0;
  shells.length = 0;
});

describe("a terminal's activity ends with it (ADR 0223)", () => {
  it("an agent terminal counts as work only while a command runs, and its kill stops the spinner first", async () => {
    const terminals = support();
    try {
      const { sessionId } = await terminals.agentTerminals.create("p", "chat");
      const shell = shells.at(-1);
      if (!shell) throw new Error("no shell started");
      shell.print("$ npm run dev\r\nready\r\n");
      // An idle shell is not work.
      expect(terminals.hasActiveWork()).toBe(false);
      shell.process = "node";
      await until(() => newsFor(sessionId).length > 0);
      expect(terminals.hasActiveWork()).toBe(true);

      terminals.agentTerminals.kill(sessionId);
      expect(newsFor(sessionId)).toEqual([
        {
          channel: "catamorphic:terminal-busy",
          payload: { sessionId, busy: true },
        },
        {
          channel: "catamorphic:terminal-busy",
          payload: { sessionId, busy: false },
        },
        {
          channel: "catamorphic:terminal-exit",
          payload: { sessionId, exitCode: 0 },
        },
      ]);
      expect(terminals.hasActiveWork()).toBe(false);
      // A tab still open on it keeps showing what it printed.
      expect(
        await handlers.get("catamorphic:terminal-buffer")?.({}, sessionId),
      ).toEqual({ buffer: "$ npm run dev\r\nready\r\n", running: false });
      expect(terminals.agentTerminals.read(sessionId)).toBe(
        "$ npm run dev\r\nready\r\n",
      );
      expect(terminals.agentTerminals.isRunning(sessionId)).toBe(false);
    } finally {
      await terminals.dispose();
    }
  });

  it("a shell that exits by itself says so once, however it is ended after", async () => {
    const terminals = support();
    try {
      const { sessionId } = await terminals.agentTerminals.create("p", "chat");
      const shell = shells.at(-1);
      if (!shell) throw new Error("no shell started");
      shell.process = "sleep";
      await until(() => newsFor(sessionId).length > 0);
      shell.exit(3);
      // Readable until its background command reads the code and ends it.
      expect(terminals.agentTerminals.exitCode(sessionId)).toBe(3);
      terminals.agentTerminals.kill(sessionId);
      expect(newsFor(sessionId).slice(1)).toEqual([
        {
          channel: "catamorphic:terminal-busy",
          payload: { sessionId, busy: false },
        },
        {
          channel: "catamorphic:terminal-exit",
          payload: { sessionId, exitCode: 3 },
        },
      ]);
    } finally {
      await terminals.dispose();
    }
  });

  it("archiving a chat and closing a tab stop the spinner too", async () => {
    const terminals = support();
    try {
      const agent = await terminals.agentTerminals.create("p", "chat");
      const agentShell = shells.at(-1);
      const sender = Object.assign(new EventEmitter(), {
        isDestroyed: () => false,
        send: (channel: string, payload: unknown) =>
          heard.push({ channel, payload }),
      });
      const user = (await handlers.get("catamorphic:terminal-create")?.(
        { sender },
        {},
      )) as { sessionId: string };
      const userShell = shells.at(-1);
      if (!agentShell || !userShell) throw new Error("no shell started");
      agentShell.process = "bun";
      userShell.process = "vim";
      await until(
        () =>
          newsFor(agent.sessionId).length > 0 &&
          newsFor(user.sessionId).length > 0,
      );
      expect(terminals.agentTerminals.killForOwners("p", ["chat"])).toBe(1);
      handlers.get("catamorphic:terminal-kill")?.({}, user.sessionId);
      for (const sessionId of [agent.sessionId, user.sessionId])
        expect(newsFor(sessionId).map(({ payload }) => payload)).toEqual([
          { sessionId, busy: true },
          { sessionId, busy: false },
          { sessionId, exitCode: 0 },
        ]);
      expect(terminals.hasActiveWork()).toBe(false);
    } finally {
      await terminals.dispose();
    }
  });
});
