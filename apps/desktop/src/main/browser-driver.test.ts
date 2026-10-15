import { EventEmitter } from "node:events";
import { app, ipcMain, type WebContents } from "electron";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pageDialogs, registerBrowserDialogs } from "./browser-dialogs.js";
import { BrowserDriver } from "./browser-driver.js";

/** Which of Work's windows is in front, and which one holds the page. */
const windows = vi.hoisted(() => ({
  front: null as string | null,
  page: "page",
  focused: null as unknown,
}));

vi.mock("electron", async () => {
  const { EventEmitter } = await import("node:events");
  return {
    app: new EventEmitter(),
    BrowserWindow: {
      getFocusedWindow: () => windows.front,
      fromWebContents: () => windows.page,
    },
    ipcMain: Object.assign(new EventEmitter(), {
      handle: () => {},
      removeHandler: () => {},
    }),
    webContents: {
      fromId: () => undefined,
      getFocusedWebContents: () => windows.focused,
    },
  };
});

/** A tab's page whose scripts answer only when the test says. */
class Guest extends EventEmitter {
  id = 9;
  hostWebContents = { isDestroyed: () => false, focus: vi.fn() };
  debugger = {
    isAttached: () => true,
    attach: vi.fn(),
    sendCommand: vi.fn(async (_method: string, _params?: unknown) => ({})),
    on: vi.fn(),
    once: vi.fn(),
    off: vi.fn(),
  };
  /** Scripts the page has not answered yet. */
  waiting: Array<(value: unknown) => void> = [];
  executeJavaScriptInIsolatedWorld = vi.fn(
    () => new Promise((resolve) => this.waiting.push(resolve)),
  );
  selectAll = vi.fn();
  insertText = vi.fn(async () => {});
  focus = vi.fn();
  isDestroyed = () => false;
  getURL = () => "https://example.com/";
  getTitle = () => "Example";
}

/** The fake, where the driver takes a WebContents. */
const field: string = "guest";
const asWebContents = (guest: Guest): WebContents =>
  Reflect.get({ guest }, field);
const openDialog = (guestId: number) =>
  void pageDialogs()?.ask({
    guestId,
    kind: "alert",
    origin: "https://example.com",
    embedded: false,
    message: "Wait",
    defaultValue: "",
    reload: false,
  });
const flush = () => new Promise((resolve) => setImmediate(resolve));

let dispose: () => void;
beforeEach(() => {
  dispose = registerBrowserDialogs({
    isTab: () => true,
    profileFor: () => "profile",
    vault: { list: async () => [], reveal: async () => null },
    offerToSave: () => {},
  });
});
afterEach(() => {
  windows.front = null;
  windows.focused = null;
  dispose();
  app.removeAllListeners();
  ipcMain.removeAllListeners();
});

