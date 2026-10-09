import os from "node:os";
import path from "node:path";
import { ipcMain } from "electron";
import { expect, it, vi } from "vitest";
import { registerAgentBridge } from "./agent-bridge.js";
import type { AgentTerminals } from "./terminal.js";

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    ipcMain: Object.assign(new EventEmitter(), {
      handle: () => {},
      removeHandler: () => {},
    }),
    BrowserWindow: { getAllWindows: () => [], getFocusedWindow: () => null },
    webContents: { fromId: () => undefined },
  };
});

const terminals: AgentTerminals = {
  create: async () => ({ sessionId: "", cwd: "" }),
  write: () => false,
  writeAny: () => false,
  read: () => null,
  bufferLength: () => null,
  readFrom: () => "",
  isRunning: () => false,
  exitCode: () => undefined,
  isBusy: () => false,
  commandTracking: () => null,
  isAgentOwned: () => false,
  countForOwners: () => 0,
  killForOwners: () => 0,
  kill: () => false,
};

/** The renderer's side of the bridge RPC, noting the controls it is sent. */
const renderer = () => {
  const controls: unknown[] = [];
  const send = (
    _channel: string,
    request: { id: number; method: string; params: unknown },
  ) => {
    if (request.method === "surfaceControl") controls.push(request.params);
    const result =
      request.method === "openAgentBrowser" ? { key: "browser:page" } : true;
    queueMicrotask(() =>
      ipcMain.emit(
        "catamorphic:bridge-response",
        { sender: { id: 1 } },
        { id: request.id, result },
      ),
    );
  };
  return { controls, targetFor: vi.fn().mockReturnValue({ id: 1, send }) };
};

it("holds the page a retried turn opens, and lets a settled turn's page go", async () => {
  const { controls, targetFor } = renderer();
  const { bridge, dispose } = registerAgentBridge(terminals, targetFor, {
    file: path.join(os.tmpdir(), "agent-bridge-test-watches.json"),
    env: async () => ({}),
  });
  const released = { projectId: "project", key: "browser:page" };
  try {
    const turn = { sessionId: "chat", turnId: "turn" };
    // A transient failure settles the turn, which then runs again.
    await bridge.releaseTurn("project", { ...turn, retrying: true });
    await bridge.openBrowser("project", turn, "https://example.com");
    expect(controls).toEqual([]);
    // Settled for good, its page goes back to the person.
    await bridge.releaseTurn("project", turn);
    expect(controls).toEqual([{ ...released, controlled: false }]);
    // A page that mounts after its turn settled is not held.
    controls.length = 0;
    await bridge.openBrowser("project", turn, "https://example.com");
    expect(controls).toEqual([{ ...released, controlled: false }]);
  } finally {
    dispose();
  }
});
