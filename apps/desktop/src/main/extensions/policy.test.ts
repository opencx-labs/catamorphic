import { describe, expect, it } from "vitest";
import { cssColor, parseColor } from "./actions.js";
import { bindingFromAccelerator, manifestCommands } from "./commands.js";
import { ContextMenuStore, pageMenuTarget } from "./context-menus.js";
import { debuggerCommandRefusal } from "./debugger.js";
import {
  extensionTabUrl,
  matchesPattern,
  patternCovers,
  scriptableUrl,
} from "./url-policy.js";
import { compareVersions, parseUpdateResponse } from "./webstore.js";

const ID = "abcdefghijklmnopabcdefghijklmnop";

describe("match patterns", () => {
  it("match like Chrome's", () => {
    expect(matchesPattern("<all_urls>", "https://a.test/x")).toBe(true);
    expect(matchesPattern("<all_urls>", "chrome-extension://x/y")).toBe(false);
    expect(matchesPattern("*://*/*", "http://a.test/")).toBe(true);
    expect(matchesPattern("*://*/*", "ftp://a.test/")).toBe(false);
    expect(
      matchesPattern("https://*.example.com/*", "https://example.com/"),
    ).toBe(true);
    expect(
      matchesPattern("https://*.example.com/*", "https://a.example.com/b"),
    ).toBe(true);
    expect(
      matchesPattern("https://*.example.com/*", "https://badexample.com/"),
    ).toBe(false);
    expect(
      matchesPattern("http://127.0.0.1/*", "http://127.0.0.1:8080/page"),
    ).toBe(true);
    expect(
      matchesPattern("http://127.0.0.1:9/*", "http://127.0.0.1:8080/"),
    ).toBe(false);
    expect(
      matchesPattern("https://a.test/docs/*", "https://a.test/other"),
    ).toBe(false);
    expect(matchesPattern("not a pattern", "https://a.test/")).toBe(false);
  });

  it("know when one pattern covers another", () => {
    expect(patternCovers("<all_urls>", "https://a.test/*")).toBe(true);
    expect(patternCovers("*://*/*", "https://a.test/*")).toBe(true);
    expect(patternCovers("https://*.a.test/*", "https://b.a.test/*")).toBe(
      true,
    );
    expect(patternCovers("https://a.test/*", "https://b.test/*")).toBe(false);
    expect(patternCovers("https://a.test/*", "<all_urls>")).toBe(false);
  });
});

describe("where an extension may send a tab", () => {
  it("allows web pages and its own pages", () => {
    expect(extensionTabUrl("https://a.test/", ID)).toBe("https://a.test/");
    expect(extensionTabUrl("options.html", ID)).toBe(
      `chrome-extension://${ID}/options.html`,
    );
    expect(extensionTabUrl(`chrome-extension://${ID}/x.html`, ID)).toBe(
      `chrome-extension://${ID}/x.html`,
    );
    expect(extensionTabUrl(undefined, ID)).toBe("");
  });

  it("refuses files, scripts, other extensions and internal pages", () => {
    for (const url of [
      "file:///etc/passwd",
      "javascript:alert(1)",
      "chrome://settings",
      "data:text/html,hi",
      "work-wake:x",
      "chrome-extension://ponmlkjihgfedcbaponmlkjihgfedcba/x.html",
    ])
      expect(extensionTabUrl(url, ID)).toBeNull();
    expect(scriptableUrl("file:///x")).toBe(false);
    expect(scriptableUrl("https://a.test")).toBe(true);
  });
});

