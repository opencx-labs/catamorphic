import { resolveWorkspaceLayout, type SplitView } from "./workspace-layout.js";
import type { ChatDockEntry } from "./workspace-types.js";
import { tabKey, type WorkspaceTab } from "./workspace-types.js";

export interface BrowserEntry {
  localId: string;
  /** Session/profile the page lives in — fixed at tab creation. */
  profileId: string;
  initialUrl: string;
  url: string;
  title: string;
  faviconUrl: string | null;
  /** Chat this tab is attached to (its surfaces rail), if any. */
  chatLocalId?: string;
  /** An agent is driving this page; user interaction waits on Take over. */
  agentControlled?: boolean;
  /** Attached surface kept alive as a chip without occupying a tab. */
  background?: boolean;
}

export interface TerminalEntry {
  localId: string;
  floatingTool?: "terminal";
  macroId?: string;
  initialCommand?: string;
  /** Shell title (OSC 0/2) — feeds the tab label. */
  title: string;
  /** Chat this tab is attached to (its surfaces rail), if any. */
  chatLocalId?: string;
  /** Attached to an agent-owned PTY session instead of spawning one. */
  attachSessionId?: string;
  /** PTY session backing this tab (agents read terminals through it). */
  ptySessionId?: string;
  /**
   * Reopened tab (Cmd+Shift+T): the closed session whose scrollback
   * replays above the fresh shell.
   */
  restoreSessionId?: string;
  /** A foreground command is running right now (chip spinner). */
  busy?: boolean;
  /** The agent is driving this terminal; input waits on Take over. */
  agentControlled?: boolean;
  /** Agent terminals: process still running (activity indicator). */
  running?: boolean;
  /**
   * Agent terminal without a workspace tab: the PTY runs and the chip
   * rides the chat's surfaces rail, but no tab appears and focus stays
   * put. Cleared when the user clicks the chip or the agent shows the
   * terminal via open_surface; closing an agent-controlled terminal tab
   * sets it back instead of killing the shell.
   */
  background?: boolean;
}

export interface EditorEntry {
  line?: number;
  column?: number;
  navigation?: string;
  localId: string;
  /** Open file (project-relative), or null while the picker shows. */
  filePath: string | null;
  /** Unsaved draft in the tab — a dot on the tab icon. */
  dirty: boolean;
  /** Chat this tab is attached to (its surfaces rail), if any. */
  chatLocalId?: string;
  /** Attached surface kept as a chip without occupying a tab. */
  background?: boolean;
}

/** Snapshot of a closed tab, enough to bring it back (Cmd+Shift+T). */
export type ClosedTab = (
  | {
      kind: "browser";
      url: string;
      title: string;
      faviconUrl: string | null;
      profileId: string;
      chatLocalId?: string;
    }
  | {
      kind: "terminal";
      chatLocalId?: string;
      /** Dead PTY whose scrollback the reopened tab replays. */
      ptySessionId?: string;
    }
  | { kind: "editor"; filePath: string | null; chatLocalId?: string }
  | { kind: "chat"; sessionId?: string; incognito?: boolean }
  | { kind: "screen"; tab: WorkspaceTab }
) & {
  /** The other pane when this tab was half of a split, to re-tile. */
  splitPartnerKey?: string;
  splitSide?: "left" | "right";
};

export const CLOSED_TABS_KEPT = 10;

export interface Workspace {
  tabs: WorkspaceTab[];
  activeTabKey?: string;
  /** A live surface over the active tab; expanding never remounts it. */
  floatingKey?: string;
  chats: ChatDockEntry[];
  activeChatId?: string;
  browsers: BrowserEntry[];
  terminals: TerminalEntry[];
  editors: EditorEntry[];
  split: SplitView | null;
  /**
   * User-arranged strip order (drag to reorder). Keys not listed append
   * in their natural per-kind order; stale keys are ignored — only drag
   * mutations write it.
   */
  tabOrder: string[];
  /** Recently closed tabs, newest last (Cmd+Shift+T restores). */
  closedTabs: ClosedTab[];
}

export const newChatEntry = (
  mode: ChatDockEntry["mode"],
  opts?: { incognito?: boolean },
): ChatDockEntry => ({
  localId: crypto.randomUUID(),
  mode,
  ...(opts?.incognito ? { incognito: true } : {}),
});

