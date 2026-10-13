import { EventEmitter } from "node:events";
import { app, ipcMain } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PageDialog } from "../shared/page-dialogs.js";
import {
  type BrowserDialogsHost,
  pageClosing,
  pageDialogs,
  registerBrowserDialogs,
  scriptAnswer,
} from "./browser-dialogs.js";
import { PAGE_DIALOG_QUEUE_LIMIT } from "./page-dialogs.js";

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

/** A frame as main sees it (WebFrameMain). */
class Frame {
  detached = false;
  destroyed = false;
  processId = 1;
  frameToken: string;
  constructor(
    public origin: string,
    public parent: Frame | null,
    public frameTreeNodeId: number,
  ) {
    this.frameToken = `token-${frameTreeNodeId}`;
  }
  isDestroyed = () => this.destroyed;
}

class Page extends EventEmitter {
  destroyed = false;
  url = "https://example.com/form";
  top = new Frame("https://example.com", null, 1);
  /** The frames of the page the tab shows now. */
  frames: Frame[] = [this.top];
  get mainFrame() {
    return {
      origin: this.top.origin,
      parent: null,
      framesInSubtree: this.frames,
    };
  }
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

/** An embedded frame of the page. */
const embed = (target: Page, origin: string, id = 2) => {
  const frame = new Frame(origin, target.top, id);
  target.frames.push(frame);
  return frame;
};

/** A synchronous IPC as the page's preload sends it. */
const ask = (page: Page, payload: unknown, senderFrame: Frame = page.top) => {
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
      embed(page, "https://ads.example.net"),
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

  it("refuse a frame that is no longer the tab's page, or one without an origin", () => {
    // The page left; its frame unloads after the next one committed.
    const gone = new Frame("https://evil.test", null, 1);
    gone.frameToken = "old-page";
    expect(
      ask(page, { kind: "prompt", message: "Bank password?" }, gone),
    ).toHaveProperty("returnValue", null);
    const detached = embed(page, "https://example.com", 3);
    detached.detached = true;
    expect(
      ask(page, { kind: "confirm", message: "?" }, detached),
    ).toHaveProperty("returnValue", false);
    // A sandboxed (opaque) frame, as Chrome without allow-modals.
    const sandboxed = embed(page, "null", 4);
    expect(
      ask(page, { kind: "alert", message: "Hi" }, sandboxed),
    ).toHaveProperty("returnValue", null);
    expect(pageDialogs()?.has(page.id)).toBe(false);
  });

  it("are cancelled when their frame goes", async () => {
    const frame = embed(page, "https://ads.example.net");
    const event = ask(page, { kind: "confirm", message: "Still here?" }, frame);
    expect(pageDialogs()?.has(page.id)).toBe(true);
    frame.destroyed = true;
    await new Promise((resolve) => setTimeout(resolve, 600));
    expect(event.returnValue).toBe(false);
    expect(pageDialogs()?.has(page.id)).toBe(false);
  });

  it("are cancelled by the tab going somewhere else", async () => {
    const event = ask(page, { kind: "prompt", message: "Name?" });
    ipcMain.emit(
      "catamorphic:browser-unload-intent",
      { sender: window },
      { guestId: 7, intent: { kind: "navigate", url: "https://next.test/" } },
    );
    await flush();
    expect(event.returnValue).toBeNull();
  });

  it("keep a dialog whose answer main refuses", () => {
    ask(page, { kind: "prompt", message: "Long?" });
    expect(
      invoke("catamorphic:page-dialog-answer", window, {
        id: shown(page).id,
        accept: true,
        text: "x".repeat(20_001),
      }),
    ).toBe(false);
    expect(pageDialogs()?.has(page.id)).toBe(true);
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
    ipcMain.emit(
      "catamorphic:page-navigating",
      { sender: page, senderFrame: page.top },
      { reload: false },
    );
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

  it("asks again about the latest attempt, and Leave does what the title says", async () => {
    const now = vi.spyOn(Date, "now");
    try {
      now.mockReturnValue(10_000);
      ipcMain.emit(
        "catamorphic:page-navigating",
        { sender: page, senderFrame: page.top },
        { reload: false },
      );
      page.emit("will-prevent-unload", { preventDefault: vi.fn() });
      expect(shown(page).reload).toBe(false);
      // Two seconds on, the person reloads instead.
      now.mockReturnValue(12_000);
      ipcMain.emit(
        "catamorphic:browser-unload-intent",
        { sender: window },
        { guestId: 7, intent: { kind: "reload" } },
      );
      page.emit("will-prevent-unload", { preventDefault: vi.fn() });
      expect(pageDialogs()?.list(page.id)).toHaveLength(1);
      expect(shown(page).reload).toBe(true);
      invoke("catamorphic:page-dialog-answer", window, {
        id: shown(page).id,
        accept: true,
      });
      await flush();
      expect(page.reload).toHaveBeenCalled();
      expect(page.send).not.toHaveBeenCalledWith("catamorphic:page-proceed");
    } finally {
      now.mockRestore();
    }
  });

  it("forgets what a navigation that went ahead was for", async () => {
    ipcMain.emit(
      "catamorphic:browser-unload-intent",
      { sender: window },
      { guestId: 7, intent: { kind: "reload" } },
    );
    page.emit("did-start-navigation", {
      isSameDocument: false,
      isMainFrame: true,
      url: "https://example.com/form",
      frame: null,
    });
    page.emit("will-prevent-unload", { preventDefault: vi.fn() });
    expect(shown(page).reload).toBe(false);
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
    });
    await flush();
    expect(page.reload).not.toHaveBeenCalled();
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
    expect(pageClosing(7)).toBe(true);
    page.emit("will-prevent-unload", { preventDefault: vi.fn() });
    expect(shown(page)).toMatchObject({ kind: "beforeunload", reload: false });
    // A tab closed in the background comes forward to ask.
    expect(window.send).toHaveBeenCalledWith(
      "catamorphic:browser-reveal-guest",
      { guestId: 7 },
    );
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
    });
    await flush();
    expect(window.send).toHaveBeenCalledWith(
      "catamorphic:browser-close-answer",
      { guestId: 7, leave: true },
    );
    expect(pageClosing(7)).toBe(false);
  });

  it("keeps the page loaded while its tab closes, whatever Electron would do", async () => {
    await invoke("catamorphic:browser-close-ask", window, { guestId: 7 });
    // Held: the page stays, and "Leave site?" decides.
    const held = { preventDefault: vi.fn() };
    page.emit("-before-unload-fired", held, false);
    expect(held.preventDefault).toHaveBeenCalled();
    expect(window.send).not.toHaveBeenCalledWith(
      "catamorphic:browser-close-answer",
      expect.anything(),
    );
    // Let go: still not unloaded here; the tab leaves with its own exit.
    const letGo = { preventDefault: vi.fn() };
    page.emit("-before-unload-fired", letGo, true);
    expect(letGo.preventDefault).toHaveBeenCalled();
    expect(window.send).toHaveBeenCalledWith(
      "catamorphic:browser-close-answer",
      { guestId: 7, leave: true },
    );
    // A page not being closed is left to Electron.
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
  };
  const login = (
    overrides: Partial<typeof details> = {},
    info: typeof authInfo = authInfo,
  ) => {
    const event = { preventDefault: vi.fn() };
    const callback = vi.fn();
    page.emit("login", event, { ...details, ...overrides }, info, callback);
    return { event, callback };
  };
  // The tab's own navigation to the page that asks.
  beforeEach(() => {
    page.emit("did-start-navigation", {
      isSameDocument: false,
      isMainFrame: true,
      url: details.url,
      frame: null,
    });
  });

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

  it("ask once for many requests of one sign-in, and answer them all", async () => {
    const requests = Array.from({ length: PAGE_DIALOG_QUEUE_LIMIT * 3 }, () =>
      login({ url: "https://example.com/api", isRequestForNavigation: false }),
    );
    await flush();
    expect(pageDialogs()?.list(page.id)).toHaveLength(1);
    expect(host.vault.list).toHaveBeenCalledTimes(1);
    invoke("catamorphic:page-dialog-answer", window, {
      id: shown(page).id,
      accept: true,
      username: "grace",
      password: "hopper",
    });
    await flush();
    for (const { callback } of requests)
      expect(callback).toHaveBeenCalledWith("grace", "hopper");
  });

  it("say when an embedded page of another site asks, and save nothing for it", async () => {
    const { callback } = login({ url: "https://bank.test/frame" });
    await flush();
    expect(shown(page)).toMatchObject({
      origin: "https://bank.test",
      embedded: true,
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
    expect(host.offerToSave).not.toHaveBeenCalled();
  });

  it("refuse other sites' subresources for a page without an origin", async () => {
    page.top.origin = "null";
    const { callback } = login({
      url: "https://elsewhere.test/pixel.png",
      isRequestForNavigation: false,
    });
    await flush();
    expect(pageDialogs()?.has(page.id)).toBe(false);
    expect(callback).toHaveBeenCalledWith();
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
