// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarPhase } from "../lib/sidebar-motion.js";
import { TabbedSidebar } from "./tabbed-sidebar.js";

/** The panel's phase, as the motion hook would report it. */
let phase: SidebarPhase = "open";
vi.mock("../lib/sidebar-motion.js", () => ({
  useSidebarMotion: () => ({ phase, docked: true, settled: true }),
}));
/** What the sidebar asked of its leave, in order. */
const calls: string[] = [];
vi.mock("../lib/sidebar-leave.js", () => ({
  leaveSidebar: () => {
    calls.push("start");
    return {
      leaving: (on: boolean) => calls.push(on ? "leave" : "return"),
      cancel: () => calls.push("cancel"),
    };
  },
}));

let node: HTMLDivElement;
let root: Root;
const render = (next: SidebarPhase) =>
  act(() => {
    phase = next;
    root.render(
      <TabbedSidebar
        side="left"
        scope="leave-test"
        open={next === "open" || next === "opening"}
        tabs={[
          {
            id: "only",
            title: "Only",
            sections: [{ id: "a", type: "custom" }],
          },
        ]}
        onCustomize={() => {}}
        renderSection={() => <span>Row</span>}
      />,
    );
  });
const leads = () =>
  node.querySelector("aside")?.hasAttribute("data-items-lead") ?? false;

beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  calls.length = 0;
  phase = "open";
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(async () => {
  await act(async () => root.unmount());
  node.remove();
});

it("lets the items lead a close from open, and plays them back when it opens mid-close", async () => {
  await render("open");
  expect(calls).toEqual([]);
  await render("closing");
  // The panel waits for the items only when they lead.
  expect(leads()).toBe(true);
  expect(calls).toEqual(["start"]);
  await render("opening");
  expect(leads()).toBe(false);
  expect(calls).toEqual(["start", "return"]);
  // Closing again from an opening panel resumes the same leave, no wait.
  await render("closing");
  expect(leads()).toBe(false);
  expect(calls).toEqual(["start", "return", "leave"]);
  await render("closed");
  expect(calls).toEqual(["start", "return", "leave", "cancel"]);
});

it("starts no leave when a close reverses an opening panel", async () => {
  await render("closed");
  await render("opening");
  await render("closing");
  expect(leads()).toBe(false);
  expect(calls).toEqual([]);
});
