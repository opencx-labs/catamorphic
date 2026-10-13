import { EventEmitter } from "node:events";
import { app, ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageDialog } from "../shared/page-dialogs.js";
import {
  type BrowserDialogsHost,
  pageDialogs,
  registerBrowserDialogs,
  scriptAnswer,
} from "./browser-dialogs.js";

const electron = vi.hoisted(() => ({
  handlers: new Map<string, (...args: unknown[]) => unknown>(),
  contents: new Map<number, unknown>(),
}));
vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  const ipcMain = Object.assign(new EventEmitter(), {
    handle: (channel: string, handler: (...args: unknown[]) => unknown) =>
      electron.handlers.set(channel, handler),
    removeHandler: (channel: string) => electron.handlers.delete(channel),
  });
  return {
    app: new EventEmitter(),
    ipcMain,
    webContents: { fromId: (id: number) => electron.contents.get(id) },
  };
});

class Window extends EventEmitter {
  id = 100;
  send = vi.fn();
  isDestroyed = () => false;
}

class Page extends EventEmitter {
  destroyed = false;
  url = "https://example.com/form";
  mainFrame = { origin: "https://example.com", parent: null };
  reload = vi.fn();
  reloadIgnoringCache = vi.fn();
  loadURL = vi.fn(async () => {});
  send = vi.fn();
  close = vi.fn();
  navigationHistory = { goBack: vi.fn(), goForward: vi.fn() };
  touched = true;
  executeJavaScriptInIsolatedWorld = vi.fn(async () => this.touched);
  constructor(
    public id: number,
    public hostWebContents: Window,
  ) {
    super();
    electron.contents.set(id, this);
  }
  getType = () => "webview";
  isDestroyed = () => this.destroyed;
  isCrashed = () => false;
  getURL = () => this.url;
}

const frame = (origin: string, parent: unknown = null, id = 1) => ({
  origin,
  parent,
  frameTreeNodeId: id,
});

/** A synchronous IPC as the page's preload sends it. */
const ask = (
  page: Page,
  payload: unknown,
  senderFrame = frame("https://example.com"),
) => {
  const event: { sender: Page; senderFrame: unknown; returnValue?: unknown } = {
    sender: page,
    senderFrame,
  };
  ipcMain.emit("catamorphic:page-dialog", event, payload);
  return event;
};
const invoke = (channel: string, sender: Window, input: unknown) =>
  electron.handlers.get(channel)?.({ sender }, input);
const flush = () => new Promise((resolve) => setImmediate(resolve));
const shown = (page: Page): PageDialog => {
  const dialog = pageDialogs()?.current(page.id);
  if (!dialog) throw new Error("No dialog shown");
  return dialog;
};

let dispose: () => void;
let host: BrowserDialogsHost;
let window: Window;
let page: Page;
beforeEach(() => {
  electron.handlers.clear();
  electron.contents.clear();
  host = {
    isTab: (guest) => guest.getType() === "webview",
    profileFor: () => "profile",
    vault: {
      list: vi.fn(async () => [
        { id: "saved", username: "ada", origin: "https://example.com" },
      ]),
      reveal: vi.fn(async () => ({ username: "ada", password: "secret" })),
    },
    offerToSave: vi.fn(),
  };
  dispose = registerBrowserDialogs(host);
  window = new Window();
  page = new Page(7, window);
  app.emit("web-contents-created", {}, page);
});
afterEach(() => {
  dispose();
  app.removeAllListeners();
  ipcMain.removeAllListeners();
});