describe("browser driver and page dialogs", () => {
  it("clears pointers without waiting on a page that waits on its dialog", async () => {
    const guest = new Guest();
    const driver = new BrowserDriver(
      asWebContents(guest),
      () => {},
      async () => {},
    );
    openDialog(guest.id);
    await expect(driver.clear()).resolves.toMatchObject({
      dialog: { kind: "alert", message: "Wait" },
    });
    expect(guest.executeJavaScriptInIsolatedWorld).not.toHaveBeenCalled();
  });

  it("reports a dialog an action opens, and the action types nothing once it is answered", async () => {
    const guest = new Guest();
    const driver = new BrowserDriver(
      asWebContents(guest),
      () => {},
      async () => {},
    );
    const acting = driver.act({ type: "fill", uid: "field", text: "secret" });
    // Focusing the field (the driver's "prepare") made the page alert.
    await flush();
    expect(guest.waiting).toHaveLength(1);
    openDialog(guest.id);
    await expect(acting).resolves.toMatchObject({ dialog: { kind: "alert" } });
    // The page answers once its dialog is: the fill goes no further.
    guest.waiting[0]?.({ value: { x: 1, y: 1 } });
    await flush();
    await flush();
    expect(guest.selectAll).not.toHaveBeenCalled();
    expect(guest.insertText).not.toHaveBeenCalled();
    // The queue went on meanwhile: the next look reports the dialog at once.
    await expect(driver.snapshot()).resolves.toMatchObject({
      dialog: { kind: "alert" },
    });
  });

  it("answers only a dialog the agent was shown: a press or address meant for the page reports a new one instead", async () => {
    const guest = new Guest();
    const driver = new BrowserDriver(
      asWebContents(guest),
      () => {},
      async () => {},
    );
    // The person closes the tab while the agent works: "Leave site?".
    void pageDialogs()?.ask({
      guestId: guest.id,
      kind: "beforeunload",
      origin: "https://example.com",
      embedded: false,
      message: "",
      defaultValue: "",
      reload: false,
    });
    await expect(
      driver.act({ type: "press", key: "Enter" }),
    ).resolves.toMatchObject({ dialog: { kind: "beforeunload" } });
    expect(pageDialogs()?.current(guest.id)?.kind).toBe("beforeunload");
    // Shown now: the agent's next press answers it as the person would.
    await expect(driver.act({ type: "press", key: "Escape" })).resolves.toEqual(
      { ok: true, answered: "beforeunload", accepted: false },
    );
    expect(pageDialogs()?.has(guest.id)).toBe(false);

    // Going elsewhere does not cancel a dialog it never saw either.
    openDialog(guest.id);
    await expect(
      driver.act({ type: "navigate", url: "https://example.com/next" }),
    ).resolves.toMatchObject({ dialog: { kind: "alert" } });
    expect(pageDialogs()?.current(guest.id)?.kind).toBe("alert");
    await expect(driver.act({ type: "press", key: "Enter" })).resolves.toEqual({
      ok: true,
      answered: "alert",
      accepted: true,
    });

    // One dialog seen does not let it answer the next one unseen.
    openDialog(guest.id);
    await expect(
      driver.act({ type: "fill", uid: "dialog", text: "x" }),
    ).resolves.toMatchObject({ dialog: { kind: "alert" } });
    expect(pageDialogs()?.has(guest.id)).toBe(true);
  });
});

describe("browser driver and window focus", () => {
  const focusEmulation = (guest: Guest) =>
    guest.debugger.sendCommand.mock.calls.flatMap(([method, params]) =>
      method === "Emulation.setFocusEmulationEnabled" ? [params] : [],
    );
  const read = async (guest: Guest) => {
    const driver = new BrowserDriver(
      asWebContents(guest),
      () => {},
      async () => {},
    );
    const reading = driver.read();
    await flush();
    guest.waiting[0]?.({ value: { text: "Hello" } });
    await expect(reading).resolves.toEqual({ text: "Hello" });
  };

  it("leaves focus in the person's window when the page is in another, telling the page it has focus", async () => {
    windows.front = "person";
    const person = { isDestroyed: () => false, focus: vi.fn() };
    windows.focused = person;
    const guest = new Guest();
    await read(guest);
    // Focusing the page would focus its window too, and handing focus
    // back would focus the person's: the two windows traded places.
    expect(guest.focus).not.toHaveBeenCalled();
    expect(guest.hostWebContents.focus).not.toHaveBeenCalled();
    expect(person.focus).not.toHaveBeenCalled();
    expect(focusEmulation(guest)).toEqual([
      { enabled: true },
      { enabled: false },
    ]);
  });

  it("focuses the page in the person's own window and hands focus back after", async () => {
    windows.front = "page";
    const composer = { isDestroyed: () => false, focus: vi.fn() };
    windows.focused = composer;
    const guest = new Guest();
    await read(guest);
    expect(guest.focus).toHaveBeenCalledTimes(1);
    expect(composer.focus).toHaveBeenCalledTimes(1);
    expect(focusEmulation(guest)).toEqual([]);
  });

  it("focuses the page while no window of Work's is in front", async () => {
    const guest = new Guest();
    await read(guest);
    expect(guest.focus).toHaveBeenCalledTimes(1);
    expect(guest.hostWebContents.focus).toHaveBeenCalledTimes(1);
    expect(focusEmulation(guest)).toEqual([]);
  });
});
