import type { WebContents } from "electron";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PopupPasskeySheets } from "./popup-passkey-sheets.js";
import { shellIpcMain } from "./shell-ipc.js";

const environment = vi.hoisted(async () => {
  const { EventEmitter } = await import("node:events");
  class Contents extends EventEmitter {
    static nextId = 0;
    id = ++Contents.nextId;
    url = "https://accounts.example.com";
    destroyed = false;
    mainFrame = {
      url: this.url,
      origin: "https://accounts.example.com",
      parent: null,
      detached: false,
    };
    getURL = () => this.url;
    getType = () => "browserView";
    isDestroyed = () => this.destroyed;
    isFocused = () => false;
    focus() {}
    setWindowOpenHandler() {}
    async loadURL(url: string) {
      this.url = url;
      this.mainFrame.url = url;
      this.mainFrame.origin = "work-internal://shell";
    }
    close() {
      this.destroyed = true;
      this.emit("destroyed");
    }
  }
  class Window extends EventEmitter {
    static all: Window[] = [];
    webContents = new Contents();
    contentView = { addChildView: vi.fn(), removeChildView: vi.fn() };
    constructor() {
      super();
      Window.all.push(this);
    }
    static fromWebContents(contents: Contents) {
      return Window.all.find((window) => window.webContents === contents);
    }
    isDestroyed = () => false;
    isFocused = () => true;
    getContentBounds = () => ({ width: 800, height: 600 });
  }
  class View {
    webContents = new Contents();
    setBackgroundColor() {}
    setBounds() {}
  }
  return {
    Contents,
    Window,
    View,
    handlers: new Map<string, (...args: unknown[]) => unknown>(),
  };
});
vi.mock("electron", async () => {
  const { Window, View, handlers } = await environment;
  return {
    app: { isPackaged: true },
    BrowserWindow: Window,
    WebContentsView: View,
    ipcMain: {
      handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
        handlers.set(channel, handler),
    },
  };
});
const fake = await environment;

beforeEach(() => {
  fake.Window.all = [];
  fake.handlers.clear();
});

describe("passkey sheet image admission", () => {
  it("lets the native sheet view ask for its existing site icon while its browsing popup stays unprivileged", () => {
    const popup = new fake.Window();
    const sheets = new PopupPasskeySheets({ attach: vi.fn() });
    const sheet = sheets.sheet(popup.webContents as unknown as WebContents);
    if (!sheet) throw new Error("No sheet created");
    const image = vi.fn(() => "data:image/png;base64,icon");
    shellIpcMain.handle("catamorphic:window-image", image);
    shellIpcMain.handle("catamorphic:terminal-create", vi.fn());
    const event = { sender: sheet, senderFrame: sheet.mainFrame };
    expect(
      fake.handlers.get("catamorphic:window-image")?.(event, {
        site: { page: "https://accounts.example.com" },
      }),
    ).toBe("data:image/png;base64,icon");
    expect(image).toHaveBeenCalledOnce();
    expect(() =>
      fake.handlers.get("catamorphic:window-image")?.(
        { sender: popup.webContents, senderFrame: popup.webContents.mainFrame },
        {},
      ),
    ).toThrow("trusted Work");
    expect(() =>
      fake.handlers.get("catamorphic:terminal-create")?.(event),
    ).toThrow("trusted Work");
    popup.emit("closed");
    expect(sheet.isDestroyed()).toBe(true);
  });
});
