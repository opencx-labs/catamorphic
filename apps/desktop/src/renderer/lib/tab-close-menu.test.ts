import { describe, expect, it } from "vitest";
import { tabCloseEntries, tabCloseRequest } from "./tab-close-menu.js";

const groups = [
  { parentKey: "chat:c", memberKeys: ["browser:b"], collapsed: false },
  { parentKey: "chat:f", memberKeys: ["editor:e"], collapsed: true },
];
const labels = (key: string, tabCount = 4) =>
  tabCloseEntries({ key, tabCount, groups }).map((entry) => entry.label);

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
});
