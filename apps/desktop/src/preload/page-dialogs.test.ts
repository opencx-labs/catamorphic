// @vitest-environment jsdom

import { contextBridge, ipcRenderer } from "electron";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  PAGE_DIALOG_MESSAGE_LIMIT,
  SCRIPT_DIALOG_QUIET_MS,
  type ScriptDialogRequest,
} from "../shared/script-dialogs.js";
import {
  FrameDialogs,
  installPageDialogs,
  replaceScriptDialogs,
} from "./page-dialogs.js";

vi.mock("electron", () => ({
  contextBridge: { executeInMainWorld: vi.fn() },
  ipcRenderer: { sendSync: vi.fn(), send: vi.fn(), on: vi.fn() },
}));

/** A frame whose trips to main the test answers and counts. */
const frameAnswering = (
  replies: unknown[],
  options: { never?: boolean } = {},
) => {
  const sent: ScriptDialogRequest[] = [];
  let now = 1_000;
  const frame = new FrameDialogs({
    never: options.never ?? false,
    send: (request) => {
      sent.push(request);
      return replies.shift();
    },
    now: () => now,
  });
  return {
    frame,
    sent,
    later: (ms: number) => {
      now += ms;
    },
  };
};

/** Taken before a test replaces it, as the page may. */
const apply = Reflect.apply;
/** One of the page's own functions as it calls it, with any arguments. */
const pageFunction = (
  name: "alert" | "confirm" | "prompt",
): ((...args: unknown[]) => unknown) => {
  const value: unknown = Reflect.get(window, name);
  if (typeof value !== "function") throw new Error(`No ${name}`);
  return (...args) => apply(value, window, args);
};
/** The page's functions as it sees them, after the preload replaced them. */
const pageFunctions = () => ({
  alert: pageFunction("alert"),
  confirm: pageFunction("confirm"),
  prompt: pageFunction("prompt"),
});

describe("a frame's dialogs in the preload", () => {
  it("send main only text it can show, and answer the page with main's answer", () => {
    const { frame, sent } = frameAnswering([
      { answer: true },
      { answer: "Ada" },
      { answer: { not: "an answer" } },
      "garbage",
    ]);
    expect(frame.ask("confirm", "x".repeat(5e5), undefined)).toBe(true);
    expect(sent[0]).toEqual({
      kind: "confirm",
      message: "x".repeat(PAGE_DIALOG_MESSAGE_LIMIT),
      defaultValue: "",
    });
    expect(frame.ask("prompt", "Name?", { toString: () => "spoof" })).toBe(
      "Ada",
    );
    expect(sent[1]?.defaultValue).toBe("");
    expect(frame.ask("alert", "Hi", "")).toBeNull();
    expect(frame.ask("confirm", "Hi", "")).toBeNull();
    // Not one of the page's dialogs: nothing is sent.
    expect(frame.ask("beforeunload", "Leave?", "")).toBeNull();
    expect(sent).toHaveLength(4);
  });

  it("never asks main from an opaque embedded frame", () => {
    const { frame, sent } = frameAnswering([], { never: true });
    for (let index = 0; index < 100; index++)
      expect(frame.ask("alert", "x", "")).toBeNull();
    frame.shown(true);
    expect(frame.ask("alert", "x", "")).toBeNull();
    expect(sent).toHaveLength(0);
  });

  it("stops asking once main refuses the document, until it comes back from the back/forward cache", () => {
    const { frame, sent } = frameAnswering([
      { refused: "document" },
      { answer: true },
    ]);
    expect(frame.ask("confirm", "One?", "")).toBeNull();
    for (let index = 0; index < 1000; index++)
      expect(frame.ask("confirm", "More?", "")).toBeNull();
    expect(sent).toHaveLength(1);
    // A new load in the same tab (pageshow without the cache) changes nothing.
    frame.shown(false);
    expect(frame.ask("confirm", "More?", "")).toBeNull();
    expect(sent).toHaveLength(1);
    frame.shown(true);
    expect(frame.ask("confirm", "Back?", "")).toBe(true);
    expect(sent).toHaveLength(2);
  });

  it("waits before asking again when main refuses for now", () => {
    const { frame, sent, later } = frameAnswering([
      { refused: "busy" },
      { refused: "busy" },
      { answer: "yes" },
    ]);
    expect(frame.ask("prompt", "?", "")).toBeNull();
    for (let index = 0; index < 1000; index++) frame.ask("prompt", "?", "");
    expect(sent).toHaveLength(1);
    later(SCRIPT_DIALOG_QUIET_MS);
    expect(frame.ask("prompt", "?", "")).toBeNull();
    expect(sent).toHaveLength(2);
    later(SCRIPT_DIALOG_QUIET_MS - 1);
    frame.ask("prompt", "?", "");
    expect(sent).toHaveLength(2);
    later(1);
    expect(frame.ask("prompt", "?", "")).toBe("yes");
    expect(sent).toHaveLength(3);
  });

  it("asks nothing from pagehide on, until the page shows again", () => {
    const { frame, sent } = frameAnswering([{ answer: true }]);
    frame.hidden();
    expect(frame.ask("confirm", "Hidden?", "")).toBeNull();
    expect(sent).toHaveLength(0);
    frame.shown(false);
    expect(frame.ask("confirm", "Shown?", "")).toBe(true);
  });
});