// A fresh project workspace greets the user with a palette "New Tab" —
// same surface as Cmd+T; closing everything later (zero tabs) is fine.
export const emptyWorkspace = (): Workspace => {
  const tab: WorkspaceTab = {
    kind: "palette",
    name: crypto.randomUUID(),
    label: "New Tab",
  };
  return {
    tabs: [tab],
    chats: [],
    activeTabKey: tabKey(tab),
    browsers: [],
    terminals: [],
    editors: [],
    split: null,
    tabOrder: [],
    closedTabs: [],
  };
};

/**
 * Profile-local, non-persisted browser surface used before a first project
 * exists. Remote sign-in still belongs in the app, even though there is not
 * yet a project workspace to own its temporary tab.
 */
export const emptyUtilityWorkspace = (): Workspace => ({
  tabs: [],
  chats: [],
  browsers: [],
  terminals: [],
  editors: [],
  split: null,
  tabOrder: [],
  closedTabs: [],
});

export const chatTabKey = (localId: string) => `chat:${localId}`;
export const browserTabKey = (localId: string) => `browser:${localId}`;
export const terminalTabKey = (localId: string) => `terminal:${localId}`;
export const editorTabKey = (localId: string) => `editor:${localId}`;

/**
 * The restart-surviving projection of a workspace, persisted per project
 * (desktop.workspace_states) so a relaunch lands where the user left off.
 * Dropped because they cannot survive: terminals (the PTY dies with the
 * app), sessionless chats (nothing to reopen), unsent composer state,
 * agent-setup tabs (they re-open themselves), and mcpapp tabs (their tool
 * results are runtime data). Editor tabs lose unsaved buffers; browser
 * tabs reopen on their last URL. Workflow tabs retain their draft source and
 * baseline so returning to a project can detect external conflicts.
 */
export const serializeWorkspace = (ws: Workspace): Workspace => {
  const chats = ws.chats
    .filter((chat) => chat.sessionId)
    .map(({ pendingMessage: _pending, ...chat }) => chat);
  const chatIds = new Set(chats.map((chat) => chat.localId));
  const chatRef = (id: string | undefined) =>
    id && chatIds.has(id) ? { chatLocalId: id } : {};
  const browsers = ws.browsers.map((browser) => ({
    localId: browser.localId,
    profileId: browser.profileId,
    initialUrl: browser.url || browser.initialUrl,
    url: browser.url,
    title: browser.title,
    faviconUrl: browser.faviconUrl,
    ...chatRef(browser.chatLocalId),
    ...(browser.background ? { background: true } : {}),
  }));
  const editors = ws.editors.map((editor) => ({
    localId: editor.localId,
    filePath: editor.filePath,
    dirty: false,
    ...chatRef(editor.chatLocalId),
    ...(editor.background ? { background: true } : {}),
  }));
  const tabs = ws.tabs.filter(
    (tab) => tab.kind !== "agent-setup" && tab.kind !== "mcpapp",
  );
  const keys = new Set([
    ...tabs.map(tabKey),
    ...chats
      .filter((chat) => chat.mode === "tab")
      .map((chat) => chatTabKey(chat.localId)),
    ...browsers
      .filter((browser) => !browser.background)
      .map((browser) => browserTabKey(browser.localId)),
    ...editors
      .filter((editor) => !editor.background)
      .map((editor) => editorTabKey(editor.localId)),
  ]);
  return {
    tabs,
    ...(ws.activeTabKey && keys.has(ws.activeTabKey)
      ? { activeTabKey: ws.activeTabKey }
      : {}),
    ...(ws.floatingKey && keys.has(ws.floatingKey)
      ? { floatingKey: ws.floatingKey }
      : {}),
    chats,
    ...(ws.activeChatId && chatIds.has(ws.activeChatId)
      ? { activeChatId: ws.activeChatId }
      : {}),
    browsers,
    terminals: [],
    editors,
    split:
      ws.split && keys.has(ws.split.leftKey) && keys.has(ws.split.rightKey)
        ? ws.split
        : null,
    tabOrder: ws.tabOrder.filter((key) => keys.has(key)),
    closedTabs: ws.closedTabs.filter((record) => record.kind !== "terminal"),
  };
};