describe("script dialogs", () => {
  it("keep the page waiting until the tab's dialog is answered", async () => {
    const event = ask(page, { kind: "confirm", message: "Delete it?" });
    expect(event).not.toHaveProperty("returnValue");
    expect(shown(page)).toMatchObject({
      kind: "confirm",
      message: "Delete it?",
      origin: "https://example.com",
      embedded: false,
    });
    expect(window.send).toHaveBeenLastCalledWith(
      "catamorphic:page-dialogs-changed",
      expect.objectContaining({ guestId: 7 }),
    );
    expect(
      invoke("catamorphic:page-dialog-answer", window, {
        id: shown(page).id,
        accept: true,
      }),
    ).toBe(true);
    await flush();
    expect(event.returnValue).toBe(true);
  });

  it("return what the page expects for each kind and answer", () => {
    expect(scriptAnswer("alert", { id: "a", accept: true })).toBeNull();
    expect(scriptAnswer("confirm", null)).toBe(false);
    expect(scriptAnswer("prompt", { id: "a", accept: true, text: "Ada" })).toBe(
      "Ada",
    );
    expect(scriptAnswer("prompt", { id: "a", accept: true })).toBe("");
    expect(scriptAnswer("prompt", { id: "a", accept: false })).toBeNull();
    expect(scriptAnswer("prompt", null)).toBeNull();
  });

  it("name an embedded frame of another site by its own origin", () => {
    ask(
      page,
      { kind: "alert", message: "From the frame" },
      frame("https://ads.example.net", {}, 2),
    );
    expect(shown(page)).toMatchObject({
      origin: "https://ads.example.net",
      embedded: true,
    });
  });

  it("answer at once for what is not a tab's page, and for a request that is not a dialog", () => {
    const other = new Page(8, window);
    host.isTab = (guest) => guest.id !== 8;
    const event = ask(other, { kind: "prompt", message: "?" });
    expect(event.returnValue).toBeNull();
    const bogus = ask(page, { kind: "auth", message: "spoof" });
    expect(bogus.returnValue).toBeNull();
    expect(pageDialogs()?.has(page.id)).toBe(false);
  });

  it("are cancelled when the page navigates or its tab closes", async () => {
    const confirm = ask(page, { kind: "confirm", message: "Stay?" });
    page.emit("did-start-navigation", {
      isSameDocument: false,
      isMainFrame: true,
      frame: null,
    });
    await flush();
    expect(confirm.returnValue).toBe(false);
    const prompt = ask(page, { kind: "prompt", message: "Name?" });
    page.destroyed = true;
    page.emit("destroyed");
    await flush();
    expect(prompt.returnValue).toBeNull();
  });

  it("only answer a dialog to the window that shows it", () => {
    ask(page, { kind: "alert", message: "Hi" });
    expect(
      invoke("catamorphic:page-dialog-answer", new Window(), {
        id: shown(page).id,
        accept: true,
      }),
    ).toBe(false);
    expect(pageDialogs()?.has(page.id)).toBe(true);
  });
});

describe("Leave site?", () => {
  it("keeps the page, asks, and on Leave does again what was leaving it", async () => {
    ipcMain.emit(
      "catamorphic:browser-unload-intent",
      { sender: window },
      { guestId: 7, intent: { kind: "reload" } },
    );
    const unload = { preventDefault: vi.fn() };
    page.emit("will-prevent-unload", unload);
    expect(unload.preventDefault).not.toHaveBeenCalled();
    expect(shown(page)).toMatchObject({ kind: "beforeunload", reload: true });
    // A second press asks the same question.
    page.emit("will-prevent-unload", { preventDefault: vi.fn() });
    expect(pageDialogs()?.list(page.id)).toHaveLength(1);

    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
    });
    await flush();
    expect(page.reload).toHaveBeenCalled();
    // The redone reload goes through.
    const again = { preventDefault: vi.fn() };
    page.emit("will-prevent-unload", again);
    expect(again.preventDefault).toHaveBeenCalled();
  });

  it("goes on to the address, or to the page's own navigation", async () => {
    ipcMain.emit(
      "catamorphic:browser-unload-intent",
      { sender: window },
      { guestId: 7, intent: { kind: "navigate", url: "https://next.test/" } },
    );
    page.emit("will-prevent-unload", { preventDefault: vi.fn() });
    expect(shown(page).reload).toBe(false);
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
    });
    await flush();
    expect(page.loadURL).toHaveBeenCalledWith("https://next.test/");

    page.emit("did-navigate", {}, "https://next.test/", 200);
    ipcMain.emit("catamorphic:page-navigating", {
      sender: page,
      senderFrame: frame("https://example.com"),
    });
    page.emit("will-prevent-unload", { preventDefault: vi.fn() });
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
    });
    await flush();
    expect(page.send).toHaveBeenCalledWith("catamorphic:page-proceed");
  });

  it("stays on Cancel", async () => {
    ipcMain.emit(
      "catamorphic:browser-unload-intent",
      { sender: window },
      { guestId: 7, intent: { kind: "back" } },
    );
    page.emit("will-prevent-unload", { preventDefault: vi.fn() });
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: false,
    });
    await flush();
    expect(page.navigationHistory.goBack).not.toHaveBeenCalled();
    const next = { preventDefault: vi.fn() };
    page.emit("will-prevent-unload", next);
    expect(next.preventDefault).not.toHaveBeenCalled();
  });

  it("asks before a tab the person touched closes, and tells the window the answer", async () => {
    page.touched = false;
    await expect(
      invoke("catamorphic:browser-close-ask", window, { guestId: 7 }),
    ).resolves.toBe("close");
    expect(page.close).not.toHaveBeenCalled();

    page.touched = true;
    await expect(
      invoke("catamorphic:browser-close-ask", window, { guestId: 7 }),
    ).resolves.toBe("asking");
    expect(page.close).toHaveBeenCalledWith({ waitForBeforeUnload: true });
    page.emit("will-prevent-unload", { preventDefault: vi.fn() });
    expect(shown(page)).toMatchObject({ kind: "beforeunload", reload: false });
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
    });
    await flush();
    expect(window.send).toHaveBeenCalledWith(
      "catamorphic:browser-close-answer",
      { guestId: 7, leave: true },
    );
  });

  it("keeps a tab whose page holds its close, which Electron would close anyway", async () => {
    await invoke("catamorphic:browser-close-ask", window, { guestId: 7 });
    const held = { preventDefault: vi.fn() };
    page.emit("-before-unload-fired", held, false);
    expect(held.preventDefault).toHaveBeenCalled();
    // A page that lets go closes; a page not being closed is not touched.
    const letGo = { preventDefault: vi.fn() };
    page.emit("-before-unload-fired", letGo, true);
    expect(letGo.preventDefault).not.toHaveBeenCalled();
    page.emit("did-navigate", {}, "https://example.com/next", 200);
    const navigating = { preventDefault: vi.fn() };
    page.emit("-before-unload-fired", navigating, false);
    expect(navigating.preventDefault).not.toHaveBeenCalled();
  });

  it("lets a page waiting on its own dialog close at once", async () => {
    ask(page, { kind: "alert", message: "Hi" });
    await expect(
      invoke("catamorphic:browser-close-ask", window, { guestId: 7 }),
    ).resolves.toBe("close");
  });
});