describe("the page's alert, confirm and prompt", () => {
  const original = {
    alert: window.alert,
    confirm: window.confirm,
    prompt: window.prompt,
  };
  afterEach(() => {
    for (const [name, value] of Object.entries(original))
      Object.defineProperty(window, name, {
        value,
        writable: true,
        enumerable: true,
        configurable: true,
      });
    vi.mocked(ipcRenderer.sendSync).mockReset();
  });

  /** Replace them as the preload does, recording what they ask. */
  const install = (answer: unknown = true) => {
    const asked: unknown[][] = [];
    replaceScriptDialogs((...args) => {
      asked.push(args);
      return answer;
    });
    return { asked, ...pageFunctions() };
  };

  it("convert the page's arguments as Chrome does", () => {
    const page = install("Grace");
    page.alert();
    page.alert(undefined);
    expect(page.confirm()).toBe(false);
    expect(page.prompt("Name?", 7)).toBe("Grace");
    expect(page.asked).toEqual([
      ["alert", ""],
      ["alert", "undefined"],
      ["confirm", ""],
      ["prompt", "Name?", "7"],
    ]);
  });

  it("ask nothing from a page's beforeunload, pagehide or unload handler, whatever the page replaced", () => {
    const page = install(true);
    const results: unknown[] = [];
    const handler = () => {
      results.push(page.confirm("Leaving?"));
      // The page takes apart what the check could rely on, then asks.
      const call = Object.getOwnPropertyDescriptor(Function.prototype, "call");
      const type = Object.getOwnPropertyDescriptor(Event.prototype, "type");
      const event = Object.getOwnPropertyDescriptor(window, "Event");
      try {
        Object.defineProperty(Function.prototype, "call", {
          value: () => undefined,
          configurable: true,
          writable: true,
        });
        Reflect.set(Reflect, "apply", () => undefined);
        Object.defineProperty(Event.prototype, "type", {
          get: () => "click",
          configurable: true,
        });
        Object.defineProperty(window, "Event", {
          value: function Event() {},
          configurable: true,
          writable: true,
        });
        results.push(page.confirm("Still leaving?"));
        results.push(page.prompt("Why?"));
      } finally {
        if (call) Object.defineProperty(Function.prototype, "call", call);
        Reflect.set(Reflect, "apply", apply);
        if (type) Object.defineProperty(Event.prototype, "type", type);
        if (event) Object.defineProperty(window, "Event", event);
      }
    };
    for (const type of ["beforeunload", "pagehide", "unload"]) {
      window.addEventListener(type, handler);
      window.dispatchEvent(new Event(type));
      window.removeEventListener(type, handler);
    }
    expect(results).toEqual(
      Array.from({ length: 3 }, () => [false, false, null]).flat(),
    );
    expect(page.asked).toEqual([]);
    // Any other event's handler asks.
    window.addEventListener("click", handler);
    window.dispatchEvent(new Event("click"));
    window.removeEventListener("click", handler);
    expect(page.asked.length).toBeGreaterThan(0);
  });

  it("reach main through the preload's bridge, which stops asking from pagehide on", () => {
    vi.mocked(ipcRenderer.sendSync).mockReturnValue({ answer: true });
    installPageDialogs({ top: false });
    const { func, args } = vi.mocked(contextBridge.executeInMainWorld).mock
      .calls[0]?.[0] ?? { func: () => {}, args: [] };
    Reflect.apply(func, undefined, args ?? []);
    const page = pageFunctions();
    expect(page.confirm("Sure?")).toBe(true);
    expect(ipcRenderer.sendSync).toHaveBeenCalledWith(
      "catamorphic:page-dialog",
      {
        kind: "confirm",
        message: "Sure?",
        defaultValue: "",
      },
    );
    // The page's own pagehide listener cannot keep the preload from seeing it.
    window.addEventListener(
      "pagehide",
      (event) => event.stopImmediatePropagation(),
      { capture: true },
    );
    window.dispatchEvent(new Event("pagehide"));
    expect(page.confirm("Gone?")).toBe(false);
    expect(ipcRenderer.sendSync).toHaveBeenCalledTimes(1);
  });
});
