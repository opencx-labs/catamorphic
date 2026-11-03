import { EventEmitter } from "node:events";
import type { WebContents } from "electron";
import { afterEach, expect, it, vi } from "vitest";
import { registerShellContents } from "./shell-ipc.js";
import { registerTerminalSupport } from "./terminal.js";

const windows = vi.hoisted(
  () => [] as { webContents: WebContents; isDestroyed(): boolean }[],
);
vi.mock("electron", () => ({
  app: { isPackaged: true },
  BrowserWindow: { getAllWindows: () => windows },
  ipcMain: { handle: vi.fn() },
}));
vi.mock("./shell-integration.js", () => ({
  shellIntegration: async () => null,
  shellBinShimDir: async () => null,
}));
const pty = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("@lydell/node-pty", () => pty);

function windowFor(documentUrl: string) {
  const frame = { url: documentUrl };
  const contents = Object.assign(new EventEmitter(), {
    isDestroyed: (): boolean => false,
    getURL: () => frame.url,
    send: vi.fn(),
  });
  const webContents = contents as unknown as WebContents;
  const window = { webContents, isDestroyed: () => false };
  windows.push(window);
  return { contents, webContents, frame, window };
}

afterEach(() => {
  windows.length = 0;
  vi.useRealTimers();
  vi.restoreAllMocks();
});

it("sends terminal output, activity and exit only to authorized workspace documents", async () => {
  vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
  const documentUrl = "work-internal://shell/index.html";
  const owner = windowFor(documentUrl);
  const otherProfile = windowFor(documentUrl);
  const navigated = windowFor(documentUrl);
  const destroyed = windowFor(documentUrl);
  const unregistered = windowFor(documentUrl);
  for (const target of [owner, otherProfile, navigated, destroyed])
    registerShellContents({
      contents: target.webContents,
      documentUrl,
      surface: "workspace",
    });
  navigated.frame.url = "https://example.invalid";
  destroyed.contents.isDestroyed = () => true;

  // Voice's hidden audio page is trusted but has no Work profile. Voice's
  // bubble and the passkey sheet have profiles, but do not display terminals.
  const auxiliaries = [
    { surface: "voice", url: "work-internal://shell/voice.html" },
    { surface: "voice", url: `${documentUrl}?surface=voice` },
    { surface: "passkey-sheet", url: `${documentUrl}?surface=passkey` },
  ] as const;
  const auxiliaryWindows = auxiliaries.map(({ surface, url }) => {
    const target = windowFor(url);
    registerShellContents({
      contents: target.webContents,
      documentUrl: url,
      surface,
      channels: [],
    });
    return target;
  });
  // An auxiliary appearing before the workspace must not abort its delivery.
  windows.reverse();
  const profileFor = (sender: WebContents) => {
    if (sender === owner.webContents) return "owner";
    if (sender === otherProfile.webContents) return "other";
    throw new Error("This action requires a registered Work profile.");
  };
  const canAccessProject = vi.fn(
    (projectId: string, sender: WebContents) =>
      projectId === "project" && profileFor(sender) === "owner",
  );
  const events = new EventEmitter();
  pty.spawn.mockReturnValue({
    process: "",
    onData(callback: (data: string) => void) {
      events.on("data", callback);
      return { dispose: () => events.off("data", callback) };
    },
    onExit(callback: (exit: { exitCode: number }) => void) {
      events.on("exit", callback);
      return { dispose: () => events.off("exit", callback) };
    },
    kill: () => events.emit("exit", { exitCode: 0 }),
  });
  const support = registerTerminalSupport(
    { current: null, broadcast: () => {} },
    undefined,
    undefined,
    { canAccessProject, profileFor },
  );
  try {
    const { sessionId } = await support.agentTerminals.create(
      "project",
      "chat",
    );
    expect(() => events.emit("data", "\x1b]133;C\x07hello\r\n")).not.toThrow();
    expect(() => vi.advanceTimersByTime(500)).not.toThrow();
    expect(() => events.emit("exit", { exitCode: 3 })).not.toThrow();
    expect(owner.contents.send.mock.calls).toEqual([
      [
        "catamorphic:terminal-data",
        { sessionId, data: "\x1b]133;C\x07hello\r\n" },
      ],
      ["catamorphic:terminal-busy", { sessionId, busy: true }],
      ["catamorphic:terminal-busy", { sessionId, busy: false }],
      ["catamorphic:terminal-exit", { sessionId, exitCode: 3 }],
    ]);
    for (const target of [
      otherProfile,
      navigated,
      destroyed,
      unregistered,
      ...auxiliaryWindows,
    ])
      expect(target.contents.send).not.toHaveBeenCalled();
    expect(canAccessProject.mock.calls.map(([, sender]) => sender)).toEqual(
      Array.from({ length: 4 }, () => [
        otherProfile.webContents,
        owner.webContents,
      ]).flat(),
    );
  } finally {
    await support.dispose();
  }
});