describe("debugger commands", () => {
  it("keep an extension to its tab", () => {
    expect(debuggerCommandRefusal("Runtime.evaluate", {})).toBeNull();
    expect(debuggerCommandRefusal("Input.dispatchMouseEvent", {})).toBeNull();
    expect(
      debuggerCommandRefusal("Target.setAutoAttach", { flatten: true }),
    ).toBeNull();
    expect(
      debuggerCommandRefusal("Page.navigate", { url: "https://a.test/" }),
    ).toBeNull();
    for (const method of [
      "Browser.close",
      "Target.createTarget",
      "Target.attachToTarget",
      "Target.setDiscoverTargets",
      "SystemInfo.getInfo",
      "Storage.clearDataForOrigin",
      "Tracing.start",
      "Memory.simulatePressureNotification",
      "Network.getAllCookies",
      "DOM.setFileInputFiles",
      "Page.setDownloadBehavior",
      "Security.setIgnoreCertificateErrors",
    ])
      expect(debuggerCommandRefusal(method, {})).not.toBeNull();
    expect(
      debuggerCommandRefusal("Page.navigate", { url: "file:///etc/passwd" }),
    ).not.toBeNull();
    expect(
      debuggerCommandRefusal("Target.getTargetInfo", { targetId: "other" }),
    ).not.toBeNull();
  });
});

describe("commands", () => {
  it("turn Chrome accelerators into Work bindings", () => {
    expect(bindingFromAccelerator("Ctrl+Shift+Period", false)).toBe(
      "Cmd+Shift+.",
    );
    expect(bindingFromAccelerator("Command+Shift+Period", true)).toBe(
      "Cmd+Shift+.",
    );
    expect(bindingFromAccelerator("Alt+Shift+D", true)).toBe("Alt+Shift+D");
    expect(bindingFromAccelerator("MacCtrl+Shift+Y", true)).toBe(
      "Ctrl+Shift+Y",
    );
    expect(bindingFromAccelerator("Shift+D", true)).toBeNull();
    expect(bindingFromAccelerator("Ctrl+MediaNextTrack", true)).toBeNull();
  });

  it("read the platform's suggested key", () => {
    const commands = manifestCommands(
      {
        manifest_version: 3,
        name: "x",
        version: "1",
        commands: {
          "toggle-side-panel": {
            suggested_key: { default: "Ctrl+E", mac: "Command+E" },
            description: "__MSG_toggle__",
          },
          _execute_action: {},
        },
      },
      "darwin",
      (text) => (text === "__MSG_toggle__" ? "Toggle" : text),
    );
    expect(commands).toEqual([
      { name: "toggle-side-panel", description: "Toggle", binding: "Cmd+E" },
      {
        name: "_execute_action",
        description: "Activate the extension",
        binding: null,
      },
    ]);
  });
});

