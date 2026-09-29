import { expect, it } from "vitest";
import {
  EMPTY_SURFACE_HISTORY,
  restoreSurface,
  type SurfaceHistory,
  stepSurface,
  surfaceExists,
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

it("steps back over closed places and drops the way ahead on a new visit", () => {
  const ws = workspace();
  const history = walk(ws, [
    { ...ws, activeTabKey: "palette:b" },
    { ...ws, activeTabKey: "chat:c" },
  ]);
  const closed: Workspace = {
    ...ws,
    tabs: ws.tabs.filter((tab) => tab.name !== "b"),
  };
  const back = stepSurface(history, -1, (place) =>
    surfaceExists(closed, place),
  );
  expect(back?.entries[back.index]).toEqual({ tab: "palette:a" });
  expect(back && stepSurface(back, -1, () => true)).toBeNull();
  expect((back && stepSurface(back, 1, () => true))?.index).toBe(1);
  // Somewhere new from the middle: what was ahead is gone.
  const branched = visitSurface(back ?? history, {
    tab: "palette:a",
    overlay: "chat:f",
  });
  expect(branched.entries).toHaveLength(2);
  expect(stepSurface(branched, 1, () => true)).toBeNull();
});

it("restores a place as it was: its tab, with or without the chat over it", () => {
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
