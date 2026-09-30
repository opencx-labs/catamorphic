import { expect, it } from "vitest";
import {
  EMPTY_SURFACE_HISTORY,
  restoreSurface,
  type SurfaceHistory,
  settleSurface,
  stepSurface,
  surfaceChanges,
  surfaceLocation,
  visitSurface,
} from "./surface-history.js";
import { emptyUtilityWorkspace, type Workspace } from "./workspace-state.js";

const workspace = (): Workspace => ({
  ...emptyUtilityWorkspace(),
  tabs: [
    { kind: "palette", name: "a" },
    { kind: "palette", name: "b" },
  ],
  chats: [
    { localId: "c", mode: "tab", sessionId: "one" },
    { localId: "f", mode: "min", sessionId: "two" },
  ],
  activeTabKey: "palette:a",
});

/** The chat "f" floating over whatever tab is active. */
const floating = (ws: Workspace): Workspace => ({
  ...ws,
  activeChatId: "f",
  chats: ws.chats.map((chat) =>
    chat.localId === "f" ? { ...chat, mode: "partial" } : chat,
  ),
});

const walk = (ws: Workspace, places: Workspace[]): SurfaceHistory =>
  [ws, ...places].reduce(
    (history, each) => visitSurface(history, surfaceLocation(each)),
    EMPTY_SURFACE_HISTORY,
  );

it("records each place the user lands on, once", () => {
  const ws = workspace();
  const onB = { ...ws, activeTabKey: "palette:b" };
  const history = walk(ws, [onB, onB, { ...ws, activeTabKey: "chat:c" }]);
  expect(history.entries).toEqual([
    { tab: "palette:a" },
    { tab: "palette:b" },
    { tab: "chat:c" },
  ]);
  expect(history.index).toBe(2);
});

it("counts a chat opening over the tab, and the tab changing under it", () => {
  const ws = workspace();
  const history = walk(ws, [
    floating(ws),
    floating({ ...ws, activeTabKey: "palette:b" }),
    { ...ws, activeTabKey: "palette:b" },
  ]);
  expect(history.entries).toEqual([
    { tab: "palette:a" },
    { tab: "palette:a", overlay: "chat:f" },
    { tab: "palette:b", overlay: "chat:f" },
    { tab: "palette:b" },
  ]);
});

it("steps over places that would change nothing, and settles where it lands", () => {
  const ws = workspace();
  const history = walk(ws, [
    { ...ws, activeTabKey: "palette:b" },
    { ...ws, activeTabKey: "chat:c" },
  ]);
  const closed: Workspace = {
    ...ws,
    activeTabKey: "chat:c",
    tabs: ws.tabs.filter((tab) => tab.name !== "b"),
  };
  const back = stepSurface(history, -1, (place) =>
    surfaceChanges(closed, place),
  );
  expect(back?.entries[back.index]).toEqual({ tab: "palette:a" });
  // Arriving settles the entry; the way forward stays.
  const settled = back && settleSurface(back, { tab: "palette:a" });
  expect(settled?.entries).toHaveLength(3);
  expect(settled && stepSurface(settled, 1, () => true)?.index).toBe(1);
  // Somewhere new from the middle: what was ahead is gone.
  const branched = visitSurface(settled ?? history, {
    tab: "palette:a",
    overlay: "chat:f",
  });
  expect(branched.entries).toHaveLength(2);
  expect(stepSurface(branched, 1, () => true)).toBeNull();
});

it("restores a place as clicking there would", () => {
  const ws = { ...workspace(), activeTabKey: "chat:c" };
  const over = restoreSurface(ws, { tab: "palette:b", overlay: "chat:f" });
  expect(surfaceLocation(over)).toEqual({
    tab: "palette:b",
    overlay: "chat:f",
  });
  const bare = restoreSurface(over, { tab: "palette:a" });
  expect(surfaceLocation(bare)).toEqual({ tab: "palette:a" });
  expect(bare.chats.find((chat) => chat.localId === "f")?.mode).toBe("min");
  // A closed tab leaves the chat that floated over it.
  const gone = restoreSurface(
    { ...bare, tabs: bare.tabs.filter((tab) => tab.name !== "b") },
    { tab: "palette:b", overlay: "chat:f" },
  );
  expect(surfaceLocation(gone)).toEqual({
    tab: "palette:a",
    overlay: "chat:f",
  });
});

it("keeps a split and leaves chats where the user has since put them", () => {
  const split: Workspace = {
    ...workspace(),
    activeTabKey: "palette:b",
    split: { leftKey: "palette:a", rightKey: "palette:b", ratio: 0.5 },
  };
  const left = restoreSurface(split, { tab: "palette:a" });
  expect(left.split).toEqual(split.split);
  expect(left.activeTabKey).toBe("palette:a");
  // "f" was floating then; it is a tab now, and back does not pull it out.
  const tabbed: Workspace = {
    ...workspace(),
    chats: [
      { localId: "c", mode: "tab", sessionId: "one" },
      { localId: "f", mode: "tab", sessionId: "two" },
    ],
  };
  const place = { tab: "palette:a", overlay: "chat:f" };
  expect(
    restoreSurface(tabbed, place).chats.find((c) => c.localId === "f")?.mode,
  ).toBe("tab");
  expect(surfaceChanges(tabbed, place)).toBe(false);
});