/** Rebuild a Workspace from a persisted snapshot; null = start fresh. */
export const hydrateWorkspace = (raw: unknown): Workspace | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const snapshot = raw as Partial<Workspace>;
  const ws: Workspace = {
    tabs: Array.isArray(snapshot.tabs)
      ? snapshot.tabs.filter(
          (tab) => tab.kind !== "agent-setup" && tab.kind !== "mcpapp",
        )
      : [],
    chats: Array.isArray(snapshot.chats) ? snapshot.chats : [],
    browsers: Array.isArray(snapshot.browsers) ? snapshot.browsers : [],
    terminals: [],
    editors: Array.isArray(snapshot.editors) ? snapshot.editors : [],
    split: snapshot.split ?? null,
    tabOrder: Array.isArray(snapshot.tabOrder) ? snapshot.tabOrder : [],
    closedTabs: Array.isArray(snapshot.closedTabs) ? snapshot.closedTabs : [],
    ...(typeof snapshot.activeTabKey === "string"
      ? { activeTabKey: snapshot.activeTabKey }
      : {}),
    ...(typeof snapshot.floatingKey === "string"
      ? { floatingKey: snapshot.floatingKey }
      : {}),
    ...(typeof snapshot.activeChatId === "string"
      ? { activeChatId: snapshot.activeChatId }
      : {}),
  };
  const anything =
    ws.tabs.length > 0 ||
    ws.chats.length > 0 ||
    ws.browsers.length > 0 ||
    ws.editors.length > 0;
  if (!anything) return null;
  if (!ws.activeTabKey && ws.tabs[0]) ws.activeTabKey = tabKey(ws.tabs[0]);
  return ws;
};

/**
 * Surface entries that own workspace tabs. Background attached surfaces
 * are excluded from every tab derivation while their resource and chip stay
 * alive. The chip is the durable handle; the tab is only one view of it.
 */
export const tabbedBrowsers = (ws: Workspace) =>
  ws.browsers.filter((browser) => !browser.background);

export const tabbedTerminals = (ws: Workspace) =>
  ws.terminals.filter((terminal) => !terminal.background);

export const tabbedEditors = (ws: Workspace) =>
  ws.editors.filter((editor) => !editor.background);

/** Rendering, read receipts, and activity cues agree about both split panes. */
export const workspaceLayout = (ws: Workspace) =>
  resolveWorkspaceLayout({
    ...ws,
    tabKeys: orderedTabKeys(ws, { includeCollapsed: true }),
  });
export const chatVisible = (ws: Workspace, chat: ChatDockEntry) =>
  chat.mode === "partial" ||
  (chat.mode === "tab" &&
    Boolean(workspaceLayout(ws).viewSlots[chatTabKey(chat.localId)]));

/** Tab keys attached to a chat, in per-kind order. */
export const attachedTabKeys = (ws: Workspace, chatLocalId: string) => [
  ...ws.tabs.filter((tab) => tab.chatLocalId === chatLocalId).map(tabKey),
  ...tabbedBrowsers(ws)
    .filter((browser) => browser.chatLocalId === chatLocalId)
    .map((browser) => browserTabKey(browser.localId)),
  ...tabbedTerminals(ws)
    .filter((terminal) => terminal.chatLocalId === chatLocalId)
    .map((terminal) => terminalTabKey(terminal.localId)),
  ...tabbedEditors(ws)
    .filter((editor) => editor.chatLocalId === chatLocalId)
    .map((editor) => editorTabKey(editor.localId)),
];

/**
 * Tab-strip order, the single source for the strip AND keyboard cycling:
 * `tabOrder` (drag-arranged) first, unknown keys appended in per-kind
 * order — then tabs attached to a tab-mode chat are pulled out and
 * clustered right after their chat (the group), unless collapsed.
 */
