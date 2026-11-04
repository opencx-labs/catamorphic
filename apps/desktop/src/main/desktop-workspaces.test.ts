import { EventEmitter } from "node:events";
import {
  app,
  autoUpdater,
  type BrowserWindow,
  type WebContents,
} from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_PREFS } from "../shared/app-prefs.js";
import { SHELL_WINDOW_CLOSE_CHANNEL } from "../shared/desktop-workspace.js";
import { DesktopWorkspaces } from "./desktop-workspaces.js";

const native = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  listeners: new Map<string, (...args: unknown[]) => unknown>(),
  focused: null as BrowserWindow | null,
  all: [] as BrowserWindow[],
}));
vi.mock("./shell-ipc.js", () => ({
  shellIpcMain: {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      native.handlers.set(channel, handler),
    on: (channel: string, handler: (...args: unknown[]) => unknown) =>
      native.listeners.set(channel, handler),
  },
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const area = { x: 0, y: 0, width: 1200, height: 800 };
  return {
    app: new EventEmitter(),
    autoUpdater: new EventEmitter(),
    dialog: {},
    BrowserWindow: {
      getAllWindows: () => native.all,
      getFocusedWindow: () => native.focused,
      fromWebContents: (contents: WebContents) =>
        native.all.find((window) => window.webContents === contents),
    },
    screen: {
      getCursorScreenPoint: () => ({ x: 0, y: 0 }),
      getDisplayNearestPoint: () => ({ workArea: area }),
      getDisplayMatching: () => ({ workArea: area }),
    },
  };
});

function fixture() {
  const owned = new Map<WebContents, string>();
  let nextId = 0;
  const window = (profileId?: string) => {
    const contents = Object.assign(new EventEmitter(), {
      id: ++nextId,
      send: vi.fn(),
      isDestroyed: () => false,
    });
    const fake = Object.assign(new EventEmitter(), {
      webContents: contents,
      isDestroyed: () => false,
      isVisible: () => true,
      isMinimized: () => false,
      getBounds: () => ({ x: 0, y: 0, width: 780, height: 124 }),
      setBounds: vi.fn(),
      setPosition: vi.fn(),
      setAlwaysOnTop: vi.fn(),
      setVisibleOnAllWorkspaces: vi.fn(),
      showInactive: vi.fn(),
      hide: vi.fn(),
      close: vi.fn(),
    });
    const result = fake as unknown as BrowserWindow;
    native.all.push(result);
    if (profileId) owned.set(result.webContents, profileId);
    return result;
  };
  const profileFor = vi.fn((contents: WebContents) => {
    const profileId = owned.get(contents);
    if (!profileId) throw new Error("Unregistered browsing window");
    return profileId;
  });
  const options = {
    windows: {
      profileFor,
      windowsFor: (profileId: string) =>
        native.all.filter(
          (candidate) => owned.get(candidate.webContents) === profileId,
        ),
    },
    config: {
      onPrefsChanged: () => {},
      forProfile: () => ({ prefs: { load: () => DEFAULT_PREFS } }),
    },
    windowState: { changed: vi.fn() },
    profileForProject: () => "profile",
    projectExists: async () => true,
    onQuitCancelled: () => {},
    createWindow: (profileId: string) => window(profileId),
  } as unknown as ConstructorParameters<typeof DesktopWorkspaces>[0];
  const workspaces = new DesktopWorkspaces(options);
  return { window, profileFor, workspaces };
}

beforeEach(() => {
  app.removeAllListeners();
  autoUpdater.removeAllListeners();
  native.handlers.clear();
  native.listeners.clear();
  native.all = [];
  native.focused = null;
});

describe("workspace focus ownership", () => {
  it("routes only native-owned workspace/dock close requests through BrowserWindow.close", () => {
    const { window, workspaces } = fixture();
    const workspace = window("profile");
    const auxiliary = window("profile");
    const popup = window();
    workspaces.track(workspace);
    const close = native.listeners.get(SHELL_WINDOW_CLOSE_CHANNEL);
    close?.({ sender: workspace.webContents });
    expect(workspace.close).toHaveBeenCalledOnce();
    close?.({ sender: auxiliary.webContents });
    close?.({ sender: popup.webContents });
    expect(auxiliary.close).not.toHaveBeenCalled();
    expect(popup.close).not.toHaveBeenCalled();
    native.handlers.get("catamorphic:dock-detach")?.(
      { sender: workspace.webContents },
      true,
    );
    const dock = native.all.at(-1);
    if (!dock) throw new Error("No dock created");
    close?.({ sender: dock.webContents });
    expect(dock.close).toHaveBeenCalledOnce();
  });
  it("ignores focused sign-in popups and auxiliary windows before consulting the strict profile registry", () => {
    const { window, profileFor, workspaces } = fixture();
    const workspace = window("profile");
    workspaces.track(workspace);
    const popup = window();
    const auxiliary = window("profile");
    profileFor.mockClear();
    for (const foreign of [popup, auxiliary]) {
      native.focused = foreign;
      expect(() => app.emit("browser-window-focus", {}, foreign)).not.toThrow();
      expect(workspaces.target()).toBe(workspace.webContents);
      expect(profileFor).not.toHaveBeenCalledWith(foreign.webContents);
    }
  });

  it("keeps tracked workspace and dock focus behavior, and retains the workspace target while a popup is focused", () => {
    const { window, profileFor, workspaces } = fixture();
    const first = window("first");
    const second = window("second");
    workspaces.track(first);
    workspaces.track(second);
    native.focused = first;
    app.emit("browser-window-focus", {}, first);
    expect(workspaces.target()).toBe(first.webContents);
    native.handlers.get("catamorphic:dock-detach")?.(
      { sender: first.webContents },
      true,
    );
    const dock = native.all.at(-1);
    if (!dock) throw new Error("No dock created");
    expect(workspaces.isDock(dock)).toBe(true);
    native.focused = dock;
    app.emit("browser-window-focus", {}, dock);
    expect(workspaces.target()).toBe(dock.webContents);
    const popup = window();
    native.focused = popup;
    expect(() => app.emit("browser-window-focus", {}, popup)).not.toThrow();
    expect(workspaces.target()).toBe(dock.webContents);
    expect(profileFor).not.toHaveBeenCalledWith(popup.webContents);
  });
});
