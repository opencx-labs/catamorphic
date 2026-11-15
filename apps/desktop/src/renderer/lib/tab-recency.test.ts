import { describe, expect, it } from "vitest";
import {
  holdsModifier,
  recentTabOrder,
  settledTabWalk,
  stepTabWalk,
  stillHeld,
  type TabWalk,
} from "./tab-recency.js";
import {
  emptyWorkspace,
  transitionWorkspace,
  type Workspace,
} from "./workspace-state.js";

/** Four tabs in strip order a, b, c, d, looked at in that order. */
const visited = (): Workspace => {
  const opened: Workspace = {
    ...emptyWorkspace(),
    tabs: ["a", "b", "c", "d"].map((name) => ({ kind: "run", name })),
    activeTabKey: "run:a",
  };
  return ["run:b", "run:c", "run:d"].reduce(
    (ws, key) => transitionWorkspace(ws, { type: "focus", key }),
    opened,
  );
};

/** Press the shortcut `presses` times in one pass, then release. */
const pass = (ws: Workspace, presses: number, direction: -1 | 1 = 1) => {
  let walk: TabWalk | null = null;
  let current = ws;
  for (let press = 0; press < presses; press += 1) {
    walk = stepTabWalk({ ws: current, walk, direction });
    const key = walk?.order[walk.index];
    if (!walk || !key) throw new Error("no tab to go to");
    current = transitionWorkspace(current, { type: "focus", key });
  }
  return walk ? settledTabWalk(current, walk) : current;
};

describe("tabs by recency", () => {
  it("lists the tab in front, then the tabs left, newest first", () => {
    expect(recentTabOrder(visited())).toEqual([
      "run:d",
      "run:c",
      "run:b",
      "run:a",
    ]);
  });

  it("lists tabs never looked at last, in strip order", () => {
    const ws = transitionWorkspace(
      {
        ...emptyWorkspace(),
        tabs: ["a", "b", "c", "d"].map((name) => ({ kind: "run", name })),
        activeTabKey: "run:c",
      },
      { type: "focus", key: "run:b" },
    );
    expect(recentTabOrder(ws)).toEqual(["run:b", "run:c", "run:a", "run:d"]);
  });

  it("goes back to the last tab on one press, and returns on the next", () => {
    const back = pass(visited(), 1);
    expect(back.activeTabKey).toBe("run:c");
    expect(pass(back, 1).activeTabKey).toBe("run:d");
  });

  it("reaches older tabs while the shortcut is held", () => {
    const ws = pass(visited(), 2);
    expect(ws.activeTabKey).toBe("run:b");
    // The tab passed on the way was not visited: the one left is next.
    expect(recentTabOrder(ws)).toEqual(["run:b", "run:d", "run:c", "run:a"]);
  });

  it("wraps around, and goes the other way with previous tab", () => {
    expect(pass(visited(), 4).activeTabKey).toBe("run:d");
    expect(pass(visited(), 1, -1).activeTabKey).toBe("run:a");
  });

  it("skips a tab closed during the pass", () => {
    const ws = visited();
    const first = stepTabWalk({ ws, walk: null, direction: 1 });
    const closed = transitionWorkspace(
      transitionWorkspace(ws, { type: "focus", key: "run:c" }),
      { type: "close", key: "run:b" },
    );
    const second = stepTabWalk({ ws: closed, walk: first, direction: 1 });
    expect(second?.order[second.index]).toBe("run:a");
  });

  it("has nowhere to go with one tab", () => {
    expect(
      stepTabWalk({ ws: emptyWorkspace(), walk: null, direction: 1 }),
    ).toBeNull();
  });

  it("leaves the workspace alone when another tab came to the front", () => {
    const ws = visited();
    const walk = stepTabWalk({ ws, walk: null, direction: 1 });
    if (!walk) throw new Error("no walk");
    expect(settledTabWalk(ws, walk)).toBe(ws);
  });
});

describe("a held shortcut", () => {
  const none = { metaKey: false, ctrlKey: false, altKey: false };
  it("needs a modifier to hold", () => {
    expect(holdsModifier(none)).toBe(false);
    expect(holdsModifier({ ...none, ctrlKey: true })).toBe(true);
  });

  it("ends when a modifier it started with is released", () => {
    const held = { ...none, ctrlKey: true };
    expect(stillHeld(held, { ...none, ctrlKey: true, metaKey: true })).toBe(
      true,
    );
    expect(stillHeld(held, none)).toBe(false);
  });
});