export const orderedTabKeys = (
  ws: Workspace,
  opts?: { includeCollapsed?: boolean },
): string[] => {
  const tabChats = ws.chats.filter((chat) => chat.mode === "tab");
  const tabChatIds = new Set(tabChats.map((chat) => chat.localId));
  const grouped = new Set(
    tabChats.flatMap((chat) => attachedTabKeys(ws, chat.localId)),
  );
  const natural = [
    ...ws.tabs.map(tabKey),
    ...tabbedBrowsers(ws).map((browser) => browserTabKey(browser.localId)),
    ...tabbedTerminals(ws).map((terminal) => terminalTabKey(terminal.localId)),
    ...tabbedEditors(ws).map((editor) => editorTabKey(editor.localId)),
    ...tabChats.map((chat) => chatTabKey(chat.localId)),
  ];
  const naturalSet = new Set(natural);
  const order = [
    ...ws.tabOrder.filter((key) => naturalSet.has(key)),
    ...natural.filter((key) => !ws.tabOrder.includes(key)),
  ];
  const result: string[] = [];
  for (const key of order) {
    if (grouped.has(key)) continue; // clustered after its chat below
    result.push(key);
    if (!key.startsWith("chat:")) continue;
    const chatId = key.slice("chat:".length);
    if (!tabChatIds.has(chatId)) continue;
    const chat = ws.chats.find((candidate) => candidate.localId === chatId);
    if (!chat?.surfacesCollapsed || opts?.includeCollapsed) {
      result.push(...attachedTabKeys(ws, chatId));
    }
  }
  return result;
};

export const nextActiveTabKey = (
  ws: Workspace,
  closedKey: string,
  chats: ChatDockEntry[],
): string | undefined => {
  const keys = [
    ...ws.tabs.map(tabKey),
    ...tabbedBrowsers(ws).map((browser) => browserTabKey(browser.localId)),
    ...tabbedTerminals(ws).map((terminal) => terminalTabKey(terminal.localId)),
    ...tabbedEditors(ws).map((editor) => editorTabKey(editor.localId)),
    ...chats
      .filter((chat) => chat.mode === "tab")
      .map((chat) => chatTabKey(chat.localId)),
  ].filter((key) => key !== closedKey);
  // Closing one pane of a split lands on its partner, not the last tab.
  const partner =
    ws.split && closedKey === ws.split.leftKey
      ? ws.split.rightKey
      : ws.split && closedKey === ws.split.rightKey
        ? ws.split.leftKey
        : undefined;
  if (partner && keys.includes(partner)) return partner;
  return keys.at(-1);
};

export type WorkspaceEvent =
  | { type: "close"; key: string; force?: boolean; discardDraft?: boolean }
  | { type: "reopen"; localId: string }
  | { type: "select"; key: string }
  | { type: "focus"; key: string }
  | { type: "side"; key: string; previous?: string; side?: "left" | "right" }
  | { type: "float"; key: string; previous?: string }
  | { type: "toggle-chat"; localId: string }
  | { type: "reveal-chat"; localId: string }
  | { type: "cycle-chat"; direction: -1 | 1 }
  | { type: "reorder"; key: string; beforeKey: string | null }
  | { type: "finish-expansion"; key: string; split: SplitView }
  | { type: "dismiss-floating"; key?: string };

/** A retained agent chip becomes a view without creating a second native resource. */
function materializeSurface(ws: Workspace, key: string): Workspace {
  const localId = key.slice(key.indexOf(":") + 1);
  if (key.startsWith("app:") && !ws.tabs.some((tab) => tabKey(tab) === key))
    return { ...ws, tabs: [...ws.tabs, { kind: "app", name: localId }] };
  if (
    key.startsWith("artifact:") &&
    !ws.tabs.some((tab) => tabKey(tab) === key)
  )
    return { ...ws, tabs: [...ws.tabs, { kind: "artifact", name: localId }] };
  if (key.startsWith("browser:"))
    return {
      ...ws,
      browsers: ws.browsers.map((item) =>
        item.localId === localId ? { ...item, background: false } : item,
      ),
    };
  if (key.startsWith("editor:"))
    return {
      ...ws,
      editors: ws.editors.map((item) =>
        item.localId === localId ? { ...item, background: false } : item,
      ),
    };
  if (key.startsWith("terminal:"))
    return {
      ...ws,
      terminals: ws.terminals.map((item) =>
        item.localId === localId ? { ...item, background: false } : item,
      ),
    };
  return ws;
}

