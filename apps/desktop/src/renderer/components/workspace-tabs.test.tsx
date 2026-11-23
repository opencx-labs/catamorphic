// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { WorkspaceTab } from "../lib/workspace-types.js";
import type { ResourceActions } from "./open-resource-button.js";

// A row renders its title each time it renders: the count per title is the
// count of that row's renders.
const titles = vi.hoisted(() => new Map<string, number>());
vi.mock("./animated-title", () => ({
  AnimatedTitle: ({ text }: { text: string }) => {
    titles.set(text, (titles.get(text) ?? 0) + 1);
    return <span>{text}</span>;
  },
}));

import { WorkspaceTabBar } from "./workspace-tabs.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  titles.clear();
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});

const TABS: WorkspaceTab[] = Array.from({ length: 40 }, (_, index) => ({
  kind: "terminal",
  name: `t${index}`,
  label: `Terminal ${index}`,
}));
const handlers = {
  onSelect: vi.fn(),
  onClose: vi.fn(),
  onNew: vi.fn(),
  onReorder: vi.fn(),
};
const renders = () =>
  [...titles.values()].reduce((total, count) => total + count, 0);

it("draws only the two tabs that changed when another comes to the front", () => {
  const tabActions = vi.fn(() => ({ entries: [], onAction: () => {} }));
  const strip = (activeKey: string, tabs = TABS) => (
    <WorkspaceTabBar
      tabs={tabs}
      activeKey={activeKey}
      tabActions={tabActions}
      {...handlers}
    />
  );
  act(() => root.render(strip("terminal:t0")));
  expect(renders()).toBe(TABS.length);
  // A menu is built when it opens, never for a tab that only renders.
  expect(tabActions).not.toHaveBeenCalled();

  titles.clear();
  act(() => root.render(strip("terminal:t7")));
  expect(Object.fromEntries(titles)).toEqual({
    "Terminal 0": 1,
    "Terminal 7": 1,
  });
  expect(
    node.querySelector("[data-tab-active]")?.getAttribute("data-point-key"),
  ).toBe("terminal:t7");

  // The window rendering again with the same tabs draws none.
  titles.clear();
  act(() => root.render(strip("terminal:t7")));
  expect(renders()).toBe(0);

  // One tab's title changes: that row alone.
  titles.clear();
  const renamed = TABS.map((tab, index) =>
    index === 3 ? { ...tab, label: "Renamed" } : tab,
  );
  act(() => root.render(strip("terminal:t7", renamed)));
  expect(Object.fromEntries(titles)).toEqual({ Renamed: 1 });
});

it("builds a tab's menu from the latest handlers as it opens", () => {
  const first = vi.fn((_key: string) => ({ entries: [], onAction: () => {} }));
  const latest = vi.fn((_key: string) => ({
    entries: [{ label: "Rename…", action: "rename" }],
    onAction: () => {},
  }));
  const strip = (tabActions: (key: string) => ResourceActions) => (
    <WorkspaceTabBar
      tabs={TABS.slice(0, 3)}
      activeKey="terminal:t0"
      tabActions={tabActions}
      {...handlers}
    />
  );
  act(() => root.render(strip(first)));
  act(() => root.render(strip(latest)));
  const label = node.querySelector<HTMLElement>(
    '[data-point-key="terminal:t1"] .workspace-tab-label',
  );
  act(() => {
    label?.dispatchEvent(
      new MouseEvent("contextmenu", { bubbles: true, cancelable: true }),
    );
  });
  expect(first).not.toHaveBeenCalled();
  expect(latest).toHaveBeenCalledWith("terminal:t1");
  expect(document.body.textContent).toContain("Rename…");
});
