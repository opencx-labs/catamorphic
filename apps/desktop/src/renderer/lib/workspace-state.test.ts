import { expect, it } from "vitest";
import {
  emptyUtilityWorkspace,
  reconcileWorkspace,
  serializeWorkspace,
  transitionWorkspace,
  type Workspace,
  type WorkspaceEvent,
  workspaceLayout,
} from "./workspace-state.js";

const initial = (): Workspace => ({
  ...emptyUtilityWorkspace(),
  tabs: [
    { kind: "palette", name: "a" },
    { kind: "palette", name: "b" },
  ],
  chats: [{ localId: "c", mode: "tab", sessionId: "session" }],
  activeTabKey: "chat:c",
});
it("preserves chat identity and presentation across all resource opening modes", () => {
  const ws = initial();
  const opened = transitionWorkspace(ws, { type: "side", key: "palette:a" });
  expect(workspaceLayout(opened).viewSlots).toEqual({
    "chat:c": "left",
    "palette:a": "right",
  });
  const floating = transitionWorkspace(ws, { type: "float", key: "palette:a" });
  expect(floating.chats).toEqual(ws.chats);
  expect(floating.activeTabKey).toBe("chat:c");
  expect(
    transitionWorkspace(floating, { type: "focus", key: "palette:b" })
      .floatingKey,
  ).toBeUndefined();
});
it("stale animation completion cannot undo later navigation or resize", () => {
  const ws = transitionWorkspace(initial(), { type: "side", key: "palette:a" });
  const split = ws.split!;
  const next = transitionWorkspace(ws, { type: "focus", key: "palette:b" });
  expect(
    transitionWorkspace(next, {
      type: "finish-expansion",
      key: "palette:a",
      split,
    }),
  ).toBe(next);
  const resized = { ...ws, split: { ...split, ratio: 0.7 } };
  expect(
    transitionWorkspace(resized, {
      type: "finish-expansion",
      key: "palette:a",
      split,
    }),
  ).toBe(resized);
});
it("cleans closed split and floating references before persistence", () => {
  const ws = transitionWorkspace(initial(), { type: "side", key: "palette:a" });
  const closed = reconcileWorkspace(ws, { ...ws, tabs: [] });
  expect(closed.split).toBeNull();
  expect(closed.activeTabKey).toBeUndefined();
  expect(serializeWorkspace(closed).split).toBeNull();
});
it("navigation sequences never duplicate a surface slot or create two floating chats", () => {
  const events: WorkspaceEvent[] = [
    { type: "side", key: "palette:a" },
    { type: "select", key: "palette:b" },
    { type: "float", key: "chat:c" },
    { type: "toggle-chat", localId: "c" },
    { type: "reveal-chat", localId: "c" },
    { type: "focus", key: "chat:c" },
    { type: "float", key: "palette:a" },
    { type: "dismiss-floating" },
  ];
  let ws = initial();
  for (let round = 0; round < 10; round++)
    for (const event of events) {
      ws = transitionWorkspace(ws, event);
      expect(
        ws.chats.filter((chat) => chat.mode === "partial").length,
      ).toBeLessThanOrEqual(1);
      expect(
        Object.values(workspaceLayout(ws).viewSlots).filter(
          (slot) => slot === "floating",
        ).length,
      ).toBeLessThanOrEqual(1);
      expect(ws.chats[0]?.localId).toBe("c");
    }
});

it("restoring a chat bubble dismisses a resource preview instead of stacking two floaters", () => {
  let ws = transitionWorkspace(initial(), { type: "float", key: "chat:c" });
  ws = transitionWorkspace(ws, { type: "float", key: "palette:a" });
  expect(ws.chats[0]?.mode).toBe("min");
  ws = transitionWorkspace(ws, { type: "toggle-chat", localId: "c" });
  expect(ws.chats[0]?.mode).toBe("partial");
  expect(ws.floatingKey).toBeUndefined();
});