describe("sign-ins", () => {
  const authInfo = {
    isProxy: false,
    scheme: "basic",
    host: "example.com",
    port: 443,
    realm: "Staff",
  };
  const details = {
    url: "https://example.com/private",
    pid: 0,
    isRequestForNavigation: true,
    firstAuthAttempt: true,
    isMainFrame: true,
  };
  const login = (overrides: Partial<typeof details> = {}) => {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    page.emit("login", event, { ...details, ...overrides }, authInfo, callback);
    return { event, callback };
  };

  it("ask in the tab, sign in with what was typed, and offer to save it once it lands", async () => {
    const { event, callback } = login();
    expect(event.preventDefault).toHaveBeenCalled();
    await flush();
    expect(shown(page)).toMatchObject({
      kind: "auth",
      origin: "https://example.com",
      auth: {
        realm: "Staff",
        proxy: false,
        insecure: false,
        retry: false,
        saved: [{ id: "saved", username: "ada" }],
      },
    });
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
      username: "grace",
      password: "hopper",
    });
    await flush();
    expect(callback).toHaveBeenCalledWith("grace", "hopper");
    page.emit("did-navigate", {}, "https://example.com/private", 200);
    expect(host.offerToSave).toHaveBeenCalledWith(
      expect.objectContaining({
        origin: "https://example.com",
        username: "grace",
        password: "hopper",
      }),
    );
  });

  it("cancel like Chrome, and ask again with the username after a refusal", async () => {
    const first = login();
    await flush();
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
      username: "grace",
      password: "wrong",
    });
    await flush();
    expect(first.callback).toHaveBeenCalledWith("grace", "wrong");
    const retry = login({ firstAuthAttempt: false });
    await flush();
    expect(shown(page).auth).toMatchObject({ retry: true, username: "grace" });
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: false,
    });
    await flush();
    expect(retry.callback).toHaveBeenCalledWith();
    // Cancelled: the 401 page shows, and nothing was offered for saving.
    page.emit("did-navigate", {}, "https://example.com/private", 401);
    expect(host.offerToSave).not.toHaveBeenCalled();
  });

  it("sign in with a saved sign-in, read from the vault in main", async () => {
    const { callback } = login();
    await flush();
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
      credentialId: "saved",
    });
    await flush();
    await flush();
    expect(host.vault.reveal).toHaveBeenCalledWith("profile", "saved");
    expect(callback).toHaveBeenCalledWith("ada", "secret");
  });

  it("name a proxy that asks, offer no site's sign-ins, and save nothing", async () => {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    page.emit(
      "login",
      event,
      details,
      {
        isProxy: true,
        scheme: "digest",
        host: "proxy.lan",
        port: 3128,
        realm: "",
      },
      callback,
    );
    await flush();
    expect(shown(page)).toMatchObject({
      kind: "auth",
      origin: "http://proxy.lan:3128",
      auth: { proxy: true, scheme: "digest", insecure: false, saved: [] },
    });
    expect(host.vault.list).not.toHaveBeenCalled();
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
      username: "me",
      password: "proxy-secret",
    });
    await flush();
    expect(callback).toHaveBeenCalledWith("me", "proxy-secret");
    page.emit("did-navigate", {}, "https://example.com/private", 200);
    expect(host.offerToSave).not.toHaveBeenCalled();
  });

  it("never ask for another site's subresource", async () => {
    const { callback } = login({
      url: "https://elsewhere.test/pixel.png",
      isRequestForNavigation: false,
    });
    await flush();
    expect(pageDialogs()?.has(page.id)).toBe(false);
    expect(callback).toHaveBeenCalledWith();
  });
});
