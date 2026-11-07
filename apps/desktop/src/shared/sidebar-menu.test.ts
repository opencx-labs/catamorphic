import { expect, it } from "vitest";
import { isMenuSeparator } from "./menu.js";
import { OPEN_ACTIONS } from "./open-mode.js";
import type { SidebarMenuEntry } from "./sidebar.js";
import { composeSidebarMenu } from "./sidebar-menu.js";

it("composes source and automatic opens once, preserving explicit looks and other destinations", () => {
  const entries = composeSidebarMenu({
    resource: true,
    url: "file:todo.md",
    entries: [
      ...OPEN_ACTIONS,
      { action: "open", label: "Read this", url: "file:todo.md" },
      { action: "open-tab", label: "Other document", url: "file:other.md" },
      { action: "rename", label: "Rename" },
    ],
  }).filter((e): e is SidebarMenuEntry => !isMenuSeparator(e));
  expect(entries.map((e) => e.label)).toEqual([
    "Read this",
    "Open in new tab",
    "Open to the side",
    "Open floating",
    "Other document",
    "Rename",
  ]);
});
it("does not deduplicate source actions by label and respects a non-default open mode", () => {
  const entries = composeSidebarMenu({
    resource: true,
    defaultMode: "side",
    entries: [
      { action: "open", label: "Beside this" },
      { action: "first", label: "Same" },
      { action: "second", label: "Same" },
    ],
  }).filter((e): e is SidebarMenuEntry => !isMenuSeparator(e));
  expect(entries.map((e) => e.action)).toEqual([
    "open-here",
    "open-tab",
    "open",
    "open-floating",
    "first",
    "second",
  ]);
});