describe("context menus", () => {
  it("come back from the last run, and a create replaces what came back", () => {
    const first = new ContextMenuStore();
    first.create("p", "e", { id: 7, title: "Seven", contexts: ["page"] });
    first.create("p", "e", { id: "kid", parentId: 7, title: "Kid" });
    const saved = first.snapshot("p", "e");
    const next = new ContextMenuStore();
    next.restore("p", "e", saved);
    expect(next.item("p", "e", "7")?.rawId).toBe(7);
    expect(next.item("p", "e", "kid")?.rawParentId).toBe(7);
    // The extension creates its items again as it starts: no collision.
    next.create("p", "e", { id: 7, title: "Seven again" });
    expect(next.item("p", "e", "7")?.title).toBe("Seven again");
    // Its own duplicates still fail, as in Chrome.
    expect(() => next.create("p", "e", { id: 7, title: "Twice" })).toThrow(
      "duplicate",
    );
  });

  const target = pageMenuTarget({
    pageURL: "https://a.test/",
    frameURL: "https://a.test/",
    linkURL: "",
    srcURL: "",
    mediaType: "none",
    selectionText: "hello world",
    isEditable: false,
    frameId: 0,
  });

  it("show items for the right contexts with the selection filled in", () => {
    const menus = new ContextMenuStore();
    menus.create("p", ID, {
      id: "a",
      title: "Look up %s",
      contexts: ["selection"],
    });
    menus.create("p", ID, { id: "b", title: "Link only", contexts: ["link"] });
    menus.create("p", ID, {
      id: "c",
      title: "Elsewhere",
      contexts: ["all"],
      documentUrlPatterns: ["https://b.test/*"],
    });
    const entries = menus.entries("p", ID, target);
    expect(entries.map((entry) => entry.label)).toEqual([
      "Look up hello world",
    ]);
    expect(target.contexts.has("page")).toBe(false);
  });

  it("refuse duplicates and drop children with their parent", () => {
    const menus = new ContextMenuStore();
    menus.create("p", ID, { id: "parent", title: "Parent", contexts: ["all"] });
    menus.create("p", ID, {
      id: "child",
      title: "Child",
      parentId: "parent",
      contexts: ["all"],
    });
    expect(() =>
      menus.create("p", ID, { id: "parent", title: "Again" }),
    ).toThrow("duplicate");
    expect(() => menus.create("p", ID, { title: "No id" })).toThrow("id");
    menus.remove("p", ID, "parent");
    expect(menus.item("p", ID, "child")).toBeNull();
  });

  it("toggle checkboxes and keep one radio of a group checked", () => {
    const menus = new ContextMenuStore();
    menus.create("p", ID, {
      id: "x",
      title: "X",
      type: "radio",
      checked: true,
    });
    menus.create("p", ID, { id: "y", title: "Y", type: "radio" });
    menus.create("p", ID, { id: "z", title: "Z", type: "checkbox" });
    menus.click("p", ID, "y");
    expect(menus.item("p", ID, "x")?.checked).toBe(false);
    expect(menus.item("p", ID, "y")?.checked).toBe(true);
    expect(menus.click("p", ID, "z")).toBe(false);
    expect(menus.item("p", ID, "z")?.checked).toBe(true);
  });
});

describe("badge colors", () => {
  it("parse what Chrome accepts", () => {
    expect(parseColor("#d63c0c")).toEqual([214, 60, 12, 255]);
    expect(parseColor("#fff")).toEqual([255, 255, 255, 255]);
    expect(parseColor([1, 2, 3, 4])).toEqual([1, 2, 3, 4]);
    expect(parseColor("rgb(10, 20, 30)")).toEqual([10, 20, 30, 255]);
    expect(parseColor("rgba(10, 20, 30, 0.5)")).toEqual([10, 20, 30, 128]);
    expect(parseColor("red")).toEqual([255, 0, 0, 255]);
    expect(parseColor("not a color")).toBeNull();
    expect(parseColor([300, 0, 0, 0])).toBeNull();
    expect(cssColor([10, 20, 30, 255])).toBe("rgba(10, 20, 30, 1.000)");
  });
});

describe("the store's update answer", () => {
  it("lists packages offered and skips the rest", () => {
    const xml = `<?xml version="1.0"?><gupdate protocol="2.0">
      <app appid="${ID}" status="ok"><updatecheck codebase="https://clients2.googleusercontent.com/crx/blobs/a.crx" hash_sha256="${"ab".repeat(32)}" size="10" status="ok" version="4.9.133"/></app>
      <app appid="ponmlkjihgfedcbaponmlkjihgfedcba" status="ok"><updatecheck status="noupdate"/></app>
      <app appid="not-an-id" status="ok"><updatecheck codebase="https://x/a.crx" status="ok" version="1"/></app>
    </gupdate>`;
    expect(parseUpdateResponse(xml)).toEqual([
      {
        id: ID,
        version: "4.9.133",
        url: "https://clients2.googleusercontent.com/crx/blobs/a.crx",
        sha256: "ab".repeat(32),
        size: 10,
      },
    ]);
  });

  it("orders versions numerically", () => {
    expect(compareVersions("1.10", "1.9")).toBe(1);
    expect(compareVersions("2026.930.1227", "2026.930.1227")).toBe(0);
    expect(compareVersions("1.0", "1.0.0.1")).toBe(-1);
  });
});