/** All workspace mutations pass this boundary, including resource creation/close. */
export function reconcileWorkspace(
  previous: Workspace,
  updated: Workspace,
): Workspace {
  if (previous === updated) return previous;
  const keys = orderedTabKeys(updated, { includeCollapsed: true });
  const floatingKey =
    updated.floatingKey &&
    updated.floatingKey !== updated.activeTabKey &&
    keys.includes(updated.floatingKey) &&
    !(
      updated.activeTabKey !== previous.activeTabKey &&
      updated.floatingKey === previous.floatingKey
    )
      ? updated.floatingKey
      : undefined;
  const layout = resolveWorkspaceLayout({
    ...updated,
    floatingKey,
    tabKeys: keys,
  });
  const activeTabKey =
    updated.activeTabKey && keys.includes(updated.activeTabKey)
      ? updated.activeTabKey
      : undefined;
  return floatingKey === updated.floatingKey &&
    layout.split === updated.split &&
    activeTabKey === updated.activeTabKey
    ? updated
    : { ...updated, floatingKey, split: layout.split, activeTabKey };
}

/** Pure navigation. IO, permission prompts and motion scheduling stay in the host. */
export function transitionWorkspace(
  ws: Workspace,
  event: WorkspaceEvent,
): Workspace {
  return reconcileWorkspace(ws, applyWorkspaceEvent(ws, event));
}

