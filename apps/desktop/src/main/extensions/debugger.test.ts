import { EventEmitter } from "node:events";
import { describe, expect, it } from "vitest";
import {
  type DebuggerGuest,
  debuggerCommandRefusal,
  ExtensionDebuggers,
} from "./debugger.js";
import { scriptableUrl } from "./url-policy.js";

class FakeDebugger extends EventEmitter {
  attached = false;
  readonly sent: { method: string; params?: object; sessionId?: string }[] = [];
  isAttached() {
    return this.attached;
  }
  attach() {
    this.attached = true;
  }
  detach() {
    this.attached = false;
  }
  async sendCommand(method: string, params?: object, sessionId?: string) {
    this.sent.push({ method, params, sessionId });
    return {};
  }
}

class FakeGuest extends EventEmitter implements DebuggerGuest {
  readonly debugger = new FakeDebugger();
  constructor(public url: string) {
    super();
  }
  getURL() {
    return this.url;
  }
  isDestroyed() {
    return false;
  }
}

function setup(url = "https://site.test/") {
  const guest = new FakeGuest(url);
  const events: { method: string; sessionId?: string }[] = [];
  const detached: string[] = [];
  const debuggers = new ExtensionDebuggers(
    {
      onEvent: (_client, _tabId, method, _params, sessionId) =>
        events.push({ method, sessionId }),
      onDetach: (_client, _tabId, reason) => detached.push(reason),
      onChange: () => {},
    },
    (address) =>
      scriptableUrl(address) && !address.startsWith("https://store.test"),
  );
  debuggers.attach("p:ext", { guest, tabId: 7 }, "1.3");
  const message = (method: string, params: unknown, sessionId = "") =>
    guest.debugger.emit("message", {}, method, params, sessionId);
  return { guest, debuggers, events, detached, message };
}

