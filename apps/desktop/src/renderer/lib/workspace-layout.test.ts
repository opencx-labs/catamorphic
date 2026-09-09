import { describe, expect, it } from "vitest";
import { resolveWorkspaceLayout } from "./workspace-layout.js";

const tabKeys = ["chat:a", "browser:b", "editor:c"];
const split = { leftKey: "chat:a", rightKey: "browser:b", ratio: 0.5 };

describe("workspace visibility", () => {
  it.each(["chat:a", "browser:b"])(
    "keeps both split panes visible when %s has focus",
    (activeTabKey) => {
      expect(
        resolveWorkspaceLayout({ tabKeys, activeTabKey, split }).viewSlots,
      ).toEqual({ "chat:a": "left", "browser:b": "right" });
    },
  );

  it("keeps a background full-tab chat hidden when a link opens here", () => {
    expect(
      resolveWorkspaceLayout({
        tabKeys,
        activeTabKey: "browser:b",
        split: null,
      }).viewSlots,
    ).toEqual({ "browser:b": "full" });
  });

  it.each([
    { tabKeys: ["browser:b"], activeTabKey: "browser:b", split },
    { tabKeys, activeTabKey: "editor:c", split },
    {
      tabKeys,
      activeTabKey: "browser:b",
      split: { ...split, leftKey: "browser:b" },
    },
  ])(
    "ignores splits invalidated by navigation or a chat mode change",
    (state) => {
      const layout = resolveWorkspaceLayout(state);
      expect(layout.split).toBeNull();
      expect(layout.viewSlots).toEqual({ [state.activeTabKey]: "full" });
    },
  );

  it("does not render closed tabs or stale floating references", () => {
    expect(
      resolveWorkspaceLayout({
        tabKeys,
        activeTabKey: "chat:closed",
        floatingKey: "browser:closed",
        split: null,
      }).viewSlots,
    ).toEqual({});
  });

  it("keeps the full chat beneath a distinct floating preview", () => {
    expect(
      resolveWorkspaceLayout({
        tabKeys,
        activeTabKey: "chat:a",
        floatingKey: "browser:b",
        split: null,
      }).viewSlots,
    ).toEqual({ "chat:a": "full", "browser:b": "floating" });
  });

  it("never gives the same surface both a pane and a floating slot", () => {
    expect(
      resolveWorkspaceLayout({
        tabKeys,
        activeTabKey: "browser:b",
        floatingKey: "chat:a",
        split,
      }).viewSlots,
    ).toEqual({ "chat:a": "left", "browser:b": "right" });
  });
});