it("closing and reopening a split pane restores its partner and resource identity", () => {
  let ws = transitionWorkspace(initial(), {
    type: "side",
    key: "chat:c",
    previous: "palette:a",
  });
  ws = transitionWorkspace(ws, { type: "close", key: "chat:c" });
  expect(ws.activeTabKey).toBe("palette:a");
  expect(ws.split).toBeNull();
  ws = transitionWorkspace(ws, { type: "reopen", localId: "restored" });
  expect(ws.chats[0]).toMatchObject({
    localId: "restored",
    sessionId: "session",
    mode: "tab",
  });
  expect(workspaceLayout(ws).viewSlots).toEqual({
    "palette:a": "left",
    "chat:restored": "right",
  });
});

it("keeps a browser tab's way back through close, reopen and persistence", () => {
  const history = {
    entries: [
      { url: "https://example.com/one", title: "One" },
      { url: "https://example.com/two", title: "Two" },
    ],
    index: 1,
  };
  const ws: Workspace = {
    ...initial(),
    browsers: [
      {
        localId: "b",
        profileId: "p",
        initialUrl: "https://example.com/one",
        url: "https://example.com/two",
        title: "Two",
        faviconUrl: null,
        history,
      },
    ],
    activeTabKey: "browser:b",
  };
  expect(serializeWorkspace(ws).browsers[0]?.history).toEqual(history);
  const closed = transitionWorkspace(ws, { type: "close", key: "browser:b" });
  expect(closed.closedTabs.at(-1)).toMatchObject({ kind: "browser", history });
  expect(serializeWorkspace(closed).closedTabs.at(-1)).toMatchObject({
    history,
  });
  const reopened = transitionWorkspace(closed, {
    type: "reopen",
    localId: "again",
  });
  expect(
    reopened.browsers.find((browser) => browser.localId === "again"),
  ).toMatchObject({ url: "https://example.com/two", history });
});

it("closes a New Tab nobody typed into once something else is shown in its place", () => {
  const ws: Workspace = {
    ...initial(),
    tabs: [
      { kind: "palette", name: "a" },
      { kind: "history", name: "history" },
    ],
    activeTabKey: "palette:a",
  };
  // Selecting another tab leaves the empty New Tab behind: it closes.
  const away = transitionWorkspace(ws, { type: "select", key: "chat:c" });
  expect(away.tabs.map((tab) => tab.name)).toEqual(["history"]);
  expect(away.activeTabKey).toBe("chat:c");
  // Opening something new from it does the same.
  const opened = reconcileWorkspace(ws, {
    ...ws,
    activeTabKey: "history:history",
  });
  expect(opened.tabs.map((tab) => tab.name)).toEqual(["history"]);
  // Its own close afterwards (the palette consuming its tab) is a no-op.
  expect(
    transitionWorkspace(opened, { type: "close", key: "palette:a" }).tabs,
  ).toEqual(opened.tabs);
});

it("keeps a New Tab with typed input, or one still on screen", () => {
  const ws: Workspace = {
    ...initial(),
    tabs: [
      { kind: "palette", name: "a", typed: true },
      { kind: "palette", name: "b" },
    ],
    activeTabKey: "palette:a",
  };
  const away = transitionWorkspace(ws, { type: "select", key: "chat:c" });
  expect(away.tabs.map((tab) => tab.name)).toEqual(["a", "b"]);
  // Beside the chat in a split, the New Tab is still shown when the chat
  // takes focus; it stays.
  const split = transitionWorkspace(
    { ...ws, tabs: [{ kind: "palette", name: "b" }], activeTabKey: "chat:c" },
    { type: "side", key: "palette:b" },
  );
  expect(workspaceLayout(split).viewSlots).toEqual({
    "chat:c": "left",
    "palette:b": "right",
  });
  const focused = transitionWorkspace(split, { type: "select", key: "chat:c" });
  expect(workspaceLayout(focused).viewSlots["palette:b"]).toBeTruthy();
  expect(focused.tabs.map((tab) => tab.name)).toEqual(["b"]);
  // A New Tab's input is not restored, so neither is its typed mark.
  expect(serializeWorkspace(ws).tabs[0]).toEqual({
    kind: "palette",
    name: "a",
    label: undefined,
  });
});