describe("debugger sessions", () => {
  it("end when the page leaves the web", async () => {
    const { guest, debuggers, detached } = setup();
    guest.emit("did-start-navigation", {
      url: "chrome-extension://victim/page.html",
      isMainFrame: true,
    });
    expect(detached).toEqual(["target_closed"]);
    expect(guest.debugger.attached).toBe(false);
    await expect(
      debuggers.sendCommand("p:ext", 7, "Runtime.evaluate", {}, undefined),
    ).rejects.toThrow("not attached");
  });

  it("end when the page reaches the store", () => {
    const { guest, detached } = setup();
    guest.emit("did-start-navigation", {
      url: "https://store.test/detail/x",
      isMainFrame: true,
    });
    expect(detached).toEqual(["target_closed"]);
  });

  it("refuse commands once the page is no longer a web page", async () => {
    const { guest, debuggers, detached } = setup();
    guest.url = "chrome-extension://victim/page.html";
    await expect(
      debuggers.sendCommand("p:ext", 7, "Runtime.evaluate", {}, undefined),
    ).rejects.toThrow("Cannot access");
    expect(detached).toEqual(["target_closed"]);
  });

  it("only hand the client child targets that are web pages", async () => {
    const { guest, debuggers, events, message } = setup();
    message("Target.attachedToTarget", {
      sessionId: "web",
      targetInfo: { targetId: "t1", url: "https://frame.test/" },
    });
    message("Target.attachedToTarget", {
      sessionId: "ext",
      targetInfo: { targetId: "t2", url: "chrome-extension://victim/x.html" },
    });
    message("Runtime.consoleAPICalled", {}, "web");
    message("Runtime.consoleAPICalled", {}, "ext");
    expect(events).toEqual([
      { method: "Target.attachedToTarget", sessionId: undefined },
      { method: "Runtime.consoleAPICalled", sessionId: "web" },
    ]);
    expect(guest.debugger.sent).toContainEqual({
      method: "Target.detachFromTarget",
      params: { sessionId: "ext" },
      sessionId: undefined,
    });
    await debuggers.sendCommand("p:ext", 7, "Runtime.evaluate", {}, "web");
    await expect(
      debuggers.sendCommand("p:ext", 7, "Runtime.evaluate", {}, "ext"),
    ).rejects.toThrow("No session");
    // A web frame that becomes another extension's page is dropped too.
    message("Target.targetInfoChanged", {
      targetInfo: { targetId: "t1", url: "chrome-extension://victim/y.html" },
    });
    await expect(
      debuggers.sendCommand("p:ext", 7, "Runtime.evaluate", {}, "web"),
    ).rejects.toThrow("No session");
  });

  it("allow one extension per tab", () => {
    const { guest, debuggers } = setup();
    expect(() =>
      debuggers.attach("p:other", { guest, tabId: 7 }, "1.3"),
    ).toThrow("Another debugger");
  });

  it("share a tab Work's driver holds, and end it all the same", () => {
    const guest = new FakeGuest("https://site.test/");
    guest.debugger.attached = true;
    const debuggers = new ExtensionDebuggers(
      { onEvent: () => {}, onDetach: () => {}, onChange: () => {} },
      scriptableUrl,
    );
    debuggers.attach("p:ext", { guest, tabId: 1 }, "1.3");
    debuggers.detach("p:ext", 1);
    // What the extension set up goes with the session.
    expect(guest.debugger.attached).toBe(false);
  });

  it("end on a redirect that leaves the web", () => {
    const { guest, detached } = setup();
    guest.emit("did-redirect-navigation", {
      url: "chrome-extension://victim/page.html",
      isMainFrame: true,
    });
    expect(detached).toEqual(["target_closed"]);
  });

  it("hide other extensions' script worlds in the page", async () => {
    const { debuggers, events, message } = setup();
    message("Runtime.executionContextCreated", {
      context: { id: 1, origin: "https://site.test", uniqueId: "a" },
    });
    message("Runtime.executionContextCreated", {
      context: { id: 4, origin: "chrome-extension://victim", uniqueId: "v" },
    });
    message("Runtime.executionContextCreated", {
      context: { id: 5, origin: "chrome-extension://ext", uniqueId: "o" },
    });
    expect(events.map((event) => event.method)).toEqual([
      "Runtime.executionContextCreated",
      "Runtime.executionContextCreated",
    ]);
    for (const params of [
      { expression: "1", contextId: 4 },
      { expression: "1", uniqueContextId: "v" },
      { functionDeclaration: "f", objectId: "77.4.9" },
      {
        functionDeclaration: "f",
        objectId: "77.1.2",
        arguments: [{ objectId: "77.4.3" }],
      },
    ])
      await expect(
        debuggers.sendCommand(
          "p:ext",
          7,
          "Runtime.evaluate",
          params,
          undefined,
        ),
      ).rejects.toThrow("Cannot find context");
    // The page's world and the extension's own content scripts stay open.
    await debuggers.sendCommand(
      "p:ext",
      7,
      "Runtime.evaluate",
      { expression: "1", contextId: 1 },
      undefined,
    );
    await debuggers.sendCommand(
      "p:ext",
      7,
      "Runtime.evaluate",
      { expression: "1", contextId: 5 },
      undefined,
    );
  });
});

describe("debugger commands that reach local files or other sites", () => {
  it("are refused", () => {
    expect(
      debuggerCommandRefusal("Input.dispatchDragEvent", {
        type: "drop",
        data: { items: [], files: ["/etc/passwd"], dragOperationsMask: 1 },
      }),
    ).not.toBeNull();
    expect(
      debuggerCommandRefusal("Input.dispatchDragEvent", {
        type: "dragEnter",
        data: { items: [], dragOperationsMask: 1 },
      }),
    ).toBeNull();
    for (const method of [
      "Debugger.enable",
      "HeapProfiler.takeHeapSnapshot",
      "DOM.getFileInfo",
      "Network.loadNetworkResource",
      "Network.setCookie",
      "Network.deleteCookies",
    ])
      expect(debuggerCommandRefusal(method, {})).not.toBeNull();
    expect(
      debuggerCommandRefusal("Network.getCookies", {
        urls: ["https://bank.test/"],
      }),
    ).not.toBeNull();
    expect(debuggerCommandRefusal("Network.getCookies", {})).toBeNull();
    expect(
      debuggerCommandRefusal("Target.setAutoAttach", {
        autoAttach: true,
        waitForDebuggerOnStart: false,
      }),
    ).not.toBeNull();
  });
});
