import { EventEmitter } from "node:events";
import { ipcMain, type WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  registerShellContents,
  shellIpcMain,
  shellSurfaceFor,
} from "./shell-ipc.js";

const handlers = vi.hoisted(
  () => new Map<string, (...args: unknown[]) => unknown>(),
);
vi.mock("electron", () => ({
  app: { isPackaged: true },
  ipcMain: Object.assign(new EventEmitter(), {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      handlers.set(channel, handler),
    removeHandler: (channel: string) => handlers.delete(channel),
  }),
}));

const DOCUMENT = "work-internal://shell/index.html";
function shell(documentUrl = DOCUMENT) {
  const frame = {
    url: documentUrl,
    origin: "work-internal://shell",
    parent: null,
    detached: false,
  };
  const contents = Object.assign(new EventEmitter(), {
    getURL: () => frame.url,
    mainFrame: frame,
    isDestroyed: () => false,
  });
  const sender = contents as unknown as WebContents;
  return { contents, sender, frame, event: { sender, senderFrame: frame } };
}

beforeEach(() => {
  handlers.clear();
  ipcMain.removeAllListeners();
});
afterEach(() => vi.restoreAllMocks());

describe("native shell IPC admission", () => {
  it("allows a registered current main document without replacing Electron's global methods", () => {
    const nativeHandle = ipcMain.handle;
    const nativeOn = ipcMain.on;
    const owner = shell();
    registerShellContents({
      contents: owner.sender,
      documentUrl: DOCUMENT,
      surface: "workspace",
    });
    const action = vi.fn(() => "allowed");
    shellIpcMain.handle("privileged", action);
    expect(handlers.get("privileged")?.(owner.event)).toBe("allowed");
    expect(action).toHaveBeenCalledOnce();
    expect(ipcMain.handle).toBe(nativeHandle);
    expect(ipcMain.on).toBe(nativeOn);
  });

  it("rejects unregistered windows and subframes even when their URL matches", () => {
    const owner = shell();
    const unknown = shell();
    registerShellContents({
      contents: owner.sender,
      documentUrl: DOCUMENT,
      surface: "workspace",
    });
    const action = vi.fn();
    shellIpcMain.handle("privileged", action);
    const call = handlers.get("privileged");
    expect(() => call?.(unknown.event)).toThrow("trusted Work");
    expect(() =>
      call?.({
        sender: owner.sender,
        senderFrame: { ...owner.frame, parent: owner.frame },
      }),
    ).toThrow("trusted Work");
    expect(() => call?.({ sender: owner.sender, senderFrame: null })).toThrow(
      "trusted Work",
    );
    expect(action).not.toHaveBeenCalled();
  });

  it("rejects navigated, stale, opaque, detached and destroyed documents", () => {
    const owner = shell();
    registerShellContents({
      contents: owner.sender,
      documentUrl: DOCUMENT,
      surface: "workspace",
    });
    const action = vi.fn();
    shellIpcMain.handle("privileged", action);
    const call = () => handlers.get("privileged")?.(owner.event);
    owner.frame.url = "https://example.com";
    expect(call).toThrow("trusted Work");
    owner.frame.url = `${DOCUMENT}?surface=passkey`;
    expect(call).toThrow("trusted Work");
    owner.frame.url = DOCUMENT;
    owner.frame.origin = "null";
    expect(call).toThrow("trusted Work");
    owner.frame.origin = "work-internal://shell";
    owner.frame.detached = true;
    expect(call).toThrow("trusted Work");
    owner.frame.detached = false;
    owner.contents.mainFrame = { ...owner.frame };
    expect(call).toThrow("trusted Work");
    owner.contents.mainFrame = owner.frame;
    owner.contents.emit("destroyed");
    expect(call).toThrow("trusted Work");
    expect(action).not.toHaveBeenCalled();
  });

  it("limits auxiliary surfaces to their native channel grant", () => {
    const documentUrl = `${DOCUMENT}?surface=passkey`;
    const owner = shell(documentUrl);
    registerShellContents({
      contents: owner.sender,
      documentUrl,
      surface: "passkey-sheet",
      channels: ["passkey-use"],
    });
    shellIpcMain.handle("passkey-use", () => true);
    expect(shellSurfaceFor(owner.sender)).toBe("passkey-sheet");
    shellIpcMain.handle("terminal-create", vi.fn());
    expect(handlers.get("passkey-use")?.(owner.event)).toBe(true);
    expect(() => handlers.get("terminal-create")?.(owner.event)).toThrow(
      "trusted Work",
    );
    expect(() =>
      registerShellContents({
        contents: owner.sender,
        documentUrl: "https://example.com",
        surface: "workspace",
      }),
    ).toThrow("Invalid Work");
    owner.frame.url = "https://example.com";
    expect(shellSurfaceFor(owner.sender)).toBeUndefined();
  });

  it("drops unauthorized event IPC and removes its guarded listener on disposal", () => {
    const owner = shell();
    const action = vi.fn();
    shellIpcMain.on("privileged", action);
    expect(() => ipcMain.emit("privileged", owner.event)).not.toThrow();
    expect(action).not.toHaveBeenCalled();
    registerShellContents({
      contents: owner.sender,
      documentUrl: DOCUMENT,
      surface: "workspace",
    });
    ipcMain.emit("privileged", owner.event);
    expect(action).toHaveBeenCalledOnce();
    shellIpcMain.off("privileged", action);
    expect(ipcMain.listenerCount("privileged")).toBe(0);
  });
});
