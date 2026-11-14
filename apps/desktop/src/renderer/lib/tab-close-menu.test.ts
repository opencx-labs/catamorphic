import { describe, expect, it } from "vitest";
import {
  tabCloseEntries,
  tabCloseRequest,
  tabPinEntries,
  tabPinRequest,
} from "./tab-close-menu.js";
import type { WorkspaceTab } from "./workspace-types.js";

const groups = [
  { parentKey: "chat:c", memberKeys: ["browser:b"], collapsed: false },
  { parentKey: "chat:f", memberKeys: ["editor:e"], collapsed: true },
];
const tabsOf = (count: number, pinned: readonly string[] = []) =>
  Array.from(
    { length: count },
    (_, index): WorkspaceTab => ({
      kind: "browser",
      name: pinned[index] ?? `t${index}`,
      ...(index < pinned.length ? { pinned: true } : {}),
    }),
  );
const labels = (key: string, tabCount = 4) =>
  tabCloseEntries({ key, tabs: tabsOf(tabCount), groups }).map(
    (entry) => entry.label,
  );

describe("a tab's ways to close", () => {
  it("offers a lone tab only its own close", () => {
    expect(labels("settings:settings", 1)).toEqual(["Close tab"]);
  });

  it("adds closing everything once there are other tabs", () => {
    expect(labels("browser:other")).toEqual(["Close tab", "Close all tabs"]);
    expect(labels("chat:plain")).toEqual(["Close chat", "Close all tabs"]);
  });

  it("offers the group's closes on the chat and on a tab under it", () => {
    const group = [
      "Close tabs under chat",
      "Close chat and its tabs",
      "Close all tabs",
    ];
    expect(labels("chat:c")).toEqual(["Close chat", ...group]);
    expect(labels("browser:b")).toEqual(["Close tab", ...group]);
  });

  it("leaves out closing a folded chat alone, which its close never does", () => {
    expect(labels("chat:f", 1)).toEqual([
      "Close tabs under chat",
      "Close chat and its tabs",
      "Close all tabs",
    ]);
  });

  it("aims a group's close at the chat from a tab under it", () => {
    expect(
      tabCloseRequest({ action: "close-chat-tabs", key: "browser:b", groups }),
    ).toEqual({ key: "chat:c", scope: "chat-tabs" });
    expect(
      tabCloseRequest({
        action: "close-chat-and-tabs",
        key: "chat:c",
        groups,
      }),
    ).toEqual({ key: "chat:c", scope: "chat-and-tabs" });
  });

  it("closes the tab itself, everything, or nothing it does not know", () => {
    expect(
      tabCloseRequest({ action: "close", key: "browser:b", groups }),
    ).toEqual({ key: "browser:b" });
    expect(
      tabCloseRequest({ action: "close-all-tabs", key: "browser:b", groups }),
    ).toEqual({ key: "browser:b", scope: "all" });
    expect(
      tabCloseRequest({ action: "archive", key: "chat:c", groups }),
    ).toBeUndefined();
  });

  it("leaves pinned tabs when closing everything, and says so", () => {
    const tabs = tabsOf(3, ["p"]);
    const pinnedLabels = (key: string, list = tabs) =>
      tabCloseEntries({ key, tabs: list, groups: [] }).map(
        (entry) => entry.label,
      );
    expect(pinnedLabels("browser:t1")).toEqual([
      "Close tab",
      "Close unpinned tabs",
    ]);
    expect(pinnedLabels("browser:p")).toEqual([
      "Close tab",
      "Close unpinned tabs",
    ]);
    // Only pinned tabs and this one: closing it is all there is to close.
    expect(pinnedLabels("browser:t1", tabsOf(2, ["p"]))).toEqual(["Close tab"]);
    expect(pinnedLabels("browser:p", tabsOf(1, ["p"]))).toEqual(["Close tab"]);
  });
});

describe("pinning from a tab's menu", () => {
  it("names a chat as a chat and offers the way back", () => {
    expect(
      tabPinEntries({ key: "chat:c", pinned: false }).map((e) => e.label),
    ).toEqual(["Pin chat"]);
    expect(
      tabPinEntries({ key: "browser:b", pinned: true }).map((e) => e.label),
    ).toEqual(["Unpin tab"]);
  });

  it("says why a tab cannot be pinned", () => {
    expect(
      tabPinEntries({
        key: "browser:b",
        pinned: false,
        blocker: "An agent is using this page. Take it over first.",
      })[0]?.disabledReason,
    ).toBe("An agent is using this page. Take it over first.");
  });

  it("reads which way a pick goes", () => {
    expect(tabPinRequest("pin-tab")).toBe(true);
    expect(tabPinRequest("unpin-tab")).toBe(false);
    expect(tabPinRequest("close")).toBeUndefined();
  });
});
