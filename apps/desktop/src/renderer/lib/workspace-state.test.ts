import { expect, it } from "vitest";
import {
  agentOpenInFront,
  attachBlocker,
  emptyUtilityWorkspace,
  hydrateWorkspace,
  newTabInFront,
  openChatInNewTab,
  orderedTabKeys,
  reconcileWorkspace,
  serializeWorkspace,
  stripTravel,
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

it("closing the tab in front goes back to the tab the person was on", () => {
  let ws: Workspace = {
    ...emptyUtilityWorkspace(),
    tabs: [{ kind: "run", name: "r" }],
    chats: [
      { localId: "c", mode: "tab", sessionId: "session" },
      { localId: "d", mode: "tab", sessionId: "other" },
    ],
    browsers: [
      {
        localId: "b",
        profileId: "p",
        initialUrl: "https://example.com/",
        url: "https://example.com/",
        title: "Example",
        faviconUrl: null,
        chatLocalId: "c",
        background: true,
      },
    ],
    activeTabKey: "run:r",
  };
  ws = transitionWorkspace(ws, { type: "select", key: "chat:c" });
  // A link clicked in the chat brings its page to the front.
  ws = transitionWorkspace(ws, { type: "focus", key: "browser:b" });
  expect(ws.recentTabKeys).toEqual(["run:r", "chat:c"]);
  // Back to the chat, not the last tab in the strip (chat:d).
  ws = transitionWorkspace(ws, { type: "close", key: "browser:b" });
  expect(ws.activeTabKey).toBe("chat:c");
  expect(ws.recentTabKeys).toEqual(["run:r"]);
  // Tabs closed meanwhile drop out, and it survives a relaunch.
  const restored = hydrateWorkspace(
    serializeWorkspace({ ...ws, recentTabKeys: ["gone:x", "run:r"] }),
  );
  expect(restored?.recentTabKeys).toEqual(["run:r"]);
  ws = transitionWorkspace(ws, { type: "close", key: "chat:c" });
  expect(ws.activeTabKey).toBe("run:r");
  expect(ws.recentTabKeys).toEqual([]);
});

it("closing a tab skips a page its folded group hides", () => {
  let ws: Workspace = {
    ...emptyUtilityWorkspace(),
    tabs: [{ kind: "run", name: "r" }],
    chats: [{ localId: "c", mode: "tab", sessionId: "session" }],
    browsers: [
      {
        localId: "b",
        profileId: "p",
        initialUrl: "https://example.com/",
        url: "https://example.com/",
        title: "Example",
        faviconUrl: null,
        chatLocalId: "c",
      },
    ],
    activeTabKey: "chat:c",
  };
  ws = transitionWorkspace(ws, { type: "select", key: "browser:b" });
  ws = transitionWorkspace(ws, { type: "select", key: "run:r" });
  expect(ws.recentTabKeys).toEqual(["chat:c", "browser:b"]);
  ws = reconcileWorkspace(ws, {
    ...ws,
    chats: ws.chats.map((chat) => ({ ...chat, surfacesCollapsed: true })),
  });
  ws = transitionWorkspace(ws, { type: "close", key: "run:r" });
  expect(ws.activeTabKey).toBe("chat:c");
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

it("opens a chat asked for from a New Tab in that tab's place", () => {
  const ws: Workspace = {
    ...initial(),
    tabs: [
      { kind: "history", name: "history" },
      { kind: "palette", name: "a", typed: true },
      { kind: "settings", name: "settings" },
    ],
    activeTabKey: "palette:a",
  };
  expect(newTabInFront(ws)?.name).toBe("a");
  const withChat = (from: Workspace): Workspace => ({
    ...from,
    chats: [...from.chats, { localId: "new", mode: "tab" }],
    activeChatId: "new",
    activeTabKey: "chat:new",
  });
  // The chat stands where the New Tab stood, and the New Tab is gone,
  // typed into or not: it was the way to the chat.
  const opened = reconcileWorkspace(
    ws,
    openChatInNewTab(ws, withChat(ws), "chat:new"),
  );
  expect(opened.tabs.map((tab) => tab.name)).toEqual(["history", "settings"]);
  expect(orderedTabKeys(opened)).toEqual([
    "history:history",
    "chat:new",
    "settings:settings",
    "chat:c",
  ]);
  expect(opened.activeTabKey).toBe("chat:new");
  // As one pane of a split, it takes that pane.
  const split: Workspace = {
    ...ws,
    split: { leftKey: "history:history", rightKey: "palette:a", ratio: 0.4 },
  };
  expect(openChatInNewTab(split, withChat(split), "chat:new").split).toEqual({
    leftKey: "history:history",
    rightKey: "chat:new",
    ratio: 0.4,
  });
  const left: Workspace = {
    ...ws,
    split: { leftKey: "palette:a", rightKey: "settings:settings", ratio: 0.5 },
  };
  expect(openChatInNewTab(left, withChat(left), "chat:new").split).toEqual({
    leftKey: "chat:new",
    rightKey: "settings:settings",
    ratio: 0.5,
  });
  // A surface floating over it is what the person looks at: it stays.
  expect(newTabInFront({ ...ws, floatingKey: "settings:settings" })).toBe(
    undefined,
  );
  // Anything else in front keeps its place; the chat goes where it would.
  const elsewhere = { ...ws, activeTabKey: "history:history" };
  expect(newTabInFront(elsewhere)).toBeUndefined();
  const next = withChat(elsewhere);
  expect(openChatInNewTab(elsewhere, next, "chat:new")).toBe(next);
});

it("opens an agent's surface in front only where the person is looking", () => {
  const front = (
    chat: "visible" | "hidden" | "absent" | "unnamed",
    more: { shown?: boolean; voice?: boolean; targetInFront?: boolean } = {},
  ) =>
    agentOpenInFront({
      shown: more.shown ?? true,
      voice: more.voice ?? false,
      targetInFront: more.targetInFront ?? false,
      chat,
    });
  expect(front("visible")).toBe(true);
  expect(front("hidden")).toBe(false);
  // A subsession, an automation's chat or a closed chat takes no view.
  expect(front("absent")).toBe(false);
  // The terminal `open` hook names no session: the person's own command.
  expect(front("unnamed")).toBe(true);
  // Talking by voice is watching, even with the chat out of sight.
  expect(front("hidden", { voice: true })).toBe(true);
  expect(front("absent", { voice: true })).toBe(true);
  expect(front("hidden", { targetInFront: true })).toBe(true);
  // A project or window Work isn't showing never opens in front.
  expect(front("visible", { shown: false })).toBe(false);
  expect(front("visible", { shown: false, voice: true })).toBe(false);
});

it("brings a tab in from its side of the strip", () => {
  const strip = ["app:a", "browser:b", "browser:c", "chat:d"];
  expect(stripTravel(strip, strip, "browser:c", "browser:b")).toBe("left");
  expect(stripTravel(strip, strip, "browser:b", "chat:d")).toBe("right");
  // A new app lands among the apps, left of the page in front.
  expect(
    stripTravel(
      strip,
      ["app:a", "app:new", ...strip.slice(1)],
      "browser:b",
      "app:new",
    ),
  ).toBe("left");
  // A new page lands after the pages; the chat that stepped aside left
  // the strip, so the new page stands in its place.
  expect(
    stripTravel(
      strip,
      ["app:a", "browser:b", "browser:c", "browser:new"],
      "chat:d",
      "browser:new",
    ),
  ).toBe("right");
  expect(
    stripTravel(
      strip,
      ["app:a", "browser:b", "browser:c"],
      "chat:d",
      "browser:b",
    ),
  ).toBe("left");
  // A close brings in its neighbour from that neighbour's side.
  const closed = ["app:a", "browser:c", "chat:d"];
  expect(stripTravel(strip, closed, "browser:b", "app:a")).toBe("left");
  expect(stripTravel(strip, closed, "browser:b", "browser:c")).toBe("right");
  expect(stripTravel(strip, closed, "browser:b", "browser:gone")).toBe(
    undefined,
  );
});

it("an agent terminal lives as long as its command: its chip leaves, its tab stays until closed (ADR 0223)", () => {
  const agentTerminal = (localId: string, sessionId: string) => ({
    localId,
    title: localId,
    chatLocalId: "c",
    attachSessionId: sessionId,
    agentControlled: true,
    running: true,
    busy: true,
  });
  let ws: Workspace = {
    ...initial(),
    terminals: [
      { ...agentTerminal("chip", "s1"), background: true },
      agentTerminal("tab", "s2"),
      agentTerminal("live", "s3"),
    ],
    activeTabKey: "terminal:tab",
  };
  // News for a terminal this workspace does not hold, or no news, changes
  // nothing.
  expect(
    transitionWorkspace(ws, { type: "terminal-ended", sessionId: "other" }),
  ).toBe(ws);
  expect(
    transitionWorkspace(ws, {
      type: "terminal-busy",
      sessionId: "s1",
      busy: true,
    }),
  ).toBe(ws);

  ws = transitionWorkspace(ws, { type: "terminal-ended", sessionId: "s1" });
  ws = transitionWorkspace(ws, { type: "terminal-ended", sessionId: "s2" });
  expect(ws.terminals.map(({ localId }) => localId)).toEqual(["tab", "live"]);
  expect(ws.terminals[0]).toMatchObject({ running: false, busy: false });
  // A view that attaches after the end says so again: nothing changes.
  expect(
    transitionWorkspace(ws, { type: "terminal-ended", sessionId: "s2" }),
  ).toBe(ws);

  // A tab whose command still runs closes back to its chip.
  ws = transitionWorkspace(ws, { type: "close", key: "terminal:live" });
  expect(ws.terminals.find(({ localId }) => localId === "live")).toMatchObject({
    background: true,
    running: true,
  });
  // One whose command ended closes for good, and nothing reopens it.
  ws = transitionWorkspace(ws, { type: "close", key: "terminal:tab" });
  expect(ws.terminals.map(({ localId }) => localId)).toEqual(["live"]);
  ws = transitionWorkspace(ws, {
    type: "close",
    key: "terminal:live",
    force: true,
  });
  expect(ws.terminals).toEqual([]);
  expect(ws.closedTabs).toEqual([]);
});

it("keeps shells and unsent chats only for a move to another window", () => {
  const ws: Workspace = {
    ...emptyUtilityWorkspace(),
    chats: [
      { localId: "sent", mode: "min", sessionId: "session" },
      { localId: "draft", mode: "partial" },
    ],
    terminals: [
      { localId: "shell", title: "zsh", ptySessionId: "pty-1", busy: true },
      { localId: "agent", title: "build", attachSessionId: "pty-2" },
      {
        localId: "remote",
        title: "server",
        remoteSessionId: "chat-9",
        ptySessionId: "pty-3",
      },
      { localId: "starting", title: "" },
    ],
    activeTabKey: "terminal:shell",
  };
  // A restart keeps neither: the shells end with the app.
  const restart = serializeWorkspace(ws);
  expect(restart.terminals).toEqual([]);
  expect(restart.chats.map((chat) => chat.localId)).toEqual(["sent"]);
  expect(restart.activeTabKey).toBeUndefined();
  // A move takes a shell here over, keeps an agent's terminal and opens a
  // remote chat's shell again; the chat not sent yet goes too.
  const moving = serializeWorkspace(ws, { moving: true });
  expect(moving.terminals).toEqual([
    {
      localId: "shell",
      title: "zsh",
      adoptSessionId: "pty-1",
      ptySessionId: "pty-1",
    },
    { localId: "agent", title: "build", attachSessionId: "pty-2" },
    {
      localId: "remote",
      title: "server",
      remoteSessionId: "chat-9",
      restoreSessionId: "pty-3",
    },
  ]);
  expect(moving.chats.map((chat) => chat.localId)).toEqual(["sent", "draft"]);
  expect(moving.activeTabKey).toBe("terminal:shell");
  const opened = hydrateWorkspace(JSON.parse(JSON.stringify(moving)), {
    moved: true,
  });
  expect(opened?.terminals).toEqual(moving.terminals);
  expect(opened?.activeTabKey).toBe("terminal:shell");
  // Only a hand-off brings shells: a saved workspace never does, even one
  // that holds them.
  expect(
    hydrateWorkspace(JSON.parse(JSON.stringify(moving)))?.terminals,
  ).toEqual([]);
});

it("nests a dragged tab under a chat, opens a folded group for it, and takes it out again", () => {
  const page = (localId: string, agentControlled = false) => ({
    localId,
    profileId: "p",
    initialUrl: `https://example.com/${localId}`,
    url: `https://example.com/${localId}`,
    title: localId,
    faviconUrl: null,
    ...(agentControlled ? { agentControlled } : {}),
  });
  const ws: Workspace = {
    ...initial(),
    chats: [
      {
        localId: "c",
        mode: "tab",
        sessionId: "session",
        surfacesCollapsed: true,
      },
      { localId: "d", mode: "tab", sessionId: "other" },
    ],
    browsers: [page("b"), page("held", true)],
    terminals: [
      {
        localId: "agent",
        title: "",
        chatLocalId: "c",
        attachSessionId: "pty",
        background: true,
      },
    ],
  };
  const nested = transitionWorkspace(ws, {
    type: "attach",
    key: "browser:b",
    chatLocalId: "c",
    beforeKey: null,
  });
  expect(nested.browsers[0]?.chatLocalId).toBe("c");
  expect(nested.chats[0]?.surfacesCollapsed).toBe(false);
  expect(orderedTabKeys(nested)).toEqual([
    "palette:a",
    "palette:b",
    "browser:held",
    "chat:c",
    "browser:b",
    "chat:d",
  ]);
  // A New Tab goes with a chat too, and leaves it before another tab.
  const left = transitionWorkspace(
    transitionWorkspace(nested, {
      type: "attach",
      key: "palette:a",
      chatLocalId: "d",
      beforeKey: null,
    }),
    {
      type: "attach",
      key: "browser:b",
      chatLocalId: null,
      beforeKey: "palette:b",
    },
  );
  expect(left.browsers[0]?.chatLocalId).toBeUndefined();
  expect(left.tabs[0]?.chatLocalId).toBe("d");
  expect(orderedTabKeys(left)).toEqual([
    "browser:b",
    "palette:b",
    "browser:held",
    "chat:c",
    "chat:d",
    "palette:a",
  ]);
  // What an agent uses stays with its chat; a chat never nests.
  expect(attachBlocker(ws, "browser:held", "c")).toMatch(/agent is using/);
  expect(attachBlocker(ws, "terminal:agent", null)).toMatch(/belongs to/);
  expect(attachBlocker(ws, "chat:d", "c")).toMatch(/another chat/);
  expect(attachBlocker(ws, "browser:gone", "c")).toMatch(/closed/);
  expect(
    transitionWorkspace(ws, {
      type: "attach",
      key: "browser:held",
      chatLocalId: "c",
      beforeKey: null,
    }),
  ).toBe(ws);
});