function applyWorkspaceEvent(
  original: Workspace,
  event: WorkspaceEvent,
): Workspace {
  const ws =
    event.type === "focus" || event.type === "side" || event.type === "float"
      ? materializeSurface(original, event.key)
      : original;
  switch (event.type) {
    case "close": {
      const { key, force, discardDraft } = event;
      const opts = { force, discardDraft };

      // Snapshot enough to bring the tab back with Cmd+Shift+T — plus its
      // split context so a reopened pane re-tiles with its partner.
      const splitContext =
        ws.split && key === ws.split.leftKey
          ? { splitPartnerKey: ws.split.rightKey, splitSide: "left" as const }
          : ws.split && key === ws.split.rightKey
            ? { splitPartnerKey: ws.split.leftKey, splitSide: "right" as const }
            : {};
      const remember = (record: ClosedTab | null): ClosedTab[] =>
        record
          ? [...ws.closedTabs, record].slice(-CLOSED_TABS_KEPT)
          : ws.closedTabs;
      if (key.startsWith("browser:")) {
        const localId = key.slice("browser:".length);
        const closing = ws.browsers.find(
          (browser) => browser.localId === localId,
        );
        // Attached pages belong to the chat's surface rail. Closing the
        // workspace tab only detaches that view; the page and chip remain
        // until the chip's explicit remove action disposes them.
        if (closing?.chatLocalId && !opts?.force) {
          const browsers = ws.browsers.map((browser) =>
            browser.localId === localId
              ? { ...browser, background: true }
              : browser,
          );
          return {
            ...ws,
            browsers,
            activeTabKey:
              ws.activeTabKey === key
                ? nextActiveTabKey({ ...ws, browsers }, key, ws.chats)
                : ws.activeTabKey,
          };
        }
        const browsers = ws.browsers.filter(
          (browser) => browser.localId !== localId,
        );
        return {
          ...ws,
          browsers,
          closedTabs: remember(
            closing
              ? {
                  kind: "browser",
                  url: closing.url || closing.initialUrl,
                  title: closing.title,
                  faviconUrl: closing.faviconUrl,
                  profileId: closing.profileId,
                  chatLocalId: closing.chatLocalId,
                  ...splitContext,
                }
              : null,
          ),
          activeTabKey:
            ws.activeTabKey === key
              ? nextActiveTabKey({ ...ws, browsers }, key, ws.chats)
              : ws.activeTabKey,
        };
      }
      // Closing an unattached terminal tab kills its shell (the screen's
      // unmount cleanup sends the PTY kill); reopening starts a fresh shell.
      if (key.startsWith("terminal:")) {
        const localId = key.slice("terminal:".length);
        const closing = ws.terminals.find(
          (terminal) => terminal.localId === localId,
        );
        // Any terminal attached to a chat returns to the background instead
        // of dying. Taking control changes who may type, not who owns its
        // durable chip. Explicit chip/agent removal (`force`) is final.
        if (closing?.chatLocalId && !opts?.force) {
          const terminals = ws.terminals.map((terminal) =>
            terminal.localId === localId
              ? { ...terminal, background: true }
              : terminal,
          );
          return {
            ...ws,
            terminals,
            activeTabKey:
              ws.activeTabKey === key
                ? nextActiveTabKey({ ...ws, terminals }, key, ws.chats)
                : ws.activeTabKey,
          };
        }
        const terminals = ws.terminals.filter(
          (terminal) => terminal.localId !== localId,
        );
        return {
          ...ws,
          terminals,
          closedTabs: remember(
            closing
              ? {
                  kind: "terminal",
                  chatLocalId: closing.chatLocalId,
                  // User terminals only: reopening replays the dead
                  // shell's scrollback (agent sessions aren't buried).
                  ptySessionId: closing.attachSessionId
                    ? undefined
                    : closing.ptySessionId,
                  ...splitContext,
                }
              : null,
          ),
          activeTabKey:
            ws.activeTabKey === key
              ? nextActiveTabKey({ ...ws, terminals }, key, ws.chats)
              : ws.activeTabKey,
        };
      }
      // Attached files mirror attached pages: tab close hides the view but
      // preserves the editor state and chat chip. Explicit removal is final.
      if (key.startsWith("editor:")) {
        const localId = key.slice("editor:".length);
        const closing = ws.editors.find((editor) => editor.localId === localId);
        if (closing?.chatLocalId && !opts?.force) {
          const editors = ws.editors.map((editor) =>
            editor.localId === localId
              ? { ...editor, background: true }
              : editor,
          );
          return {
            ...ws,
            editors,
            activeTabKey:
              ws.activeTabKey === key
                ? nextActiveTabKey({ ...ws, editors }, key, ws.chats)
                : ws.activeTabKey,
          };
        }
        const editors = ws.editors.filter(
          (editor) => editor.localId !== localId,
        );
        return {
          ...ws,
          editors,
          closedTabs: remember(
            closing
              ? {
                  kind: "editor",
                  filePath: closing.filePath,
                  chatLocalId: closing.chatLocalId,
                  ...splitContext,
                }
              : null,
          ),
          activeTabKey:
            ws.activeTabKey === key
              ? nextActiveTabKey({ ...ws, editors }, key, ws.chats)
              : ws.activeTabKey,
        };
      }
      // Closing a chat tab closes the chat (the session stays in the
      // sidebar); it does NOT linger as a bubble.
      if (key.startsWith("chat:")) {
        const localId = key.slice("chat:".length);
        const closing = ws.chats.find((chat) => chat.localId === localId);
        const chats = ws.chats.filter((chat) => chat.localId !== localId);
        return {
          ...ws,
          chats,
          closedTabs: remember(
            closing
              ? {
                  kind: "chat",
                  sessionId: closing.sessionId,
                  incognito: closing.incognito,
                  ...splitContext,
                }
              : null,
          ),
          activeChatId:
            ws.activeChatId === localId ? undefined : ws.activeChatId,
          activeTabKey:
            ws.activeTabKey === key
              ? nextActiveTabKey(ws, key, chats)
              : ws.activeTabKey,
        };
      }
      const closingTab = ws.tabs.find((tab) => tabKey(tab) === key);
      const tabs = ws.tabs.filter((tab) => tabKey(tab) !== key);
      return {
        ...ws,
        tabs,
        // Palette "New Tab"s and the setup wizard aren't worth restoring.
        closedTabs: remember(
          closingTab &&
            closingTab.kind !== "palette" &&
            closingTab.kind !== "agent-setup"
            ? {
                kind: "screen",
                tab:
                  closingTab.kind === "workflow" && opts?.discardDraft
                    ? { ...closingTab, draft: false, workflowDraft: undefined }
                    : closingTab,
                ...splitContext,
              }
            : null,
        ),
        activeTabKey:
          ws.activeTabKey === key
            ? nextActiveTabKey({ ...ws, tabs }, key, ws.chats)
            : ws.activeTabKey,
      };
    }
    case "reopen": {
      const record = ws.closedTabs.at(-1);
      if (!record) return ws;
      const closedTabs = ws.closedTabs.slice(0, -1);
      let key: string;
      let patch: Partial<Workspace> = {};
      switch (record.kind) {
        case "browser": {
          const entry: BrowserEntry = {
            localId: event.localId,
            profileId: record.profileId,
            initialUrl: record.url,
            url: record.url,
            title: record.title,
            faviconUrl: record.faviconUrl,
            chatLocalId: record.chatLocalId,
          };
          key = browserTabKey(entry.localId);
          patch = { browsers: [...ws.browsers, entry] };
          break;
        }
        case "terminal": {
          const entry: TerminalEntry = {
            localId: event.localId,
            title: "",
            chatLocalId: record.chatLocalId,
            restoreSessionId: record.ptySessionId,
          };
          key = terminalTabKey(entry.localId);
          patch = { terminals: [...ws.terminals, entry] };
          break;
        }
        case "editor": {
          const entry: EditorEntry = {
            localId: event.localId,
            filePath: record.filePath,
            dirty: false,
            chatLocalId: record.chatLocalId,
          };
          key = editorTabKey(entry.localId);
          patch = { editors: [...ws.editors, entry] };
          break;
        }
        case "chat": {
          const entry: ChatDockEntry = {
            localId: event.localId,
            mode: "tab",
            incognito: record.incognito,
            sessionId: record.sessionId,
          };
          key = chatTabKey(entry.localId);
          patch = { chats: [...ws.chats, entry], activeChatId: entry.localId };
          break;
        }
        case "screen": {
          key = tabKey(record.tab);
          patch = ws.tabs.some((tab) => tabKey(tab) === key)
            ? {}
            : { tabs: [...ws.tabs, record.tab] };
          break;
        }
      }
      const partnerAlive =
        record.splitPartnerKey &&
        orderedTabKeys(ws).includes(record.splitPartnerKey);
      const split = partnerAlive
        ? record.splitSide === "left"
          ? {
              leftKey: key,
              rightKey: record.splitPartnerKey as string,
              ratio: 0.5,
            }
          : {
              leftKey: record.splitPartnerKey as string,
              rightKey: key,
              ratio: 0.5,
            }
        : null;
      return { ...ws, ...patch, closedTabs, activeTabKey: key, split };
    }

    case "dismiss-floating":
      return event.key && ws.floatingKey !== event.key
        ? ws
        : { ...ws, floatingKey: undefined };
    case "finish-expansion":
      return ws.split === event.split && ws.activeTabKey === event.key
        ? { ...ws, split: null }
        : ws;
    case "focus":
    case "side": {
      const { key } = event;
      const localId = key.startsWith("chat:") ? key.slice(5) : undefined;
      const chats = localId
        ? ws.chats.map((chat) =>
            chat.localId === localId ? { ...chat, mode: "tab" as const } : chat,
          )
        : ws.chats;
      const next = {
        ...ws,
        chats,
        ...(localId ? { activeChatId: localId } : {}),
      };
      if (!orderedTabKeys(next, { includeCollapsed: true }).includes(key))
        return ws;
      const anchor =
        ws.activeTabKey && ws.activeTabKey !== key
          ? ws.activeTabKey
          : event.type === "side" && event.previous !== key
            ? event.previous
            : undefined;
      const split =
        event.type === "side" &&
        anchor &&
        orderedTabKeys(next, { includeCollapsed: true }).includes(anchor)
          ? event.side === "left"
            ? { leftKey: key, rightKey: anchor, ratio: 0.5 }
            : { leftKey: anchor, rightKey: key, ratio: 0.5 }
          : null;
      return { ...next, floatingKey: undefined, activeTabKey: key, split };
    }
    case "select": {
      const { key } = event;
      if (!orderedTabKeys(ws, { includeCollapsed: true }).includes(key))
        return ws;
      // While tiled, picking a tab outside the split replaces the focused
      // pane (Arc's model) — picking a split member just moves focus.
      const splitActive =
        ws.split &&
        (ws.activeTabKey === ws.split.leftKey ||
          ws.activeTabKey === ws.split.rightKey);
      const inSplit =
        ws.split && (key === ws.split.leftKey || key === ws.split.rightKey);
      const split = !ws.split
        ? null
        : inSplit
          ? ws.split
          : splitActive
            ? ws.activeTabKey === ws.split.leftKey
              ? { ...ws.split, leftKey: key }
              : { ...ws.split, rightKey: key }
            : null;
      return {
        ...ws,
        floatingKey: undefined,
        split,
        activeTabKey: key,
        ...(key.startsWith("chat:")
          ? { activeChatId: key.slice("chat:".length) }
          : {}),
      };
    }
    case "toggle-chat": {
      const { localId } = event;
      const target = ws.chats.find((chat) => chat.localId === localId);
      if (!target) return ws;
      const isExpandedActive =
        target.mode !== "min" && ws.activeChatId === localId;
      // Bubbles reopen as the floating dock, never as a full tab — going
      // to a tab is always an explicit gesture (the expand button).
      const nextMode = isExpandedActive
        ? ("min" as const)
        : ("partial" as const);
      return {
        ...ws,
        activeChatId: localId,
        floatingKey: nextMode === "partial" ? undefined : ws.floatingKey,
        activeTabKey:
          ws.activeTabKey === chatTabKey(localId)
            ? nextActiveTabKey(ws, chatTabKey(localId), ws.chats)
            : ws.activeTabKey,
        chats: ws.chats.map((chat) => {
          if (chat.localId !== localId) {
            // Floating docks are exclusive; background chat tabs stay put.
            return chat.mode === "partial" ? { ...chat, mode: "min" } : chat;
          }
          return { ...chat, mode: nextMode };
        }),
      };
    }
    case "reveal-chat": {
      const { localId } = event;
      const chat = ws.chats.find((candidate) => candidate.localId === localId);
      if (!chat) return ws;
      if (chat.mode === "tab") {
        return {
          ...ws,
          activeChatId: localId,
          floatingKey: undefined,
          activeTabKey: chatTabKey(localId),
        };
      }
      return {
        ...ws,
        activeChatId: localId,
        floatingKey: undefined,
        chats: ws.chats.map((candidate) =>
          candidate.localId === localId
            ? { ...candidate, mode: "partial" }
            : candidate.mode === "partial"
              ? { ...candidate, mode: "min" }
              : candidate,
        ),
      };
    }
    case "cycle-chat": {
      const { direction } = event;
      const cycle = ws.chats.filter((chat) => chat.mode !== "tab");
      if (cycle.length === 0) return ws;
      const index = cycle.findIndex(
        (chat) => chat.localId === ws.activeChatId && chat.mode === "partial",
      );
      const next =
        index === -1
          ? direction === 1
            ? cycle[0]
            : cycle.at(-1)
          : cycle[(index + direction + cycle.length) % cycle.length];
      if (!next) return ws;
      return {
        ...ws,
        activeChatId: next.localId,
        floatingKey: undefined,
        chats: ws.chats.map((chat) =>
          chat.localId === next.localId
            ? { ...chat, mode: "partial" }
            : chat.mode === "partial"
              ? { ...chat, mode: "min" }
              : chat,
        ),
      };
    }
    case "reorder": {
      const { key, beforeKey } = event;
      const order = orderedTabKeys(ws, { includeCollapsed: true }).filter(
        (candidate) => candidate !== key,
      );
      const at = beforeKey ? order.indexOf(beforeKey) : -1;
      if (at === -1) order.push(key);
      else order.splice(at, 0, key);
      return { ...ws, tabOrder: order };
    }
    case "float": {
      const { key } = event;
      if (
        !orderedTabKeys(ws, { includeCollapsed: true }).includes(key) &&
        !ws.chats.some((chat) => chatTabKey(chat.localId) === key)
      )
        return original;
      const keys = orderedTabKeys(ws);
      const previous = event.previous;
      const anchor =
        ws.activeTabKey !== key
          ? ws.activeTabKey
          : previous && previous !== key && keys.includes(previous)
            ? previous
            : keys.find((candidate) => candidate !== key);
      if (key.startsWith("chat:")) {
        const localId = key.slice(5);
        return {
          ...ws,
          floatingKey: undefined,
          activeTabKey: anchor,
          split: null,
          activeChatId: localId,
          chats: ws.chats.map((chat) =>
            chat.localId === localId
              ? { ...chat, mode: "partial" }
              : chat.mode === "partial"
                ? { ...chat, mode: "min" }
                : chat,
          ),
        };
      }
      return {
        ...ws,
        activeTabKey: anchor,
        floatingKey: key,
        split: null,
        chats: ws.chats.map((chat) =>
          chat.mode === "partial" ? { ...chat, mode: "min" } : chat,
        ),
      };
    }
  }
}
