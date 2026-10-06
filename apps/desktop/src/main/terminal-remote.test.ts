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
    throw new Error("A remote terminal never starts a local shell");
  },
}));

import type { ServerState } from "./ipc.js";
import type { RemoteTerminalRequest } from "./remote-terminal.js";
import { registerTerminalSupport } from "./terminal.js";

type Call = Parameters<RemoteTerminalRequest>[0];

describe("terminal tabs on a remote chat's workspace (ADR 0209)", () => {
  it("open, stream, type into and close a shell on the project's server", async () => {
    const calls: Call[] = [];
    let release: (() => void) | undefined;
    let served = false;
    const request: RemoteTerminalRequest = async (call) => {
      calls.push(call);
      if (call.method === "POST" && call.path === "")
        return {
          status: 201,
          body: { terminalId: "proc-abcdef12", pty: true },
        };
      if (call.method === "GET") {
        if (!served) {
          served = true;
          return {
            status: 200,
            body: {
              data: "remote$ ",
              cursor: 0,
              nextCursor: 8,
              more: false,
              exited: false,
              exitCode: null,
            },
          };
        }
        await new Promise<void>((resolve) => {
          release = resolve;
          call.signal?.addEventListener("abort", () => resolve());
        });
        return {
          status: 404,
          body: { error: "This terminal ended with its chat's workspace." },
        };
      }
      return { status: 200, body: { ok: true } };
    };
    const requested: Array<{ projectId: string; sessionId: string }> = [];
    const state = {
      current: {
        remoteTerminalRequest: (input: {
          projectId: string;
          sessionId: string;
        }) => {
          requested.push(input);
          return request;
        },
      },
      broadcast: () => {},
    } as unknown as ServerState;
    const terminals = registerTerminalSupport(state);
    const sent: Array<[string, unknown]> = [];
    const sender = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: (channel: string, payload: unknown) =>
        sent.push([channel, payload]),
    });
    try {
      const created = (await handlers.get("catamorphic:terminal-create")?.(
        { sender },
        {
          projectId: "local-project",
          cols: 100,
          rows: 30,
          remoteChat: { sessionId: "chat-1" },
        },
      )) as { sessionId: string; cwd: string };
      expect(requested).toEqual([
        { projectId: "local-project", sessionId: "chat-1" },
      ]);
      expect(calls[0]).toMatchObject({ body: { cols: 100, rows: 30 } });
      await vi.waitFor(() =>
        expect(sent).toContainEqual([
          "catamorphic:terminal-data",
          { sessionId: created.sessionId, data: "remote$ " },
        ]),
      );

      await handlers.get("catamorphic:terminal-write")?.(
        {},
        created.sessionId,
        "ls\r",
      );
      await vi.waitFor(() =>
        expect(calls).toContainEqual(
          expect.objectContaining({
            method: "POST",
            path: "/proc-abcdef12/input",
            body: { data: "ls\r" },
          }),
        ),
      );

      // The workspace went away: the tab is told why instead of closing.
      release?.();
      await vi.waitFor(() =>
        expect(sent).toContainEqual([
          "catamorphic:terminal-exit",
          {
            sessionId: created.sessionId,
            exitCode: 1,
            message: "This terminal ended with its chat's workspace.",
          },
        ]),
      );
      expect(terminals.hasActiveWork()).toBe(false);
    } finally {
      await terminals.dispose();
    }
  });

  it("a refused open reaches the tab as the server's plain words", async () => {
    const request: RemoteTerminalRequest = async () => ({
      status: 409,
      body: {
        error:
          "This chat's workspace is not running; send it a message to start it.",
      },
    });
    const state = {
      current: { remoteTerminalRequest: () => request },
      broadcast: () => {},
    } as unknown as ServerState;
    const terminals = registerTerminalSupport(state);
    const sender = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: () => {},
    });
    try {
      const refused = await Promise.resolve(
        handlers.get("catamorphic:terminal-create")?.(
          { sender },
          { projectId: "local-project", remoteChat: { sessionId: "chat-1" } },
        ),
      ).catch((error: unknown) => error);
      // Electron sends `String(error)` to the renderer.
      expect(String(refused)).toBe(
        "Error: This chat's workspace is not running; send it a message to start it.",
      );
    } finally {
      await terminals.dispose();
    }
  });

  it("closing the tab closes the remote shell", async () => {
    const calls: Call[] = [];
    const request: RemoteTerminalRequest = async (call) => {
      calls.push(call);
      if (call.method === "POST" && call.path === "")
        return {
          status: 201,
          body: { terminalId: "proc-abcdef12", pty: true },
        };
      if (call.method === "GET")
        await new Promise<void>((resolve) =>
          call.signal?.addEventListener("abort", () => resolve()),
        );
      return { status: 200, body: { ok: true } };
    };
    const state = {
      current: { remoteTerminalRequest: () => request },
      broadcast: () => {},
    } as unknown as ServerState;
    const terminals = registerTerminalSupport(state);
    const sender = Object.assign(new EventEmitter(), {
      isDestroyed: () => false,
      send: () => {},
    });
    try {
      const created = (await handlers.get("catamorphic:terminal-create")?.(
        { sender },
        { projectId: "local-project", remoteChat: { sessionId: "chat-1" } },
      )) as { sessionId: string };
      await handlers.get("catamorphic:terminal-kill")?.({}, created.sessionId);
      await vi.waitFor(() =>
        expect(calls).toContainEqual({
          method: "DELETE",
          path: "/proc-abcdef12",
        }),
      );
      expect(sender.listenerCount("destroyed")).toBe(0);
    } finally {
      await terminals.dispose();
    }
  });
});
