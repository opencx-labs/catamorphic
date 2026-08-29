import {
  useAgentSessions,
  useForkAgentSession,
  useProjects,
  useUpdateAgentSession,
  useWorkflows,
} from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import {
  ChevronRight,
  Columns2,
  FolderPlus,
  GitBranch,
  LayoutGrid,
  Link2,
  MessageSquare,
  PanelLeft,
  Plus,
  Settings as SettingsIcon,
  Sparkles,
  Wand2,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  lazy,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ActionId, KEYBINDING_ACTIONS } from "../shared/actions.js";
import {
  type AgentPointer,
  AgentPointers,
} from "./components/agent-pointers.js";
import { AgentWizard } from "./components/agent-wizard.js";
import { AnimatedTitle } from "./components/animated-title.js";
import { BookmarksNav } from "./components/bookmarks-nav.js";
import { ChatBubbles } from "./components/chat-bubbles.js";
import {
  ChatDock,
  type ChatDockEntry,
  type ChatSurface,
} from "./components/chat-dock.js";
import { ChatGlyph } from "./components/chat-icon.js";
import { CommandPalette } from "./components/command-palette.js";
import { ConfigureAgentModal } from "./components/configure-agent-modal.js";
import { ConnectorsModal } from "./components/connectors-modal.js";
import { DeleteProjectModal } from "./components/delete-project-modal.js";
import {
  ElicitationModal,
  type PendingElicitation,
} from "./components/elicitation-modal.js";
import { GitNav } from "./components/git-nav.js";
import { MobilePairingModal } from "./components/mobile-pairing-modal.js";
import { PendingButton } from "./components/pending-button.js";
import { ProfileBar } from "./components/profile-bar.js";
import { ProjectAgentConsentDialog } from "./components/project-agent-consent.js";
import { ProjectModal } from "./components/project-modal.js";
import { ProjectSwitcher } from "./components/project-switcher.js";
import { PrsNav } from "./components/prs-nav.js";
import {
  RemoteProposeModal,
  RemotePublishModal,
} from "./components/remote-actions-modals.js";
import { RemoteConnectModal } from "./components/remote-connect-modal.js";
import { RemoteConnectionIndicator } from "./components/remote-connection-indicator.js";
import { RemoteHistoryModal } from "./components/remote-history-modal.js";
import { type RemoteFeatures, RemoteNav } from "./components/remote-nav.js";
import { ShortcutHint } from "./components/shortcut-hint.js";
import { SidebarItemRow } from "./components/sidebar-item-row.js";
import {
  type PendingToolPermission,
  ToolPermissionModal,
} from "./components/tool-permission-modal";
import {
  tabKey,
  type WorkspaceTab,
  WorkspaceTabBar,
} from "./components/workspace-tabs.js";
import {
  type AgentEffort,
  type AgentsData,
  type AppPrefs,
  type ConnectLink,
  desktopApi,
  type Profile,
  type ProfilesData,
  type ProjectAgentInfo,
  type SessionCheckoutInfo,
  type SidebarConfig,
  type SidebarMenuEntry,
  type SidebarSectionConfig,
} from "./lib/desktop-api.js";
import { readEditorSelection } from "./lib/editor-selection.js";
import {
  formatBinding,
  matchesBinding,
  useKeybindings,
} from "./lib/keybindings.js";
import { notifyDesktop, playChime } from "./lib/notify.js";
import { skillInvocation } from "./lib/skills.js";
import { AppScreen, useApps } from "./screens/app-screen.js";
import {
  type BrowserPageState,
  BrowserScreen,
} from "./screens/browser-screen.js";
import { McpAppScreen } from "./screens/mcp-app-screen.js";
import { ProfileSettingsScreen } from "./screens/profile-settings-screen.js";
import { SettingsScreen } from "./screens/settings-screen.js";
import { TerminalScreen } from "./screens/terminal-screen.js";

// Monaco rides in these two screens (~half the renderer bundle); lazy
// chunks keep it off the startup parse path entirely.
const EditorScreen = lazy(() =>
  import("./screens/editor-screen.js").then((module) => ({
    default: module.EditorScreen,
  })),
);
const WorkflowScreen = lazy(() =>
  import("./screens/workflow-screen.js").then((module) => ({
    default: module.WorkflowScreen,
  })),
);
// The usage page (ADR 0057) is a rare destination; keep its chart code
// off the startup parse path.
const UsageScreen = lazy(() =>
  import("./screens/usage-screen.js").then((module) => ({
    default: module.UsageScreen,
  })),
);
// Diff tabs ride the same Monaco chunk; lazy for the same reason.
const DiffScreen = lazy(() =>
  import("./screens/diff-screen.js").then((module) => ({
    default: module.DiffScreen,
  })),
);

interface BrowserEntry {
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

interface TerminalEntry {
  localId: string;
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

interface EditorEntry {
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

/** Two tabs tiled side by side; the focused one is `activeTabKey`. */
interface SplitView {
  leftKey: string;
  rightKey: string;
  /** Left pane's fraction of the width (drag the divider to change). */
  ratio: number;
}

/** Snapshot of a closed tab, enough to bring it back (Cmd+Shift+T). */
type ClosedTab = (
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

const CLOSED_TABS_KEPT = 10;

/** What a ChatDock reports live; `unread` is derived here in the host. */
interface ChatLiveSignals {
  working: boolean;
  draft: boolean;
  awaitingInput: boolean;
}

const NO_CHAT_SIGNALS: ChatLiveSignals = {
  working: false,
  draft: false,
  awaitingInput: false,
};

interface Workspace {
  tabs: WorkspaceTab[];
  activeTabKey?: string;
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

const newChatEntry = (
  mode: ChatDockEntry["mode"],
  opts?: { incognito?: boolean },
): ChatDockEntry => ({
  localId: crypto.randomUUID(),
  mode,
  ...(opts?.incognito ? { incognito: true } : {}),
});

// A fresh project workspace greets the user with a palette "New Tab" —
// same surface as Cmd+T; closing everything later (zero tabs) is fine.
const emptyWorkspace = (): Workspace => {
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

const chatTabKey = (localId: string) => `chat:${localId}`;
const browserTabKey = (localId: string) => `browser:${localId}`;
const terminalTabKey = (localId: string) => `terminal:${localId}`;
const editorTabKey = (localId: string) => `editor:${localId}`;

const isPdfPath = (filePath: string) => /\.pdf$/i.test(filePath);

const fileNameFromPath = (filePath: string) =>
  filePath.split(/[\\/]/).at(-1) || filePath;

/** Resolve either an absolute agent path or a project-relative file path. */
const resolveProjectFileLocation = (
  projectRoot: string,
  filePath: string,
): { absolutePath: string; relativePath: string } => {
  const slashPath = filePath.replaceAll("\\", "/");
  const slashRoot = projectRoot.replaceAll("\\", "/").replace(/\/$/, "");
  const absolute =
    slashPath.startsWith("/") || /^[A-Za-z]:\//.test(slashPath)
      ? slashPath
      : `${slashRoot}/${slashPath}`;
  return {
    absolutePath: absolute,
    relativePath: absolute.startsWith(`${slashRoot}/`)
      ? absolute.slice(slashRoot.length + 1)
      : slashPath,
  };
};

/** A safely encoded local URL for Chromium's built-in PDF viewer. */
const localFileUrl = (absolutePath: string): string => {
  const url = new URL("file:///");
  url.pathname = absolutePath;
  return url.href;
};

/**
 * The restart-surviving projection of a workspace, persisted per project
 * (desktop.workspace_states) so a relaunch lands where the user left off.
 * Dropped because they cannot survive: terminals (the PTY dies with the
 * app), sessionless chats (nothing to reopen), unsent composer state,
 * agent-setup tabs (they re-open themselves), and mcpapp tabs (their tool
 * results are runtime data). Editor tabs lose unsaved buffers; browser
 * tabs reopen on their last URL.
 */
const serializeWorkspace = (ws: Workspace): Workspace => {
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
const hydrateWorkspace = (raw: unknown): Workspace | null => {
  if (typeof raw !== "object" || raw === null) return null;
  const snapshot = raw as Partial<Workspace>;
  const ws: Workspace = {
    tabs: Array.isArray(snapshot.tabs) ? snapshot.tabs : [],
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
const tabbedBrowsers = (ws: Workspace) =>
  ws.browsers.filter((browser) => !browser.background);

const tabbedTerminals = (ws: Workspace) =>
  ws.terminals.filter((terminal) => !terminal.background);

const tabbedEditors = (ws: Workspace) =>
  ws.editors.filter((editor) => !editor.background);

/** A chat's surface is on screen: the floating dock, or its focused tab. */
const chatVisible = (ws: Workspace, chat: ChatDockEntry) =>
  chat.mode === "partial" ||
  (chat.mode === "tab" && ws.activeTabKey === chatTabKey(chat.localId));

/** Tab keys attached to a chat, in per-kind order. */
const attachedTabKeys = (ws: Workspace, chatLocalId: string) => [
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
const orderedTabKeys = (
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

/** Offered to config-defined items that don't declare their own menu. */
const DEFAULT_CUSTOM_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
];

const truncateLabel = (value: string): string =>
  value.length <= 40 ? value : `${value.slice(0, 39)}…`;

/**
 * Veil over a surface an agent is driving: interaction is blocked (the
 * surface stays fully visible — watch the agent work live) until the
 * user takes control. A hairline accent ring marks the surface as
 * agent-held; the pill names the owner and offers the two moves that
 * make sense — jump to the owning chat, or take the keys.
 *
 * Stays mounted after `active` flips false to play fade-out (the mirror
 * of its fade-in enter) before disappearing, per the motion contract.
 */
function AgentControlOverlay({
  kind,
  active,
  onTakeOver,
  onGoToChat,
}: {
  kind: "terminal" | "page";
  active: boolean;
  onTakeOver: () => void;
  /** Reveal the chat driving this surface (absent when unattributed). */
  onGoToChat?: () => void;
}) {
  const [phase, setPhase] = useState<"in" | "out" | "gone">(
    active ? "in" : "gone",
  );
  useEffect(() => {
    setPhase((prev) => (active ? "in" : prev === "in" ? "out" : prev));
  }, [active]);
  if (phase === "gone") return null;
  const exiting = phase === "out";
  const anim = exiting ? "animate-fade-out" : "animate-fade-in";
  return (
    // Pill at the top: the floating chat dock owns the bottom center.
    <div
      className={`absolute inset-0 z-20 flex items-start justify-center pt-4 ${exiting ? "pointer-events-none" : ""}`}
      onAnimationEnd={(event) => {
        if (event.animationName === "fade-out") setPhase("gone");
      }}
    >
      <div
        className={`pointer-events-none absolute inset-0 ${anim} ring-2 ring-inset ring-accent/40`}
      />
      {!exiting && (
        /* The blocking layer keeps keys, clicks, and paste away from an
           agent-driven surface — but view-only SCROLLBACK is harmless
           and genuinely useful while watching, so wheel events are
           re-dispatched onto the terminal canvas underneath (ghostty's
           own wheel handler scrolls the viewport; in alternate-screen
           mode its synthesized arrow keys die at the readOnly onData
           guard, so nothing reaches the agent's PTY). Browser panes have
           no canvas here and stay fully blocked. */
        <div
          className="pointer-events-auto absolute inset-0"
          aria-hidden
          onWheel={(event) => {
            const canvas = event.currentTarget
              .closest("[data-surface-pane]")
              ?.querySelector("canvas");
            canvas?.dispatchEvent(new WheelEvent("wheel", event.nativeEvent));
          }}
        />
      )}
      <div
        className={`${exiting ? "" : "pointer-events-auto"} z-10 flex ${anim} items-center gap-2.5 rounded-full border border-border bg-bg-raised/95 py-1.5 pl-3 pr-1.5 text-xs text-fg shadow-2xl backdrop-blur-xl`}
      >
        <span className="relative flex size-2">
          <span className="absolute inline-flex h-full w-full animate-pulse rounded-full bg-accent opacity-75" />
          <span className="relative inline-flex size-2 rounded-full bg-accent" />
        </span>
        Agent owns this {kind}
        {onGoToChat && (
          <button
            type="button"
            onClick={onGoToChat}
            className="flex h-6 cursor-pointer items-center gap-1.5 rounded-full border border-border px-2.5 text-fg-muted transition-colors duration-150 hover:border-border-strong hover:text-fg"
          >
            <MessageSquare className="size-3" />
            Go to chat
          </button>
        )}
        <button
          type="button"
          onClick={onTakeOver}
          className="h-6 cursor-pointer rounded-full bg-accent px-2.5 font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
        >
          Take control
        </button>
      </div>
    </div>
  );
}

/**
 * Floating "return to full width" control on non-browser split panes.
 * z-30 keeps it above the AgentControlOverlay (z-20, whose blocking
 * layer spans the whole pane): surface CONTROLS stay clickable on an
 * agent-held pane; only the surface's content is blocked.
 */
function PaneUnsplitButton({ onClick }: { onClick: () => void }) {
  return (
    <span className="absolute right-2 top-2 z-30">
      <ShortcutHint label="Full width">
        <button
          type="button"
          onClick={onClick}
          className="grid size-7 cursor-pointer place-items-center rounded-lg border border-border bg-bg-raised/95 text-fg-muted backdrop-blur-sm transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
          aria-label="Full width"
        >
          <Columns2 className="size-3.5" />
        </button>
      </ShortcutHint>
    </span>
  );
}

/** Whether the floating chat dock is where the user is working right now. */
let lastPointerDownInFloatingChat = false;
if (typeof window !== "undefined") {
  window.addEventListener(
    "pointerdown",
    (event) => {
      lastPointerDownInFloatingChat =
        event.target instanceof Element &&
        event.target.closest("[data-floating-chat]") !== null;
    },
    { capture: true },
  );
}
function floatingChatHasFocus(): boolean {
  const active = document.activeElement;
  if (active && active !== document.body) {
    return active.closest("[data-floating-chat]") !== null;
  }
  return lastPointerDownInFloatingChat;
}

export function App() {
  const projectsQuery = useProjects();

  // Boot veil: the window shows nothing but the themed backdrop until the
  // workspace's first paint is complete — profiles, agents, sidebar, and
  // the project list all loaded. No piecemeal popping on launch.
  const [bootRevealed, setBootRevealed] = useState(false);
  const [bootVeilGone, setBootVeilGone] = useState(false);
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  // Remote projects (ADR 0055): connect from a link or by hand; per-file
  // store history for the current project.
  const [remoteConnect, setRemoteConnect] = useState<{
    open: boolean;
    link: ConnectLink | null;
  }>({ open: false, link: null });
  const [remoteHistoryPath, setRemoteHistoryPath] = useState<string | null>(
    null,
  );
  // Continue on mobile: the QR pairing modal + the chat it should open.
  const [mobilePairing, setMobilePairing] = useState<{
    open: boolean;
    context: { projectId?: string; sessionId?: string } | null;
  }>({ open: false, context: null });
  const [remotePublish, setRemotePublish] = useState<{
    path: string;
    features: RemoteFeatures | undefined;
  } | null>(null);
  const [remotePropose, setRemotePropose] = useState<{
    files: string[];
    features: RemoteFeatures | undefined;
  } | null>(null);
  useEffect(() => {
    // Pull the pending link on mount (cold launch from an invite) and
    // whenever main nudges; main clears it once taken.
    const take = () => {
      void desktopApi.remoteTakePendingLink().then((raw) => {
        if (!raw) return;
        void desktopApi.remoteParseLink(raw).then((link) => {
          if (link) setRemoteConnect({ open: true, link });
        });
      });
    };
    take();
    return desktopApi.onConnectLink(take);
  }, []);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  // Live per-chat signals reported by each ChatDock (working / draft /
  // awaiting-input); unread is host-derived (needs surface visibility).
  const [signalsByChat, setSignalsByChat] = useState<
    Record<string, ChatLiveSignals>
  >({});
  const [unreadByChat, setUnreadByChat] = useState<Record<string, boolean>>({});
  // Surfaces an agent opened in the BACKGROUND (open_surface while the
  // user was on another tab): chat localId → surface keys whose chip
  // carries the attention indicator. Cleared when the user opens that
  // surface (dismissal-by-interaction, like point_at's glow).
  const [chipAttention, setChipAttention] = useState<Record<string, string[]>>(
    {},
  );
  const [bubblesCollapsed, setBubblesCollapsed] = useState(false);

  // Notification preferences (per profile): soft chime + desktop banner
  // when an agent finishes or asks a question. Also carries relaunch
  // state: sidebar visibility and the last active project.
  const [prefs, setPrefs] = useState<AppPrefs | null>(null);
  useEffect(() => {
    void desktopApi.getPrefs().then((loaded) => {
      setPrefs(loaded);
      setSidebarOpen(loaded.sidebarOpen);
    });
    return desktopApi.onPrefsChanged(setPrefs);
  }, []);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;

  // Profiles own the whole environment: session partition, projects,
  // theme/keys/sidebar, and the AI agent roster. Each window is born on a
  // profile (main assigns it); the sidebar shows that profile's projects.
  const [profilesData, setProfilesData] = useState<ProfilesData | null>(null);
  const [activeProfileId, setActiveProfileId] = useState<string>();

  useEffect(() => {
    void Promise.all([
      desktopApi.profilesList(),
      desktopApi.windowProfile(),
    ]).then(([data, windowProfileId]) => {
      setProfilesData(data);
      setActiveProfileId((current) => current ?? windowProfileId);
    });
    return desktopApi.onProfilesChanged(setProfilesData);
  }, []);

  const activeProfile: Profile | undefined =
    profilesData?.profiles.find((profile) => profile.id === activeProfileId) ??
    profilesData?.profiles[0];

  // Profile settings tabs are live views. Keep their strip labels in sync
  // with renames broadcast from this or another window.
  useEffect(() => {
    if (!profilesData) return;
    const names = new Map(
      profilesData.profiles.map((profile) => [profile.id, profile.name]),
    );
    setWorkspaces((current) =>
      Object.fromEntries(
        Object.entries(current).map(([id, workspace]) => [
          id,
          {
            ...workspace,
            tabs: workspace.tabs.map((tab) =>
              tab.kind === "profile-settings" && names.has(tab.name)
                ? { ...tab, label: names.get(tab.name) }
                : tab,
            ),
          },
        ]),
      ),
    );
  }, [profilesData]);

  // The active profile's AI agents (per-profile agents.json).
  const [agentsData, setAgentsData] = useState<AgentsData | null>(null);
  useEffect(() => {
    void desktopApi.agentsList().then(setAgentsData);
    return desktopApi.onAgentsChanged(setAgentsData);
  }, []);

  // The agent setup wizard: one experience behind every entry point — the
  // auto-opened tab on agent-less profiles, the modal that gates starting
  // a chat with no agents, Settings' "Add agent", and the palette command.
  const [wizardModalOpen, setWizardModalOpen] = useState(false);
  const [connectorsModalOpen, setConnectorsModalOpen] = useState(false);
  // Ref'd for the agent-bridge handler (a mount-time effect closure).
  const setConnectorsModalOpenRef = useRef(setConnectorsModalOpen);
  setConnectorsModalOpenRef.current = setConnectorsModalOpen;
  // Profiles whose auto-opened setup tab the user closed this session —
  // closing it skips setup (the modal still gates chat attempts).
  const setupDismissedRef = useRef(new Set<string>());
  const hasAgents = (agentsData?.agents.length ?? 0) > 0;
  /** True = chat may start; false = the wizard modal took over. */
  const requireAgents = (): boolean => {
    if (agentsData === null || hasAgents) return true;
    setWizardModalOpen(true);
    return false;
  };

  // In-place profile switch: a full-window veil fades up, the workspace
  // swaps beneath it, and the veil fades away (see switchProfile).
  const [profileVeil, setProfileVeil] = useState<{
    stage: "in" | "out";
    target?: Profile;
  } | null>(null);

  // User-customizable sidebar layout (sidebar.js, file-watched). Resolved
  // per project (project-local override → project .catamorphic/sidebar.js
  // → profile sidebar.js), so the fetch is keyed on the active project —
  // see the effect below projectId — and the changed event is a refetch
  // signal, not a payload.
  const [sidebarConfig, setSidebarConfig] = useState<SidebarConfig | null>(
    null,
  );

  const allProjects = projectsQuery.data?.items ?? [];
  // Projects created before profiles existed have no owner; the default
  // profile shows them (matches main-process lazy adoption).
  const ownedElsewhere = new Set(
    profilesData?.profiles
      .filter((profile) => profile.id !== activeProfile?.id)
      .flatMap((profile) => profile.projectIds) ?? [],
  );
  const projects = activeProfile
    ? allProjects.filter(
        (project) =>
          activeProfile.projectIds.includes(project.id) ||
          (activeProfile.id === profilesData?.defaultProfileId &&
            !ownedElsewhere.has(project.id)),
      )
    : allProjects;
  const activeProject =
    projects.find((project) => project.id === activeProjectId) ??
    // A relaunch lands in the profile's last active project, then the
    // profile default, then whatever exists.
    projects.find((project) => project.id === prefs?.lastProjectId) ??
    projects.find(
      (project) => project.id === activeProfile?.defaultProjectId,
    ) ??
    projects[0];
  const projectId = activeProject?.id;

  const startWithAgent = async (): Promise<void> => {
    const project = await desktopApi.createDefaultProject();
    if (activeProfile) {
      // This entry point explicitly asks for the Cmd+N-style modal. Prevent
      // the agent-less-profile effect from opening its setup tab underneath.
      setupDismissedRef.current.add(activeProfile.id);
    }
    await projectsQuery.refetch();
    selectProject(project.id);
    setWizardModalOpen(true);
  };

  // Project policy (ADR 0062): the committed manifest may disable
  // incognito sessions for this project's members.
  const [incognitoAllowed, setIncognitoAllowed] = useState(true);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void desktopApi
      .projectAllowIncognito(projectId)
      .then((allowed) => {
        if (!cancelled) setIncognitoAllowed(allowed);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  // Layered sidebar fetch: runs at boot with no project yet (profile layer
  // keeps the boot gate working), again when the active project lands or
  // changes, and on every main-process change signal.
  useEffect(() => {
    let stale = false;
    const refetch = () => {
      void desktopApi.sidebarConfigGet(projectId).then((resolved) => {
        if (!stale) setSidebarConfig(resolved.config);
      });
    };
    refetch();
    const unsubscribe = desktopApi.onSidebarConfigChanged(refetch);
    return () => {
      stale = true;
      unsubscribe();
    };
  }, [projectId]);

  /**
   * Switching profile follows the workspace's occupancy: an empty
   * workspace (no tabs, no browsers, no chats) switches this window in
   * place under a full-window fade; anything open means real work — that
   * stays put and the profile opens in its own window instead.
   */
  const switchProfile = (profile: Profile) => {
    if (profile.id === activeProfileId) return;
    const ws = workspaceRef.current;
    // Palette "New Tab" pages don't count as open work — a fresh workspace
    // is seeded with one, and Chrome's New Tab page has the same non-claim
    // on the window.
    const emptyWorkspaceNow =
      ws.browsers.length === 0 &&
      ws.chats.length === 0 &&
      ws.terminals.length === 0 &&
      ws.editors.length === 0 &&
      ws.tabs.every(
        (tab) => tab.kind === "palette" || tab.kind === "agent-setup",
      );
    if (!emptyWorkspaceNow) {
      void desktopApi.openProfileWindow(profile.id);
      return;
    }
    setProfileVeil({ stage: "in", target: profile });
  };

  /** Veil is fully opaque: swap everything beneath it, then fade it away. */
  const completingSwitchRef = useRef(false);
  const completeProfileSwitch = async (profile: Profile) => {
    if (completingSwitchRef.current) return;
    completingSwitchRef.current = true;
    try {
      await desktopApi.windowSetProfile(profile.id);
      // Unknown until the refetch lands — anything keyed on the agent
      // roster (the setup-tab auto-open, chat gating) must not act on the
      // OLD profile's roster while the NEW profile's project is active.
      setAgentsData(null);
      setActiveProfileId(profile.id);
      setActiveProjectId(profile.defaultProjectId);
      // Providers above App (theme, keybindings) refetch on this signal —
      // in-place switches get no main-process broadcast to this window.
      window.dispatchEvent(new Event("catamorphic:profile-refetch"));
      const [sidebar, agents, nextPrefs] = await Promise.all([
        desktopApi.sidebarConfigGet(),
        desktopApi.agentsList(),
        desktopApi.getPrefs(),
      ]);
      setSidebarConfig(sidebar.config);
      setAgentsData(agents);
      setPrefs(nextPrefs);
      setProfileVeil({ stage: "out" });
    } finally {
      completingSwitchRef.current = false;
    }
  };
  const completeProfileSwitchRef = useRef(completeProfileSwitch);
  completeProfileSwitchRef.current = completeProfileSwitch;

  // The veil sequence is driven by animationend AND a clock fallback: an
  // occluded window throttles animation events (Chromium background
  // throttling), and a stuck opaque veil would be the worst possible
  // failure mode. Whichever signal lands first wins; the completion guard
  // above keeps the switch single-flight.
  useEffect(() => {
    if (!profileVeil) return;
    const timer = window.setTimeout(() => {
      if (profileVeil.stage === "in" && profileVeil.target) {
        void completeProfileSwitchRef.current(profileVeil.target);
      } else if (profileVeil.stage === "out") {
        setProfileVeil(null);
      }
    }, 300);
    return () => window.clearTimeout(timer);
  }, [profileVeil]);

  // Shared with SessionsNav via the query cache; titles feed tab labels.
  const sessionsQuery = useAgentSessions(projectId);
  const sessionsById = new Map(
    (sessionsQuery.data?.items ?? []).map((session) => [session.id, session]),
  );

  // Stable per-project default so pre-first-write renders and the first
  // state update agree on the initial chat's localId.
  const defaultWorkspacesRef = useRef(new Map<string, Workspace>());
  const defaultWorkspaceFor = useCallback((id: string): Workspace => {
    const cache = defaultWorkspacesRef.current;
    const cached = cache.get(id);
    if (cached) return cached;
    const created = emptyWorkspace();
    cache.set(id, created);
    return created;
  }, []);

  const workspace: Workspace = projectId
    ? (workspaces[projectId] ?? defaultWorkspaceFor(projectId))
    : emptyWorkspace();

  const updateWorkspace = useCallback(
    (updater: (workspace: Workspace) => Workspace) => {
      if (!projectId) return;
      setWorkspaces((current) => ({
        ...current,
        [projectId]: updater(
          current[projectId] ?? defaultWorkspaceFor(projectId),
        ),
      }));
    },
    [projectId, defaultWorkspaceFor],
  );

  // --- workspace persistence --------------------------------------------
  // Each project's open workspace survives a relaunch. Restore runs once
  // per project (only filling a slot the user hasn't touched yet); saves
  // are debounced and gated until that restore attempt settles, so the
  // boot-time empty workspace can never clobber the saved one.
  const workspaceRestoreRef = useRef(new Set<string>());
  const workspacePersistReadyRef = useRef(new Set<string>());
  useEffect(() => {
    if (!projectId || workspaceRestoreRef.current.has(projectId)) return;
    workspaceRestoreRef.current.add(projectId);
    void desktopApi
      .workspaceStateGet(projectId)
      .then((raw) => {
        const restored = hydrateWorkspace(raw);
        if (restored) {
          setWorkspaces((current) =>
            current[projectId]
              ? current
              : { ...current, [projectId]: restored },
          );
        }
      })
      .catch(() => {})
      .finally(() => {
        workspacePersistReadyRef.current.add(projectId);
      });
  }, [projectId]);
  useEffect(() => {
    if (!projectId || !workspacePersistReadyRef.current.has(projectId)) return;
    const snapshot = workspaces[projectId];
    if (!snapshot) return;
    const timer = window.setTimeout(() => {
      void desktopApi
        .workspaceStateSet(projectId, serializeWorkspace(snapshot))
        .catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [workspaces, projectId]);

  const openTab = (tab: WorkspaceTab, mode?: "side") =>
    updateWorkspace((ws) => {
      const key = tabKey(tab);
      const exists = ws.tabs.some((existing) => tabKey(existing) === key);
      const split =
        mode === "side" && ws.activeTabKey && ws.activeTabKey !== key
          ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
          : null;
      return {
        ...ws,
        tabs: exists ? ws.tabs : [...ws.tabs, tab],
        activeTabKey: key,
        split,
      };
    });

  // Chrome's New Tab analog: a fresh tab whose content is the palette.
  const openPaletteTab = () =>
    openTab({ kind: "palette", name: crypto.randomUUID(), label: "New Tab" });

  /** Tab bar entries: fixed tabs plus one derived tab per tab-mode chat. */
  const chatTabs = (
    ws: Workspace,
    chatLabels: Record<string, string>,
    icons: Record<string, string | null>,
    forks: Record<string, boolean>,
  ) =>
    ws.chats
      .filter((chat) => chat.mode === "tab")
      .map(
        (chat): WorkspaceTab => ({
          kind: "chat",
          name: chat.localId,
          label: chatLabels[chat.localId] ?? "Chat",
          chatIcon: icons[chat.localId] ?? null,
          fork: forks[chat.localId] ?? false,
          // Hover card: which agent runs this conversation (+ lineage).
          detail:
            [
              agentsData?.agents.find(
                (agent) =>
                  agent.id ===
                  (sessionsById.get(chat.sessionId ?? "")?.agentId ??
                    chat.agentId ??
                    agentsData?.defaultAgentId),
              )?.name,
              forks[chat.localId] ? "fork of another chat" : undefined,
            ]
              .filter(Boolean)
              .join(" · ") || undefined,
          // Same signals as the chat's bubble: spinner while the agent
          // works, dot for a reply that landed while the tab was hidden,
          // pencil for an unsent draft, "?" for a waiting question.
          working: signalsByChat[chat.localId]?.working ?? false,
          unread: unreadByChat[chat.localId] ?? false,
          draft: signalsByChat[chat.localId]?.draft ?? false,
          awaitingInput: signalsByChat[chat.localId]?.awaitingInput ?? false,
        }),
      );

  const browserTabs = (ws: Workspace) =>
    tabbedBrowsers(ws).map(
      (browser): WorkspaceTab => ({
        kind: "browser",
        name: browser.localId,
        label: browser.title || "New Tab",
        faviconUrl: browser.faviconUrl,
        // Hover card: the page's address under its full title.
        detail: browser.url || browser.initialUrl || undefined,
      }),
    );

  const terminalTabs = (ws: Workspace) =>
    tabbedTerminals(ws).map(
      (terminal): WorkspaceTab => ({
        kind: "terminal",
        name: terminal.localId,
        label: terminal.title || "Terminal",
      }),
    );

  const editorTabs = (ws: Workspace) =>
    tabbedEditors(ws).map(
      (editor): WorkspaceTab => ({
        kind: "editor",
        name: editor.localId,
        label: editor.filePath?.split("/").at(-1) || "Editor",
        // Unsaved changes are a draft — same pencil badge as chat drafts.
        draft: editor.dirty,
        // Hover card: the project-relative path.
        detail: editor.filePath ?? undefined,
      }),
    );

  const selectTab = (key: string) =>
    updateWorkspace((ws) => {
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
        split,
        activeTabKey: key,
        ...(key.startsWith("chat:")
          ? { activeChatId: key.slice("chat:".length) }
          : {}),
      };
    });

  /** Open a page in a new browser tab (profile session of the workspace). */
  const openBrowserTab = useCallback(
    (
      url: string,
      opts?: {
        background?: boolean;
        chatLocalId?: string;
        side?: boolean;
        title?: string;
      },
    ) => {
      if (!activeProfile) return;
      const entry: BrowserEntry = {
        localId: crypto.randomUUID(),
        profileId: activeProfile.id,
        initialUrl: url,
        url,
        title: opts?.title ?? (url || "New Tab"),
        faviconUrl: null,
        chatLocalId: opts?.chatLocalId,
      };
      updateWorkspace((ws) => {
        const key = browserTabKey(entry.localId);
        // Side: tile the new page to the right of the current view.
        const split =
          opts?.side && ws.activeTabKey
            ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
            : opts?.background
              ? ws.split
              : null;
        return {
          ...ws,
          browsers: [...ws.browsers, entry],
          activeTabKey: opts?.background ? ws.activeTabKey : key,
          split,
        };
      });
    },
    [activeProfile, updateWorkspace],
  );

  /** Open a terminal tab; the shell starts in the project folder. */
  const openTerminalTab = (opts?: { chatLocalId?: string; side?: boolean }) => {
    const entry: TerminalEntry = {
      localId: crypto.randomUUID(),
      title: "",
      chatLocalId: opts?.chatLocalId,
    };
    updateWorkspace((ws) => {
      const key = terminalTabKey(entry.localId);
      return {
        ...ws,
        terminals: [...ws.terminals, entry],
        activeTabKey: key,
        split:
          opts?.side && ws.activeTabKey
            ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
            : null,
      };
    });
  };

  /** Open an editor tab; without a file it greets with the quick-open. */
  const openEditorTab = (opts?: {
    filePath?: string;
    chatLocalId?: string;
    side?: boolean;
  }) => {
    const entry: EditorEntry = {
      localId: crypto.randomUUID(),
      filePath: opts?.filePath ?? null,
      dirty: false,
      chatLocalId: opts?.chatLocalId,
    };
    updateWorkspace((ws) => {
      const key = editorTabKey(entry.localId);
      return {
        ...ws,
        editors: [...ws.editors, entry],
        activeTabKey: key,
        split:
          opts?.side && ws.activeTabKey
            ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
            : null,
      };
    });
  };

  const onTerminalTitle = useCallback(
    (localId: string, title: string) =>
      updateWorkspace((ws) => {
        const target = ws.terminals.find(
          (terminal) => terminal.localId === localId,
        );
        // Shells re-announce the same title on every prompt — skip those.
        if (!target || target.title === title) return ws;
        return {
          ...ws,
          terminals: ws.terminals.map((terminal) =>
            terminal.localId === localId ? { ...terminal, title } : terminal,
          ),
        };
      }),
    [updateWorkspace],
  );

  const onEditorState = useCallback(
    (localId: string, patch: Partial<Omit<EditorEntry, "localId">>) =>
      updateWorkspace((ws) => ({
        ...ws,
        editors: ws.editors.map((editor) =>
          editor.localId === localId ? { ...editor, ...patch } : editor,
        ),
      })),
    [updateWorkspace],
  );

  const onBrowserState = useCallback(
    (localId: string, state: BrowserPageState) =>
      updateWorkspace((ws) => ({
        ...ws,
        browsers: ws.browsers.map((browser) =>
          browser.localId === localId
            ? {
                ...browser,
                url: state.url || browser.url,
                title: state.title || browser.title,
                faviconUrl: state.faviconUrl ?? browser.faviconUrl,
              }
            : browser,
        ),
      })),
    [updateWorkspace],
  );

  // target=_blank / window.open from any page in this window → new tab.
  const openBrowserTabRef = useRef(openBrowserTab);
  openBrowserTabRef.current = openBrowserTab;
  useEffect(() => {
    return desktopApi.onBrowserOpenUrl((url) => openBrowserTabRef.current(url));
  }, []);

  // navigate(url) handles per live browser tab, for "open in current tab"
  // (bookmarks/links with open:"replace").
  const browserNavigatorsRef = useRef(new Map<string, (url: string) => void>());

  // Animated close per chat dock — external closers (Cmd+W) must play the
  // same 250ms collapse Escape does, not unmount the dock mid-frame.
  const chatClosersRef = useRef(new Map<string, () => void>());

  // Staged tab-minimize per chat dock — Cmd+M on a fullscreen chat tab
  // must play the dock's collapse before the mode flips, exactly like
  // the dash control (the tween runs before the workspace re-render).
  const chatMinimizersRef = useRef(new Map<string, () => void>());
  // Per-chat "re-pull the editor selection" counters (see addChat).
  const [selectionPulls, setSelectionPulls] = useState<Record<string, number>>(
    {},
  );

  // Live message senders per chat dock — how anything outside a dock
  // (skill palette rows, post-auth continuations) speaks into an already
  // open chat. Sends queue behind an in-flight turn like composer sends.
  const chatSendersRef = useRef(new Map<string, (message: string) => void>());

  // Webview guest WebContents ids per browser tab — the agent bridge
  // drives pages from the main process by guest id.
  const browserGuestIdsRef = useRef(new Map<string, number>());

  /**
   * Bookmark/link click behavior: "replace" reuses the focused browser
   * tab; anything else (or no focused browser tab) opens a new tab.
   */
  const openUrl = (url: string, mode: "tab" | "replace" | "side") => {
    const ws = workspaceRef.current;
    const focusedBrowserId = ws.activeTabKey?.startsWith("browser:")
      ? ws.activeTabKey.slice("browser:".length)
      : undefined;
    const navigate = focusedBrowserId
      ? browserNavigatorsRef.current.get(focusedBrowserId)
      : undefined;
    if (mode === "replace" && navigate) {
      navigate(url);
      return;
    }
    openBrowserTab(url, mode === "side" ? { side: true } : undefined);
  };

  const closeTab = (key: string, opts?: { force?: boolean }) =>
    updateWorkspace((ws) => {
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
        browserNavigatorsRef.current.delete(localId);
        browserGuestIdsRef.current.delete(localId);
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
      // Closing the auto-opened setup tab skips setup for this profile
      // (this session); the modal still gates starting a chat.
      if (key.startsWith("agent-setup:") && activeProfileId) {
        setupDismissedRef.current.add(activeProfileId);
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
            ? { kind: "screen", tab: closingTab, ...splitContext }
            : null,
        ),
        activeTabKey:
          ws.activeTabKey === key
            ? nextActiveTabKey({ ...ws, tabs }, key, ws.chats)
            : ws.activeTabKey,
      };
    });

  /** Cmd+Shift+T: restore the most recently closed tab (re-tiled when
      its old split partner is still open). */
  const reopenTab = () =>
    updateWorkspace((ws) => {
      const record = ws.closedTabs.at(-1);
      if (!record) return ws;
      const closedTabs = ws.closedTabs.slice(0, -1);
      let key: string;
      let patch: Partial<Workspace> = {};
      switch (record.kind) {
        case "browser": {
          const entry: BrowserEntry = {
            localId: crypto.randomUUID(),
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
            localId: crypto.randomUUID(),
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
            localId: crypto.randomUUID(),
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
            ...newChatEntry("tab", { incognito: record.incognito }),
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
    });

  const nextActiveTabKey = (
    ws: Workspace,
    closedKey: string,
    chats: ChatDockEntry[],
  ): string | undefined => {
    const keys = [
      ...ws.tabs.map(tabKey),
      ...tabbedBrowsers(ws).map((browser) => browserTabKey(browser.localId)),
      ...tabbedTerminals(ws).map((terminal) =>
        terminalTabKey(terminal.localId),
      ),
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

  const toggleChat = (localId: string) =>
    updateWorkspace((ws) => {
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
    });

  /** Bring a chat's surface on screen (desktop-notification clicks). */
  const revealChat = (localId: string) =>
    updateWorkspace((ws) => {
      const chat = ws.chats.find((candidate) => candidate.localId === localId);
      if (!chat) return ws;
      if (chat.mode === "tab") {
        return {
          ...ws,
          activeChatId: localId,
          activeTabKey: chatTabKey(localId),
        };
      }
      return {
        ...ws,
        activeChatId: localId,
        chats: ws.chats.map((candidate) =>
          candidate.localId === localId
            ? { ...candidate, mode: "partial" }
            : candidate.mode === "partial"
              ? { ...candidate, mode: "min" }
              : candidate,
        ),
      };
    });
  const revealChatRef = useRef(revealChat);
  revealChatRef.current = revealChat;

  const closeChat = (localId: string) => {
    chatClosersRef.current.delete(localId);
    chatMinimizersRef.current.delete(localId);
    updateWorkspace((ws) => {
      const closing = ws.chats.find((chat) => chat.localId === localId);
      const chats = ws.chats.filter((chat) => chat.localId !== localId);
      return {
        ...ws,
        chats,
        // Every close path feeds Cmd+Shift+T, not just the tab strip's —
        // the dock's own X, a bubble's X, and Cmd+W-on-floating all land
        // here. Sessionless chats are skipped: reopening one would just
        // make a new empty chat.
        closedTabs: closing?.sessionId
          ? [
              ...ws.closedTabs,
              {
                kind: "chat" as const,
                sessionId: closing.sessionId,
                incognito: closing.incognito,
              },
            ].slice(-CLOSED_TABS_KEPT)
          : ws.closedTabs,
        activeChatId: ws.activeChatId === localId ? undefined : ws.activeChatId,
        activeTabKey:
          ws.activeTabKey === chatTabKey(localId)
            ? nextActiveTabKey(ws, chatTabKey(localId), chats)
            : ws.activeTabKey,
      };
    });
  };

  // Cmd+T and the tab-strip + always open a full chat tab (Chrome muscle
  // memory); the sidebar +, bubble +, and Cmd+E open the floating aside.
  const addChat = (forceMode?: "tab", opts?: { incognito?: boolean }) => {
    if (!requireAgents()) return;
    updateWorkspace((ws) => {
      // Already looking at a fresh chat (no session yet)? Don't stack
      // another empty one on top — Cmd+N/+ is a no-op there, except that
      // it re-pulls the editor selection: "select, Cmd+N, ask" must work
      // whether or not an empty chat was already waiting.
      const active = ws.chats.find((chat) => chat.localId === ws.activeChatId);
      const activeIsVisible =
        active?.mode === "partial" ||
        (active?.mode === "tab" &&
          ws.activeTabKey === chatTabKey(active.localId));
      const activeSignals = active ? signalsByChat[active.localId] : undefined;
      if (
        activeIsVisible &&
        !active.sessionId &&
        !active.pendingMessage &&
        !activeSignals?.working &&
        !activeSignals?.draft &&
        !activeSignals?.awaitingInput &&
        // A fresh plain chat doesn't satisfy "new INCOGNITO chat".
        Boolean(active.incognito) === Boolean(opts?.incognito)
      ) {
        setSelectionPulls((current) => ({
          ...current,
          [active.localId]: (current[active.localId] ?? 0) + 1,
        }));
        return ws;
      }
      // Floating chats become a full tab anyway when the workspace is
      // empty — with nothing behind it, the chat IS the workspace.
      const noTabsOpen =
        ws.tabs.length === 0 &&
        ws.browsers.length === 0 &&
        ws.terminals.length === 0 &&
        ws.editors.length === 0 &&
        ws.chats.every((chat) => chat.mode !== "tab");
      const entry = newChatEntry(
        forceMode ?? (noTabsOpen ? "tab" : "partial"),
        opts,
      );
      return {
        ...ws,
        chats: [
          ...ws.chats.map((chat) =>
            chat.mode === "partial" ? { ...chat, mode: "min" as const } : chat,
          ),
          entry,
        ],
        activeChatId: entry.localId,
        activeTabKey:
          entry.mode === "tab" ? chatTabKey(entry.localId) : ws.activeTabKey,
      };
    });
  };

  // Palette "Send to agent": a new chat born with its first message
  // attached; ChatDock auto-sends it on mount.
  const sendToAgent = (message: string, mode: "float" | "tab") => {
    if (!requireAgents()) return;
    updateWorkspace((ws) => {
      const entry: ChatDockEntry = {
        ...newChatEntry(mode === "tab" ? "tab" : "partial"),
        pendingMessage: message,
      };
      return {
        ...ws,
        chats: [
          ...ws.chats.map((chat) =>
            chat.mode === "partial" ? { ...chat, mode: "min" as const } : chat,
          ),
          entry,
        ],
        activeChatId: entry.localId,
        activeTabKey:
          entry.mode === "tab" ? chatTabKey(entry.localId) : ws.activeTabKey,
      };
    });
  };

  // Agent-less profiles greet the user with the setup wizard as a real,
  // closable tab: close it to skip; it returns as a modal on chat attempts.
  useEffect(() => {
    if (!projectId || agentsData === null || hasAgents) return;
    if (!activeProfileId || setupDismissedRef.current.has(activeProfileId)) {
      return;
    }
    updateWorkspace((ws) => {
      const key = "agent-setup:setup";
      if (ws.tabs.some((tab) => tabKey(tab) === key)) return ws;
      const tab: WorkspaceTab = {
        kind: "agent-setup",
        name: "setup",
        label: "Set up agent",
      };
      return { ...ws, tabs: [...ws.tabs, tab], activeTabKey: key };
    });
  }, [projectId, agentsData, hasAgents, activeProfileId, updateWorkspace]);

  const minimizeFloatingChats = () =>
    updateWorkspace((ws) => ({
      ...ws,
      chats: ws.chats.map((chat) =>
        chat.mode === "partial" ? { ...chat, mode: "min" as const } : chat,
      ),
    }));

  const openSession = (session: AgentSession) =>
    updateWorkspace((ws) => {
      const existing = ws.chats.find((chat) => chat.sessionId === session.id);
      // Already-tabbed chats stay tabs; everything else opens as the
      // floating dock — unless no tabs are open, where a tab is the
      // natural landing (same rule as addChat).
      const noTabsOpen =
        ws.tabs.length === 0 &&
        ws.browsers.length === 0 &&
        ws.terminals.length === 0 &&
        ws.editors.length === 0 &&
        ws.chats.every((chat) => chat.mode !== "tab");
      const mode =
        existing?.mode === "tab" || noTabsOpen
          ? ("tab" as const)
          : ("partial" as const);
      const entry = existing ?? {
        ...newChatEntry(mode),
        sessionId: session.id,
      };
      return {
        ...ws,
        chats: [
          ...ws.chats
            .filter((chat) => chat.localId !== entry.localId)
            .map((chat) =>
              chat.mode === "partial"
                ? { ...chat, mode: "min" as const }
                : chat,
            ),
          { ...entry, mode },
        ],
        activeChatId: entry.localId,
        activeTabKey:
          mode === "tab" ? chatTabKey(entry.localId) : ws.activeTabKey,
      };
    });

  const onSessionCreated = useCallback(
    (localId: string, sessionId: string) =>
      updateWorkspace((ws) => ({
        ...ws,
        chats: ws.chats.map((chat) =>
          chat.localId === localId ? { ...chat, sessionId } : chat,
        ),
      })),
    [updateWorkspace],
  );

  // Latest workspace for callbacks that outlive a render.
  const workspaceRef = useRef(workspace);
  workspaceRef.current = workspace;

  const signalsRef = useRef<Record<string, ChatLiveSignals>>({});
  /**
   * A settled agent deserves a cue: soft chime when it finishes or asks
   * (only when the chat isn't front-and-center — watching it IS the cue),
   * plus an OS notification when the window itself is unfocused. Both are
   * per-profile preferences.
   */
  const notifySettled = useCallback(
    (localId: string, kind: "done" | "question") => {
      const ws = workspaceRef.current;
      const chat = ws.chats.find((candidate) => candidate.localId === localId);
      if (!chat) return;
      const visible = chatVisible(ws, chat);
      const focused = document.hasFocus();
      const current = prefsRef.current;
      const title = chatLabelsRef.current[localId] ?? "Chat";
      if ((current?.notificationSounds ?? true) && !(visible && focused)) {
        playChime(kind);
      }
      if (current?.desktopNotifications ?? true) {
        const notification = notifyDesktop(
          title,
          kind === "question"
            ? "The agent has a question for you."
            : "The agent finished working.",
        );
        if (notification) {
          notification.onclick = () => {
            void desktopApi.windowFocus();
            revealChatRef.current(localId);
          };
        }
      }
    },
    [],
  );

  const onSignalsChange = useCallback(
    (localId: string, next: ChatLiveSignals) => {
      const previous = signalsRef.current[localId];
      const had = previous !== undefined;
      const before = previous ?? NO_CHAT_SIGNALS;
      if (
        before.working === next.working &&
        before.draft === next.draft &&
        before.awaitingInput === next.awaitingInput
      ) {
        return;
      }
      signalsRef.current = { ...signalsRef.current, [localId]: next };
      setSignalsByChat(signalsRef.current);
      const ws = workspaceRef.current;
      const chat = ws.chats.find((candidate) => candidate.localId === localId);
      // Response landed while the chat was hidden (minimized bubble or a
      // background tab) → unread dot.
      if (before.working && !next.working && chat && !chatVisible(ws, chat)) {
        setUnreadByChat((unread) => ({ ...unread, [localId]: true }));
      }
      // Notify only on live transitions — the first report for a chat is
      // its mount snapshot (a reopened session with an old question must
      // not chime).
      if (had && before.working && !next.working) {
        notifySettled(localId, next.awaitingInput ? "question" : "done");
      } else if (had && !before.awaitingInput && next.awaitingInput) {
        notifySettled(localId, "question");
      }
    },
    [notifySettled],
  );

  // Bringing a chat's surface on screen marks it read.
  useEffect(() => {
    const readIds = workspace.chats
      .filter((chat) => chatVisible(workspace, chat))
      .map((chat) => chat.localId);
    if (readIds.some((id) => unreadByChat[id])) {
      setUnreadByChat((current) => {
        const next = { ...current };
        for (const id of readIds) delete next[id];
        return next;
      });
    }
  }, [workspace, unreadByChat]);

  // Cmd+W (via the app menu) closes the most specific surface in focus:
  // the floating chat if one is open, else the active workspace tab.
  const closeChatRef = useRef(closeChat);
  closeChatRef.current = closeChat;
  const closeTabRef = useRef(closeTab);
  closeTabRef.current = closeTab;
  // An OAuth consent tab has done its job once the loopback callback was
  // served: close it (with the tab's exit motion) instead of leaving a
  // "you can close this tab" page behind. The tab may still be mid-redirect
  // to the callback, so match on the live URL a moment later too.
  useEffect(() => {
    return desktopApi.onBrowserCloseUrl((prefix) => {
      const closeMatching = () => {
        const ws = workspaceRef.current;
        let closed = false;
        for (const browser of ws.browsers) {
          // The callback path specifically: with a fixed port (Slack's
          // 3118) a bare origin match could close a dev-server tab.
          if (browser.url.startsWith(`${prefix}/callback`)) {
            closeTabRef.current(browserTabKey(browser.localId), {
              force: true,
            });
            closed = true;
          }
        }
        return closed;
      };
      if (!closeMatching()) window.setTimeout(closeMatching, 800);
    });
  }, []);
  const closeActiveSurface = useCallback(() => {
    const ws = workspaceRef.current;
    const floating = ws.chats.find((chat) => chat.mode === "partial");
    // The floating chat only owns Cmd+W while the user is IN it. Focus is
    // the tell (its composer takes focus on open); when nothing focusable
    // holds focus (a click on a pane's blank chrome, a webview whose guest
    // swallowed the click), the last pointer-down decides. Clicking into
    // the tab behind the dock and pressing Cmd+W closes the tab.
    if (floating && (!ws.activeTabKey || floatingChatHasFocus())) {
      // Through the dock's animated close (same collapse as Escape);
      // straight removal only if the dock never registered one.
      const animated = chatClosersRef.current.get(floating.localId);
      if (animated) animated();
      else closeChatRef.current(floating.localId);
      return;
    }
    if (ws.activeTabKey) closeTabRef.current(ws.activeTabKey);
  }, []);
  useEffect(() => {
    return desktopApi.onCloseSurface(closeActiveSurface);
  }, [closeActiveSurface]);

  // --- agent commands (palette pickers) ---

  // The chat the agent commands act on: the active chat while its surface
  // is on screen (floating dock or focused tab).
  const focusedChat = workspace.chats.find(
    (chat) =>
      chat.localId === workspace.activeChatId && chatVisible(workspace, chat),
  );
  const focusedSession = focusedChat?.sessionId
    ? sessionsById.get(focusedChat.sessionId)
    : undefined;

  // Palette skill rows (ADR 0052): the invocation lands in the focused
  // chat when one exists — the border-accented target — else it starts a
  // new chat exactly like "Send to agent".
  const runSkill = (name: string, mode: "float" | "tab") => {
    const send = focusedChat
      ? chatSendersRef.current.get(focusedChat.localId)
      : undefined;
    if (focusedChat && send) {
      send(skillInvocation(name));
      revealChat(focusedChat.localId);
      return;
    }
    sendToAgent(skillInvocation(name), mode);
  };

  const updateSession = useUpdateAgentSession(projectId);
  const forkSession = useForkAgentSession(projectId);

  /**
   * Fork a chat from one of its assistant messages: the server copies the
   * transcript into a new session (same agent, parent recorded); the fork
   * opens tiled beside the current view and chips onto the parent's rail.
   */
  const forkChat = (parent: ChatDockEntry, messageId: string) => {
    if (!parent.sessionId || forkSession.isPending) return;
    forkSession.mutate(
      { sessionId: parent.sessionId, messageId },
      {
        onSuccess: (session) => {
          // A fork of an incognito chat holds the same transcript, so it
          // inherits the flag: marked before any turn can settle, which
          // is what keeps the mirror from ever seeing it (ADR 0062).
          if (parent.incognito) {
            void desktopApi.sessionSetIncognito(session.id, true);
          }
          updateWorkspace((ws) => {
            const entry: ChatDockEntry = {
              ...newChatEntry("tab", { incognito: parent.incognito }),
              sessionId: session.id,
              parentLocalId: parent.localId,
            };
            const key = chatTabKey(entry.localId);
            // Tile the fork beside whatever the user is looking at; with
            // nothing focused it simply becomes the active tab.
            const split =
              ws.activeTabKey && ws.activeTabKey !== key
                ? { leftKey: ws.activeTabKey, rightKey: key, ratio: 0.5 }
                : null;
            return {
              ...ws,
              chats: [...ws.chats, entry],
              activeChatId: entry.localId,
              activeTabKey: key,
              split,
            };
          });
        },
      },
    );
  };

  /** Reveal a fork's parent chat — reopening it if it was closed. */
  const openParentChat = (entry: ChatDockEntry) => {
    const parentSessionId = entry.sessionId
      ? sessionsById.get(entry.sessionId)?.parentSessionId
      : undefined;
    const ws = workspaceRef.current;
    const openParent =
      ws.chats.find(
        (candidate) =>
          candidate.localId === entry.parentLocalId ||
          (parentSessionId && candidate.sessionId === parentSessionId),
      ) ?? null;
    if (openParent) {
      revealChat(openParent.localId);
      return;
    }
    const parentSession = parentSessionId
      ? sessionsById.get(parentSessionId)
      : undefined;
    if (parentSession) openSession(parentSession);
  };

  // The surface a highlighted palette command would act on gets an accent
  // border while the row is selected — the command points at its target.
  const [paletteTarget, setPaletteTarget] = useState<"chat" | "close" | null>(
    null,
  );
  const floatingChat = workspace.chats.find((chat) => chat.mode === "partial");
  const targetedChat =
    paletteTarget === "chat"
      ? focusedChat
      : paletteTarget === "close"
        ? floatingChat
        : undefined;
  const targetedTabKey =
    paletteTarget === "close" && !floatingChat
      ? workspace.activeTabKey
      : paletteTarget === "chat" && focusedChat?.mode === "tab"
        ? chatTabKey(focusedChat.localId)
        : undefined;

  // Overlay palette opened straight into a picker (Cmd+P commands run
  // from anywhere; palette tabs enter pickers through their own rows).
  const [pickerRequest, setPickerRequest] = useState<{
    kind:
      | "default-agent"
      | "switch-agent"
      | "configure-agent"
      | "effort"
      | "model";
    nonce: string;
  } | null>(null);
  const openPalettePicker = (
    kind:
      | "default-agent"
      | "switch-agent"
      | "configure-agent"
      | "effort"
      | "model",
  ) => {
    setPaletteOpen(true);
    setPickerRequest({ kind, nonce: crypto.randomUUID() });
  };

  // Layered default agent (ADR 0056): this user's per-project override,
  // then the project's committed default (.catamorphic/project.json), then
  // the profile default. `agentsData` is the refetch trigger — setting the
  // committed default broadcasts an agents-changed like any other layer.
  const [projectDefaultSlug, setProjectDefaultSlug] = useState<string | null>(
    null,
  );
  const [projectAgentNames, setProjectAgentNames] = useState<
    Record<string, string>
  >({});
  // biome-ignore lint/correctness/useExhaustiveDependencies: agentsData is a deliberate refetch trigger — a defaults edit broadcasts agents-changed
  useEffect(() => {
    if (!projectId) {
      setProjectDefaultSlug(null);
      setProjectAgentNames({});
      return;
    }
    let cancelled = false;
    void desktopApi
      .projectAgentsList(projectId)
      .then((data) => {
        if (!cancelled) {
          setProjectDefaultSlug(data.projectDefaultSlug);
          setProjectAgentNames(
            Object.fromEntries(
              data.agents.map((agent) => [agent.id, agent.name]),
            ),
          );
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [projectId, agentsData]);
  const projectOverrideAgentId = projectId
    ? (agentsData?.projectDefaults?.[projectId] ?? null)
    : null;
  const effectiveDefaultAgentId =
    projectOverrideAgentId ??
    (projectId && projectDefaultSlug
      ? `project:${projectId}:${projectDefaultSlug}`
      : null) ??
    agentsData?.defaultAgentId ??
    null;

  const pickDefaultAgent = (agentId: string) => {
    // Inside a project the palette pick is this user's per-project
    // override (ADR 0056); the global default changes in the agent modal
    // or Settings — or here, when no project is open.
    if (projectId) void desktopApi.agentsSetProjectDefault(projectId, agentId);
    else void desktopApi.agentsSetDefault(agentId);
  };

  // The configure-agent modal (ADR 0056): THE surface for one agent's
  // configuration, reached from the palette picker and Settings. The id
  // outlives `open` so the exit transition plays over the same content.
  const [configureAgentId, setConfigureAgentId] = useState<string | null>(null);
  const [configureAgentOpen, setConfigureAgentOpen] = useState(false);
  const openConfigureAgent = (agentId: string) => {
    setConfigureAgentId(agentId);
    setConfigureAgentOpen(true);
  };

  const pickSessionAgent = (agentId: string) => {
    const chat = workspaceRef.current.chats.find(
      (candidate) => candidate.localId === workspaceRef.current.activeChatId,
    );
    if (!chat) return;
    if (chat.sessionId) {
      updateSession.mutate({ sessionId: chat.sessionId, agentId });
      return;
    }
    // No session yet: remember the choice; lazy creation sends it along.
    updateWorkspace((ws) => ({
      ...ws,
      chats: ws.chats.map((candidate) =>
        candidate.localId === chat.localId
          ? { ...candidate, agentId }
          : candidate,
      ),
    }));
  };

  /** Change the model on the focused chat's agent (or the default one). */
  const pickModel = (agentId: string, model: string) => {
    void desktopApi.agentsUpdate(agentId, { model });
  };

  // Project agents (ADR 0050): picking one that isn't approved (or whose
  // approval went stale after a definition change) routes through the
  // consent dialog first; secret-credentialed and already-approved ones
  // switch immediately, exactly like profile agents.
  const [consentRequest, setConsentRequest] = useState<{
    agent: ProjectAgentInfo;
    target: "default" | "session";
  } | null>(null);
  const applyProjectAgent = (
    agent: ProjectAgentInfo,
    target: "default" | "session",
  ) => {
    if (target === "default") pickDefaultAgent(agent.id);
    else pickSessionAgent(agent.id);
  };
  const pickProjectAgent = (
    agent: ProjectAgentInfo,
    target: "default" | "session",
  ) => {
    if (agent.invalid) return;
    if (agent.consent === "ok" || agent.consent === "not-required") {
      applyProjectAgent(agent, target);
      return;
    }
    setConsentRequest({ agent, target });
  };

  const pickEffort = (effort: AgentEffort) => {
    const chat = workspaceRef.current.chats.find(
      (candidate) => candidate.localId === workspaceRef.current.activeChatId,
    );
    if (chat?.sessionId) {
      updateSession.mutate({ sessionId: chat.sessionId, effort });
      return;
    }
    // No focused session: the effort applies to the effective default
    // agent (the one the picker showed as current). A committed project
    // agent's effort lives in its definition file — not editable here.
    const targetId = effectiveDefaultAgentId;
    if (targetId && agentsData?.agents.some((agent) => agent.id === targetId)) {
      void desktopApi.agentsUpdate(targetId, { effort });
    }
  };

  // One handler per registry action (shared/actions.ts). Consumed by the
  // shortcut dispatcher below AND the palette's action rows, so a key
  // press and a palette pick always do the same thing. Rebuilt per render
  // (closures over fresh state), read through a ref by the listeners.
  // Keyboard tab cycling nudges the content pane in from the direction of
  // travel (see styles.css pane-in-*). Cleared on animationend; the
  // null-then-rAF dance restarts the keyframe on rapid consecutive cycles.
  const [paneMotion, setPaneMotion] = useState<{
    direction: "left" | "right";
    nonce: number;
  } | null>(null);
  const paneMotionNonce = useRef(0);
  const playPaneMotion = (direction: "left" | "right") => {
    paneMotionNonce.current += 1;
    const nonce = paneMotionNonce.current;
    setPaneMotion(null);
    requestAnimationFrame(() => {
      if (paneMotionNonce.current === nonce) {
        setPaneMotion({ direction, nonce });
      }
    });
  };

  const cycleTab = (direction: -1 | 1) => {
    const ws = workspaceRef.current;
    const keys = orderedTabKeys(ws);
    if (keys.length < 2) return;
    const index = keys.indexOf(ws.activeTabKey ?? "");
    const next =
      index === -1
        ? direction === 1
          ? keys[0]
          : keys.at(-1)
        : keys[(index + direction + keys.length) % keys.length];
    if (!next || next === ws.activeTabKey) return;
    playPaneMotion(direction === 1 ? "right" : "left");
    // Cycling walks single tabs — it exits a split rather than churning
    // one of its panes.
    updateWorkspace((current) => ({
      ...current,
      split: null,
      activeTabKey: next,
      ...(next.startsWith("chat:")
        ? { activeChatId: next.slice("chat:".length) }
        : {}),
    }));
  };

  // Cmd+\ pairs the active tab with the previously focused one — track a
  // one-deep focus history for that.
  const previousActiveTabKeyRef = useRef<string | undefined>(undefined);
  const lastActiveTabKeyRef = useRef<string | undefined>(undefined);
  useEffect(() => {
    const current = workspace.activeTabKey;
    if (current !== lastActiveTabKeyRef.current) {
      previousActiveTabKeyRef.current = lastActiveTabKeyRef.current;
      lastActiveTabKeyRef.current = current;
    }
  });

  /** Cmd+\: tile the active tab beside the previously focused one. */
  const toggleSplit = () => {
    const ws = workspaceRef.current;
    const keys = orderedTabKeys(ws);
    const active = ws.activeTabKey;
    if (!active || !keys.includes(active)) return;
    if (
      ws.split &&
      (active === ws.split.leftKey || active === ws.split.rightKey)
    ) {
      updateWorkspace((current) => ({ ...current, split: null }));
      return;
    }
    const previous = previousActiveTabKeyRef.current;
    const partner =
      previous && previous !== active && keys.includes(previous)
        ? previous
        : keys.find((key) => key !== active);
    if (!partner) return;
    updateWorkspace((current) => ({
      ...current,
      split: { leftKey: active, rightKey: partner, ratio: 0.5 },
    }));
  };

  /** User claims an agent-driven surface; the agent is told on its next
      action and may reclaim or move on. */
  const takeOverSurface = (key: string) => {
    desktopApi.bridgeTakeover(key);
    updateWorkspace((ws) => ({
      ...ws,
      browsers: ws.browsers.map((b) =>
        browserTabKey(b.localId) === key ? { ...b, agentControlled: false } : b,
      ),
      terminals: ws.terminals.map((t) =>
        terminalTabKey(t.localId) === key
          ? { ...t, agentControlled: false }
          : t,
      ),
    }));
  };

  /** Fold/unfold a chat's attached tabs under its tab in the strip. */
  const toggleChatGroup = (chatLocalId: string) =>
    updateWorkspace((ws) => {
      const chat = ws.chats.find(
        (candidate) => candidate.localId === chatLocalId,
      );
      if (!chat) return ws;
      const collapsing = !chat.surfacesCollapsed;
      // Folding away the active tab lands focus on the group's chat.
      const activeTabKey =
        collapsing &&
        ws.activeTabKey &&
        attachedTabKeys(ws, chatLocalId).includes(ws.activeTabKey)
          ? chatTabKey(chatLocalId)
          : ws.activeTabKey;
      return {
        ...ws,
        activeTabKey,
        chats: ws.chats.map((candidate) =>
          candidate.localId === chatLocalId
            ? { ...candidate, surfacesCollapsed: collapsing }
            : candidate,
        ),
      };
    });

  /** Drag-reorder: move a tab before another (null = to the end). */
  const reorderTab = (key: string, beforeKey: string | null) =>
    updateWorkspace((ws) => {
      const order = orderedTabKeys(ws, { includeCollapsed: true }).filter(
        (candidate) => candidate !== key,
      );
      const at = beforeKey ? order.indexOf(beforeKey) : -1;
      if (at === -1) order.push(key);
      else order.splice(at, 0, key);
      return { ...ws, tabOrder: order };
    });

  /** Drop a dragged tab onto a side of the content area: tile it there. */
  const dropTabToSide = (key: string, side: "left" | "right") => {
    const ws = workspaceRef.current;
    const anchor =
      ws.activeTabKey && ws.activeTabKey !== key
        ? ws.activeTabKey
        : (previousActiveTabKeyRef.current ?? null);
    if (!anchor || anchor === key || !orderedTabKeys(ws).includes(anchor)) {
      return;
    }
    updateWorkspace((current) => ({
      ...current,
      split:
        side === "left"
          ? { leftKey: key, rightKey: anchor, ratio: 0.5 }
          : { leftKey: anchor, rightKey: key, ratio: 0.5 },
      activeTabKey: key,
      ...(key.startsWith("chat:")
        ? { activeChatId: key.slice("chat:".length) }
        : {}),
    }));
  };

  // Agent pointers: elements the agent is pointing the user at (subtle
  // glow + scroll). Each lasts until the user interacts with its element
  // or the agent replaces/clears it.
  const [agentPointers, setAgentPointers] = useState<AgentPointer[]>([]);
  const setAgentPointersRef = useRef(setAgentPointers);
  setAgentPointersRef.current = setAgentPointers;
  const dismissPointer = useCallback(
    (target: string) =>
      setAgentPointers((current) =>
        current.filter((pointer) => pointer.target !== target),
      ),
    [],
  );

  // Pending MCP elicitation (a connector asking the user a form or to open
  // a URL). One at a time — a modal blocks the surface anyway.
  const [elicitation, setElicitation] = useState<PendingElicitation | null>(
    null,
  );
  const setElicitationRef = useRef(setElicitation);
  setElicitationRef.current = setElicitation;
  // Pending tool-permission asks (MCP tools whose policy says "ask"). A
  // QUEUE: harnesses run a step's tool calls concurrently, so two asks can
  // land together — each must get its own answer, FIFO.
  const [toolPermissions, setToolPermissions] = useState<
    PendingToolPermission[]
  >([]);
  const setToolPermissionsRef = useRef(setToolPermissions);
  setToolPermissionsRef.current = setToolPermissions;

  // Pending request_connection from an agent: the connectors modal opens
  // seeded with the agent's query; closing it settles the tool call with
  // whatever got installed meanwhile (diffed by connection id), and a
  // fresh install queues a continuation message into the asking chat.
  const [connectorRequest, setConnectorRequest] = useState<{
    query: string;
    reason?: string;
    sessionId: string;
    before: Set<string>;
    resolve: (result: { installed: string[] }) => void;
  } | null>(null);
  const setConnectorRequestRef = useRef(setConnectorRequest);
  setConnectorRequestRef.current = setConnectorRequest;

  // Settle a pending request_connection when the connectors modal closes:
  // the diff of connection ids is what the user actually installed, and a
  // fresh install queues a continuation into the asking chat — the send
  // waits behind the in-flight turn, and by the time it dispatches the
  // provider has rebuilt with the new MCP surface (its cache key covers
  // connections), so the next turn runs with the connector mounted.
  const finalizeConnectorRequest = async () => {
    const request = connectorRequest;
    if (!request) return;
    const after = await desktopApi.connectionsList().catch(() => []);
    const installed = after
      .filter((connection) => !request.before.has(connection.id))
      .map((connection) => connection.name);
    request.resolve({ installed });
    if (installed.length === 0) return;
    const chat = workspaceRef.current.chats.find(
      (entry) => entry.sessionId === request.sessionId,
    );
    const send = chat ? chatSendersRef.current.get(chat.localId) : undefined;
    send?.(`The ${installed.join(", ")} connection is now set up — continue.`);
  };

  // The tab being dragged from the strip (drop targets render while set).
  const [tabDragKey, setTabDragKey] = useState<string | null>(null);
  const [dropSideHover, setDropSideHover] = useState<"left" | "right" | null>(
    null,
  );

  // Divider drag: ratio updates live; the overlay keeps webviews from
  // swallowing the mousemoves.
  const [dividerDragging, setDividerDragging] = useState(false);
  const startDividerDrag = (event: ReactMouseEvent<HTMLDivElement>) => {
    event.preventDefault();
    const region = event.currentTarget.parentElement;
    if (!region) return;
    const rect = region.getBoundingClientRect();
    setDividerDragging(true);
    const onMove = (move: globalThis.MouseEvent) => {
      const ratio = Math.min(
        0.8,
        Math.max(0.2, (move.clientX - rect.left) / rect.width),
      );
      updateWorkspace((ws) =>
        ws.split ? { ...ws, split: { ...ws.split, ratio } } : ws,
      );
    };
    const onUp = () => {
      setDividerDragging(false);
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  /**
   * Open an attached surface: "tab" focuses it full-width; "split" tiles
   * it to the right of whatever the view shows now, and focuses it.
   *
   * Un-siding from a split is two-phase: tween the ratio to the pane's
   * edge (the pane edges transition, so this reads as the pane growing
   * across while its neighbor squeezes away), then drop the split once
   * the tween lands.
   */
  const unsplitTimerRef = useRef<number | undefined>(undefined);
  const removeSurface = (key: string) => {
    if (key.startsWith("terminal:")) {
      const localId = key.slice("terminal:".length);
      const terminal = workspaceRef.current.terminals.find(
        (candidate) => candidate.localId === localId,
      );
      const sessionId = terminal?.attachSessionId ?? terminal?.ptySessionId;
      if (sessionId) void desktopApi.terminalKill(sessionId);
    }
    closeTab(key, { force: true });
  };

  const openSurface = (key: string, mode: "tab" | "split") => {
    // Opening a surface answers any attention its chip was holding
    // (open_surface-in-background) — dismissal-by-interaction.
    setChipAttention((current) => {
      if (!Object.values(current).some((keys) => keys.includes(key))) {
        return current;
      }
      return Object.fromEntries(
        Object.entries(current).map(([chatId, keys]) => [
          chatId,
          keys.filter((candidate) => candidate !== key),
        ]),
      );
    });
    // App chips point at the app by name — materialize its tab if the
    // user hasn't opened it yet (the key doubles as the tab key).
    if (key.startsWith("app:")) {
      const name = key.slice("app:".length);
      updateWorkspace((ws) =>
        ws.tabs.some((tab) => tabKey(tab) === key)
          ? ws
          : { ...ws, tabs: [...ws.tabs, { kind: "app", name }] },
      );
    }
    // A chip can outlive its tab. Opening it materializes the view again
    // without creating a second page/editor or losing its live state.
    if (key.startsWith("browser:")) {
      const localId = key.slice("browser:".length);
      updateWorkspace((ws) => ({
        ...ws,
        browsers: ws.browsers.map((browser) =>
          browser.localId === localId && browser.background
            ? { ...browser, background: false }
            : browser,
        ),
      }));
    }
    if (key.startsWith("editor:")) {
      const localId = key.slice("editor:".length);
      updateWorkspace((ws) => ({
        ...ws,
        editors: ws.editors.map((editor) =>
          editor.localId === localId && editor.background
            ? { ...editor, background: false }
            : editor,
        ),
      }));
    }
    // A background agent terminal materializes as a tab the moment the
    // user asks for it (chip click) or the agent shows it (open_surface).
    if (key.startsWith("terminal:")) {
      const localId = key.slice("terminal:".length);
      updateWorkspace((ws) => ({
        ...ws,
        terminals: ws.terminals.map((terminal) =>
          terminal.localId === localId && terminal.background
            ? { ...terminal, background: false }
            : terminal,
        ),
      }));
    }
    // Chat surfaces (fork chips) may be minimized bubbles — a chat only
    // occupies a view slot in tab mode, so promote it first.
    if (key.startsWith("chat:")) {
      const localId = key.slice("chat:".length);
      updateWorkspace((ws) => ({
        ...ws,
        activeChatId: localId,
        chats: ws.chats.map((chat) =>
          chat.localId === localId ? { ...chat, mode: "tab" } : chat,
        ),
      }));
    }
    const current = workspaceRef.current;
    if (
      mode === "tab" &&
      current.split &&
      (key === current.split.leftKey || key === current.split.rightKey)
    ) {
      const target = key === current.split.leftKey ? 1 : 0;
      updateWorkspace((ws) =>
        ws.split
          ? {
              ...ws,
              activeTabKey: key,
              split: { ...ws.split, ratio: target },
            }
          : ws,
      );
      window.clearTimeout(unsplitTimerRef.current);
      unsplitTimerRef.current = window.setTimeout(() => {
        updateWorkspace((ws) => ({ ...ws, split: null, activeTabKey: key }));
      }, 220);
      return;
    }
    updateWorkspace((ws) => {
      if (mode === "tab") return { ...ws, split: null, activeTabKey: key };
      // The surface may already BE the active tab (a floating chat over
      // the page it just opened) — anchor on the previously focused tab
      // so "open to the right" still produces a split.
      const previous = previousActiveTabKeyRef.current;
      const anchor =
        ws.activeTabKey && ws.activeTabKey !== key
          ? ws.activeTabKey
          : previous &&
              previous !== key &&
              orderedTabKeys(ws).includes(previous)
            ? previous
            : null;
      if (!anchor) return { ...ws, split: null, activeTabKey: key };
      return {
        ...ws,
        split: { leftKey: anchor, rightKey: key, ratio: 0.5 },
        activeTabKey: key,
      };
    });
  };

  // Cmd+, / Cmd+. walk the non-tab chats in bubble-strip order, showing
  // each as the floating dock (the docks' own expand/collapse motion
  // narrates the swap).
  const cycleChat = (direction: -1 | 1) =>
    updateWorkspace((ws) => {
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
        chats: ws.chats.map((chat) =>
          chat.localId === next.localId
            ? { ...chat, mode: "partial" }
            : chat.mode === "partial"
              ? { ...chat, mode: "min" }
              : chat,
        ),
      };
    });

  // Cmd+M / Cmd+Shift+M act on the active chat, falling back to the most
  // recent one — so restoring works even when no chat surface is focused.
  const actionChat = (ws: Workspace) =>
    ws.chats.find((chat) => chat.localId === ws.activeChatId) ??
    ws.chats.at(-1);

  const toggleChatMinimized = () => {
    const ws = workspaceRef.current;
    const chat = actionChat(ws);
    if (!chat) return;
    // Minimizing the focused fullscreen chat tab goes through the dock's
    // staged minimize (collapse tween, THEN the mode flip) so Cmd+M reads
    // exactly like the dash control. Everything else keeps the toggle.
    const focusedTab =
      chat.mode === "tab" &&
      ws.activeChatId === chat.localId &&
      ws.activeTabKey === chatTabKey(chat.localId);
    const staged = chatMinimizersRef.current.get(chat.localId);
    if (focusedTab && staged) {
      staged();
      return;
    }
    toggleChat(chat.localId);
  };

  const expandChatToTab = () => {
    const chat = actionChat(workspaceRef.current);
    if (!chat) return;
    updateWorkspace((ws) => ({
      ...ws,
      activeChatId: chat.localId,
      activeTabKey: chatTabKey(chat.localId),
      chats: ws.chats.map((candidate) =>
        candidate.localId === chat.localId
          ? { ...candidate, mode: "tab" }
          : candidate,
      ),
    }));
  };

  const actionHandlers: Record<ActionId, (mode?: "side") => void> = {
    "new-tab": openPaletteTab,
    "command-palette": () => setPaletteOpen((value) => !value),
    "new-floating-chat": () => addChat(),
    // Policy-gated (ADR 0062): hidden from the palette when the project
    // committed allowIncognito: false; the handler double-checks.
    "new-incognito-chat": () => {
      if (incognitoAllowed) addChat(undefined, { incognito: true });
    },
    "toggle-chat-minimized": toggleChatMinimized,
    "chat-to-tab": expandChatToTab,
    "prev-chat": () => cycleChat(-1),
    "next-chat": () => cycleChat(1),
    "prev-tab": () => cycleTab(-1),
    "next-tab": () => cycleTab(1),
    "split-view": toggleSplit,
    "new-browser-tab": (mode) =>
      openBrowserTab("", mode === "side" ? { side: true } : undefined),
    "reopen-tab": reopenTab,
    "new-terminal-tab": (mode) =>
      openTerminalTab(mode === "side" ? { side: true } : undefined),
    "new-editor-tab": (mode) =>
      openEditorTab(mode === "side" ? { side: true } : undefined),
    "toggle-sidebar": () =>
      setSidebarOpen((value) => {
        void desktopApi.setPrefs({ sidebarOpen: !value });
        return !value;
      }),
    "close-tab": closeActiveSurface,
    "setup-agent": () => setWizardModalOpen(true),
    "default-agent": () => openPalettePicker("default-agent"),
    "switch-agent": () => openPalettePicker("switch-agent"),
    "configure-agent": () => openPalettePicker("configure-agent"),
    "change-effort": () => openPalettePicker("effort"),
    "switch-model": () => openPalettePicker("model"),
    "manage-connectors": () => setConnectorsModalOpen(true),
    "connect-remote-project": () =>
      setRemoteConnect({ open: true, link: null }),
    // Capture the focused chat NOW: the QR should land the phone in the
    // exact conversation that was on screen when the action ran.
    "continue-on-mobile": () =>
      setMobilePairing({
        open: true,
        context: {
          ...(projectId ? { projectId } : {}),
          ...(focusedChat?.sessionId
            ? { sessionId: focusedChat.sessionId }
            : {}),
        },
      }),
  };
  const actionHandlersRef = useRef(actionHandlers);
  actionHandlersRef.current = actionHandlers;

  // User-configurable window-level shortcuts (close-tab also arrives from
  // the app menu as a close-surface event).
  const keybindings = useKeybindings();
  const keybindingsRef = useRef(keybindings);
  keybindingsRef.current = keybindings;
  useEffect(() => {
    // Returns true when the key matched an app shortcut. Also fed by
    // guest-key forwarding: shortcuts pressed inside webview page content
    // never reach this window, so main relays them (see main/browser.ts).
    const dispatchShortcut = (event: {
      key: string;
      metaKey: boolean;
      ctrlKey: boolean;
      altKey: boolean;
      shiftKey: boolean;
    }): boolean => {
      const bindings = keybindingsRef.current;
      const keyEvent = event as globalThis.KeyboardEvent;
      const action = KEYBINDING_ACTIONS.find((candidate) =>
        matchesBinding(keyEvent, bindings[candidate]),
      );
      if (!action) return false;
      actionHandlersRef.current[action]();
      return true;
    };

    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (dispatchShortcut(event)) {
        event.preventDefault();
        return;
      }
      // Desktop feel: Cmd+A means "select all of what I'm editing", never
      // "select every label on screen". Outside editable fields (inputs,
      // the terminal's contenteditable, Monaco's textarea) it is a no-op.
      if (
        (event.metaKey || event.ctrlKey) &&
        !event.altKey &&
        !event.shiftKey &&
        event.key.toLowerCase() === "a"
      ) {
        const active = document.activeElement as HTMLElement | null;
        const editable =
          active &&
          (active.tagName === "INPUT" ||
            active.tagName === "TEXTAREA" ||
            active.isContentEditable);
        if (!editable) event.preventDefault();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const unsubscribeGuestKeys = desktopApi.onBrowserGuestKey((key) =>
      dispatchShortcut({
        key: key.key,
        metaKey: key.meta,
        ctrlKey: key.control,
        altKey: key.alt,
        shiftKey: key.shift,
      }),
    );
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      unsubscribeGuestKeys();
    };
  }, []);

  const selectProject = (id: string) => {
    setActiveProjectId(id);
    // Remembered per profile: a relaunch lands in the last project.
    void desktopApi.setPrefs({ lastProjectId: id });
  };

  const onProjectDeleted = (deletedId: string) => {
    setDeletingProject(null);
    setWorkspaces(({ [deletedId]: _removed, ...rest }) => rest);
    defaultWorkspacesRef.current.delete(deletedId);
    void desktopApi.profilesReleaseProject(deletedId);
    if (activeProjectId === deletedId) setActiveProjectId(undefined);
  };

  const bootReady =
    profilesData !== null &&
    agentsData !== null &&
    sidebarConfig !== null &&
    !projectsQuery.isLoading;
  useEffect(() => {
    if (bootRevealed) return;
    if (bootReady) {
      // One frame for the ready layout to commit, then fade the veil.
      const frame = requestAnimationFrame(() => setBootRevealed(true));
      return () => cancelAnimationFrame(frame);
    }
    // Failsafe: a wedged query must never leave the veil up forever.
    const timer = window.setTimeout(() => setBootRevealed(true), 8000);
    return () => window.clearTimeout(timer);
  }, [bootReady, bootRevealed]);

  // Warm the Monaco chunk (half the renderer bundle) while idle after
  // boot — the FIRST diff or editor open should not pay a multi-hundred-
  // millisecond parse in front of the user.
  useEffect(() => {
    if (!bootReady) return;
    const timer = window.setTimeout(() => {
      void import("./screens/diff-screen.js");
      void import("./screens/editor-screen.js");
    }, 1_500);
    return () => window.clearTimeout(timer);
  }, [bootReady]);

  // --- agent workspace bridge -------------------------------------------
  // Agents' workspace tools land here from main: discovery (overview /
  // readTab), agent-spawned surfaces (browser tabs, terminals), and the
  // control handoff. Every window answers; the ones without this project
  // reply null and main takes the first real answer.
  const chatLabelsRef = useRef<Record<string, string>>({});
  const projectIdRef = useRef(projectId);
  projectIdRef.current = projectId;
  const sidebarConfigRef = useRef<SidebarConfig | null>(sidebarConfig);
  sidebarConfigRef.current = sidebarConfig;
  const activeProfileRef = useRef(activeProfile);
  activeProfileRef.current = activeProfile;
  useEffect(() => {
    /** The chat an agent-spawned surface belongs to: exact session match
        first (the tools carry their chat's session id), then the mid-turn
        heuristic for anything that arrives unattributed. */
    const resolveWorkingChat = (sessionId?: string): string | undefined => {
      const ws = workspaceRef.current;
      if (sessionId) {
        const owner = ws.chats.find((chat) => chat.sessionId === sessionId);
        if (owner) return owner.localId;
      }
      const sending = ws.chats.filter(
        (chat) => signalsRef.current[chat.localId]?.working,
      );
      const preferred =
        sending.find((chat) => chat.localId === ws.activeChatId) ??
        sending.at(-1) ??
        ws.chats.find((chat) => chat.localId === ws.activeChatId);
      return preferred?.localId;
    };

    const handle = async (
      method: string,
      params: Record<string, unknown>,
    ): Promise<unknown> => {
      if (params.projectId && params.projectId !== projectIdRef.current) {
        return null;
      }
      const ws = workspaceRef.current;
      switch (method) {
        case "overview": {
          const keys = orderedTabKeys(ws, { includeCollapsed: true });
          const tabs: Record<string, unknown>[] = keys.map((key) => {
            const base: Record<string, unknown> = {
              key,
              active: key === ws.activeTabKey,
            };
            if (key.startsWith("browser:")) {
              const id = key.slice("browser:".length);
              const entry = ws.browsers.find((b) => b.localId === id);
              return {
                ...base,
                kind: "browser",
                title: entry?.title,
                url: entry?.url,
                agentControlled: entry?.agentControlled ?? false,
              };
            }
            if (key.startsWith("terminal:")) {
              const id = key.slice("terminal:".length);
              const entry = ws.terminals.find((t) => t.localId === id);
              return {
                ...base,
                kind: "terminal",
                title: entry?.title || "Terminal",
                running: entry?.running ?? true,
                // What agents need to target this terminal (run_terminal
                // terminalId) and to know whether it's mid-command.
                terminalId: entry?.attachSessionId ?? entry?.ptySessionId,
                busy: entry?.busy ?? false,
                agentControlled: entry?.agentControlled ?? false,
              };
            }
            if (key.startsWith("editor:")) {
              const id = key.slice("editor:".length);
              const entry = ws.editors.find((e) => e.localId === id);
              // The focused editor's live selection rides along so the
              // agent knows what "this" means without a pill.
              const selection =
                ws.activeTabKey === key ? readEditorSelection() : null;
              return {
                ...base,
                kind: "editor",
                filePath: entry?.filePath,
                ...(selection && selection.filePath === entry?.filePath
                  ? {
                      selection: {
                        text: selection.text,
                        startLine: selection.startLine,
                        endLine: selection.endLine,
                      },
                    }
                  : {}),
              };
            }
            if (key.startsWith("chat:")) {
              const id = key.slice("chat:".length);
              return {
                ...base,
                kind: "chat",
                title: chatLabelsRef.current[id] ?? "Chat",
              };
            }
            if (key.startsWith("diff:")) {
              const entry = ws.tabs.find((t) => tabKey(t) === key);
              return {
                ...base,
                kind: "diff",
                filePath:
                  entry?.kind === "diff" ? entry.source.filePath : undefined,
              };
            }
            const [kind, name] = key.split(":", 2);
            return { ...base, kind, name };
          });
          // Chip-only surfaces own no tab, but the agent must still see
          // them in context. List them after the visible workspace tabs.
          for (const entry of ws.browsers) {
            if (!entry.background) continue;
            tabs.push({
              key: browserTabKey(entry.localId),
              active: false,
              kind: "browser",
              title: entry.title,
              url: entry.url,
              agentControlled: entry.agentControlled ?? false,
              background: true,
            });
          }
          for (const entry of ws.terminals) {
            if (!entry.background) continue;
            tabs.push({
              key: terminalTabKey(entry.localId),
              active: false,
              kind: "terminal",
              title: entry.title || "Terminal",
              running: entry.running ?? true,
              terminalId: entry.attachSessionId ?? entry.ptySessionId,
              busy: entry.busy ?? false,
              agentControlled: entry.agentControlled ?? false,
              background: true,
            });
          }
          for (const entry of ws.editors) {
            if (!entry.background) continue;
            tabs.push({
              key: editorTabKey(entry.localId),
              active: false,
              kind: "editor",
              filePath: entry.filePath,
              background: true,
            });
          }
          const chats = ws.chats.map((chat) => ({
            key: chatTabKey(chat.localId),
            title: chatLabelsRef.current[chat.localId] ?? "Chat",
            state: chat.mode,
            working: Boolean(signalsRef.current[chat.localId]?.working),
            // Lets the context snapshot mark the asking agent's own chat.
            sessionId: chat.sessionId ?? null,
          }));
          const sidebar = (sidebarConfigRef.current?.sections ?? []).map(
            (section) => ({
              type: section.type,
              title: section.title,
              items: (section.items ?? []).map((item) => ({
                label: item.label,
                url: item.url,
              })),
            }),
          );
          return { tabs, chats, sidebar, split: ws.split };
        }
        case "browserGuest": {
          const key = String(params.key);
          const id = key.slice("browser:".length);
          const guestId = browserGuestIdsRef.current.get(id);
          return guestId
            ? { guestId }
            : { error: `No live page for ${key} (tab closed or not loaded)` };
        }
        case "terminalId": {
          const key = String(params.key);
          const id = key.slice("terminal:".length);
          const entry = ws.terminals.find((t) => t.localId === id);
          const terminalId = entry?.attachSessionId ?? entry?.ptySessionId;
          return terminalId ? { terminalId } : null;
        }
        case "terminalKey": {
          // Reverse lookup: PTY session → workspace tab key (agent-targeted
          // runs in existing terminals, including the user's own tabs).
          const terminalId = String(params.terminalId);
          const entry = ws.terminals.find(
            (t) =>
              t.attachSessionId === terminalId || t.ptySessionId === terminalId,
          );
          return entry ? { key: terminalTabKey(entry.localId) } : null;
        }
        case "readTab": {
          const key = String(params.key);
          if (key.startsWith("editor:")) {
            const id = key.slice("editor:".length);
            const entry = ws.editors.find((e) => e.localId === id);
            if (!entry) return null;
            const selection =
              ws.activeTabKey === key ? readEditorSelection() : null;
            return {
              kind: "editor",
              filePath: entry.filePath,
              ...(selection && selection.filePath === entry.filePath
                ? {
                    selection: {
                      text: selection.text,
                      startLine: selection.startLine,
                      endLine: selection.endLine,
                    },
                  }
                : {}),
            };
          }
          if (key.startsWith("chat:")) {
            const id = key.slice("chat:".length);
            const chat = ws.chats.find((c) => c.localId === id);
            return chat
              ? {
                  kind: "chat",
                  sessionId: chat.sessionId ?? null,
                  title: chatLabelsRef.current[id] ?? "Chat",
                }
              : null;
          }
          const tab = ws.tabs.find((t) => tabKey(t) === key);
          if (!tab) return null;
          return tab.kind === "diff"
            ? { kind: "diff", name: tab.name, filePath: tab.source.filePath }
            : { kind: tab.kind, name: tab.name };
        }
        case "openAgentBrowser": {
          if (!activeProfileRef.current) return { error: "No profile" };
          const localId = crypto.randomUUID();
          const entry: BrowserEntry = {
            localId,
            profileId: activeProfileRef.current.id,
            initialUrl: String(params.url),
            url: String(params.url),
            title: String(params.url),
            faviconUrl: null,
            chatLocalId: resolveWorkingChat(
              typeof params.sessionId === "string"
                ? params.sessionId
                : undefined,
            ),
            agentControlled: true,
          };
          updateWorkspace((current) => ({
            ...current,
            browsers: [...current.browsers, entry],
          }));
          // The guest attaches once the (hidden) webview mounts.
          const deadline = Date.now() + 10_000;
          while (Date.now() < deadline) {
            const guestId = browserGuestIdsRef.current.get(localId);
            if (guestId) return { key: browserTabKey(localId) };
            await new Promise((resolve) => setTimeout(resolve, 150));
          }
          return { error: "The page never finished mounting." };
        }
        case "attachAgentTerminal": {
          const localId = crypto.randomUUID();
          const chatLocalId = resolveWorkingChat(
            typeof params.sessionId === "string" ? params.sessionId : undefined,
          );
          const entry: TerminalEntry = {
            localId,
            title: "Agent terminal",
            chatLocalId,
            attachSessionId: String(params.terminalId),
            agentControlled: true,
            running: true,
            // Agent terminals start as chips, not tabs — the user's view
            // doesn't move because an agent ran a command. Without a chat
            // to carry the chip there'd be no way to see it at all, so
            // only then does it open as a (non-focused) tab.
            background: chatLocalId !== undefined,
          };
          updateWorkspace((current) => ({
            ...current,
            terminals: [...current.terminals, entry],
          }));
          return { key: terminalTabKey(localId) };
        }
        case "openTarget": {
          const target = String(params.target ?? "");
          const sessionId =
            typeof params.sessionId === "string" ? params.sessionId : undefined;
          // Who is asking, and is the user watching them? If the
          // requesting chat IS the user's active surface (its tab
          // focused, or its floating dock up), the agent is showing
          // them something — open in front, as always. Otherwise the
          // user is busy elsewhere: never steal their focus. Prepare
          // the tab in the background and light the attention dot on
          // the surface's chip on the agent's own chat; the result
          // tells the agent which of the two happened so it narrates
          // honestly. A target the user is ALREADY looking at counts
          // as watched — nothing to steal.
          const requesterId = resolveWorkingChat(sessionId);
          const requester = ws.chats.find(
            (chat) => chat.localId === requesterId,
          );
          // Without a chat to carry the chip, a background open would
          // be invisible — fall back to opening in front.
          const watching = requester ? chatVisible(ws, requester) : true;
          const openInBackground = (key: string) =>
            !watching && Boolean(requester) && ws.activeTabKey !== key;
          const background = (key: string) => {
            if (requester) {
              setChipAttention((current) => {
                const keys = current[requester.localId] ?? [];
                return keys.includes(key)
                  ? current
                  : { ...current, [requester.localId]: [...keys, key] };
              });
            }
            return {
              key,
              opened: "background" as const,
              note: "The user is looking at something else — the tab is ready in the background and its chip is highlighted on your chat. Tell them it's ready instead of assuming they saw it.",
            };
          };
          // The chat steps down from full tab to its floating dock so the
          // opened tab is visible behind it — the agent is SHOWING the
          // user something, not replacing their view with itself.
          const stepChatAside = () => {
            if (!requesterId) return;
            updateWorkspace((current) => ({
              ...current,
              chats: current.chats.map((chat) =>
                chat.localId === requesterId && chat.mode === "tab"
                  ? { ...chat, mode: "partial" }
                  : chat,
              ),
            }));
          };
          if (target.startsWith("app:")) {
            const name = target.slice("app:".length);
            const key = `app:${name}`;
            if (openInBackground(key)) {
              updateWorkspace((current) => ({
                ...current,
                tabs: current.tabs.some((tab) => tabKey(tab) === key)
                  ? current.tabs
                  : [...current.tabs, { kind: "app", name }],
              }));
              return background(key);
            }
            updateWorkspace((current) => {
              const exists = current.tabs.some((tab) => tabKey(tab) === key);
              return {
                ...current,
                tabs: exists
                  ? current.tabs
                  : [...current.tabs, { kind: "app", name }],
                activeTabKey: key,
                split: null,
              };
            });
            stepChatAside();
            return { key, opened: "focused" };
          }
          if (target.startsWith("file:")) {
            const filePath = target.slice("file:".length);
            const localId = crypto.randomUUID();
            const root = projectIdRef.current
              ? await desktopApi.projectRoot(projectIdRef.current)
              : null;
            const location = root
              ? resolveProjectFileLocation(root, filePath)
              : null;
            if (location && isPdfPath(location.relativePath)) {
              if (!activeProfileRef.current) return { error: "No profile" };
              const entry: BrowserEntry = {
                localId,
                profileId: activeProfileRef.current.id,
                initialUrl: localFileUrl(location.absolutePath),
                url: localFileUrl(location.absolutePath),
                title: fileNameFromPath(location.relativePath),
                faviconUrl: null,
                chatLocalId: requester?.localId,
              };
              if (openInBackground(browserTabKey(localId)) && requester) {
                updateWorkspace((current) => ({
                  ...current,
                  browsers: [...current.browsers, entry],
                }));
                return background(browserTabKey(localId));
              }
              updateWorkspace((current) => ({
                ...current,
                browsers: [...current.browsers, entry],
                activeTabKey: browserTabKey(localId),
                split: null,
              }));
              stepChatAside();
              return { key: browserTabKey(localId), opened: "focused" };
            }
            const relativePath = location?.relativePath ?? filePath;
            if (openInBackground(editorTabKey(localId)) && requester) {
              updateWorkspace((current) => ({
                ...current,
                editors: [
                  ...current.editors,
                  // Attached to the asking chat, so the chip carrying
                  // the attention dot has a rail to ride.
                  {
                    localId,
                    filePath: relativePath,
                    dirty: false,
                    chatLocalId: requester.localId,
                  },
                ],
              }));
              return background(editorTabKey(localId));
            }
            updateWorkspace((current) => ({
              ...current,
              editors: [
                ...current.editors,
                // Attached to the asking chat even when focused, so "show
                // the user this file" always leaves a chip on the rail.
                {
                  localId,
                  filePath: relativePath,
                  dirty: false,
                  chatLocalId: requester?.localId,
                },
              ],
              activeTabKey: editorTabKey(localId),
              split: null,
            }));
            stepChatAside();
            return { key: editorTabKey(localId), opened: "focused" };
          }
          if (/^https?:\/\//.test(target)) {
            if (!activeProfileRef.current) return { error: "No profile" };
            const localId = crypto.randomUUID();
            const entry: BrowserEntry = {
              localId,
              profileId: activeProfileRef.current?.id ?? "",
              initialUrl: target,
              url: target,
              title: target,
              faviconUrl: null,
              chatLocalId: requesterId,
            };
            if (openInBackground(browserTabKey(localId))) {
              // The hidden pane keeps webviews alive, so the page
              // loads while the user finishes what they're doing.
              updateWorkspace((current) => ({
                ...current,
                browsers: [...current.browsers, entry],
              }));
              return background(browserTabKey(localId));
            }
            updateWorkspace((current) => ({
              ...current,
              browsers: [...current.browsers, entry],
              activeTabKey: browserTabKey(localId),
              split: null,
            }));
            stepChatAside();
            return { key: browserTabKey(localId), opened: "focused" };
          }
          // A background agent terminal: open_surface is the agent
          // explicitly SHOWING it — materialize the tab (focused only
          // if the user is watching the agent).
          if (target.startsWith("terminal:")) {
            const localId = target.slice("terminal:".length);
            if (ws.terminals.some((t) => t.localId === localId)) {
              if (openInBackground(target)) {
                updateWorkspace((current) => ({
                  ...current,
                  terminals: current.terminals.map((t) =>
                    t.localId === localId ? { ...t, background: false } : t,
                  ),
                }));
                return background(target);
              }
              updateWorkspace((current) => ({
                ...current,
                terminals: current.terminals.map((t) =>
                  t.localId === localId ? { ...t, background: false } : t,
                ),
                activeTabKey: target,
                split: null,
              }));
              stepChatAside();
              return { key: target, opened: "focused" };
            }
          }
          const detachedBrowser = ws.browsers.some(
            (browser) =>
              browserTabKey(browser.localId) === target && browser.background,
          );
          const detachedEditor = ws.editors.some(
            (editor) =>
              editorTabKey(editor.localId) === target && editor.background,
          );
          if (detachedBrowser || detachedEditor) {
            if (openInBackground(target)) return background(target);
            updateWorkspace((current) => ({
              ...current,
              browsers: current.browsers.map((browser) =>
                browserTabKey(browser.localId) === target
                  ? { ...browser, background: false }
                  : browser,
              ),
              editors: current.editors.map((editor) =>
                editorTabKey(editor.localId) === target
                  ? { ...editor, background: false }
                  : editor,
              ),
              activeTabKey: target,
              split: null,
            }));
            stepChatAside();
            return { key: target, opened: "focused" };
          }
          // An existing tab key from workspace_overview: focus it.
          if (
            !orderedTabKeys(ws, { includeCollapsed: true }).includes(target)
          ) {
            return {
              error: `No such target: ${target}. Use a tab key from workspace_overview, "app:<name>", "file:<path>", or a URL.`,
            };
          }
          // The tab already exists; "background" is just not focusing
          // it — the chip's attention dot does the pointing.
          if (openInBackground(target)) return background(target);
          updateWorkspace((current) => ({
            ...current,
            activeTabKey: target,
            split: null,
            ...(target.startsWith("chat:")
              ? {
                  activeChatId: target.slice("chat:".length),
                  chats: current.chats.map((chat) =>
                    chat.localId === target.slice("chat:".length)
                      ? { ...chat, mode: "tab" }
                      : chat,
                  ),
                }
              : {}),
          }));
          if (!target.startsWith("chat:")) stepChatAside();
          return { key: target, opened: "focused" };
        }
        case "pointAt": {
          const target = String(params.target ?? "").trim();
          if (!target) return { ok: false, error: "Empty target" };
          const note =
            typeof params.note === "string" && params.note.trim()
              ? params.note.trim().slice(0, 60)
              : undefined;
          const keep = params.keepPrevious === true;
          setAgentPointersRef.current((current) => {
            const rest = keep
              ? current.filter((pointer) => pointer.target !== target)
              : [];
            return [...rest, { target, note }];
          });
          return { ok: true };
        }
        case "clearPointers": {
          setAgentPointersRef.current([]);
          return { ok: true };
        }
        case "elicit": {
          // Broadcast reaches every window; only the focused one renders
          // it (others return null = "not me"), so the user sees exactly
          // one modal and it can't be answered by a background window.
          if (!document.hasFocus()) return null;
          const request = params.request as
            | PendingElicitation["request"]
            | undefined;
          if (!request || (request.mode !== "form" && request.mode !== "url")) {
            return { action: "decline" };
          }
          const label =
            typeof params.label === "string" ? params.label : undefined;
          // Resolve when the modal answers; the bridge awaits this promise.
          return new Promise<unknown>((resolve) => {
            setElicitationRef.current({
              id: crypto.randomUUID(),
              label,
              request,
              resolve: (result) => {
                setElicitationRef.current(null);
                resolve(result);
              },
            });
          });
        }
        case "toolPermission": {
          // Main sends this to ONE window (focused, else first) — no
          // focus guard here, or an alt-tabbed user would auto-deny.
          const request = params.request as
            | PendingToolPermission["request"]
            | undefined;
          if (!request || typeof request.tool !== "string") {
            return { decision: "deny" };
          }
          const label =
            typeof params.label === "string" ? params.label : undefined;
          const askId =
            typeof params.askId === "number" ? params.askId : undefined;
          return new Promise<unknown>((resolve) => {
            const id = crypto.randomUUID();
            setToolPermissionsRef.current((queue) => [
              ...queue,
              {
                id,
                askId,
                label,
                request,
                resolve: (decision) => {
                  setToolPermissionsRef.current((current) =>
                    current.filter((entry) => entry.id !== id),
                  );
                  resolve(decision);
                },
              },
            ]);
          });
        }
        case "toolPermissionCancel": {
          // The ask was answered elsewhere (a remote companion client):
          // withdraw the card silently — no deny, no answer, no flash.
          const askId =
            typeof params.askId === "number" ? params.askId : undefined;
          if (askId !== undefined) {
            setToolPermissionsRef.current((current) =>
              current.filter((entry) => entry.askId !== askId),
            );
          }
          return { ok: true };
        }
        case "requestConnection": {
          // Main sends this to ONE window (focused, else first) — no
          // renderer-side focus guard, so an unfocused single window
          // still shows the modal instead of silently declining.
          const query = typeof params.query === "string" ? params.query : "";
          const reason =
            typeof params.reason === "string" ? params.reason : undefined;
          const sessionId =
            typeof params.sessionId === "string" ? params.sessionId : "";
          const before = await desktopApi.connectionsList().catch(() => []);
          return new Promise<unknown>((resolve) => {
            setConnectorRequestRef.current({
              query,
              reason,
              sessionId,
              before: new Set(before.map((connection) => connection.id)),
              resolve: (result) => {
                setConnectorRequestRef.current(null);
                resolve(result);
              },
            });
            setConnectorsModalOpenRef.current(true);
          });
        }
        case "surfaceControl": {
          const key = String(params.key);
          const controlled = Boolean(params.controlled);
          updateWorkspace((current) => ({
            ...current,
            browsers: current.browsers.map((b) =>
              browserTabKey(b.localId) === key
                ? { ...b, agentControlled: controlled }
                : b,
            ),
            terminals: current.terminals.map((t) =>
              terminalTabKey(t.localId) === key
                ? { ...t, agentControlled: controlled }
                : t,
            ),
          }));
          return { ok: true };
        }
        case "closeSurface": {
          // The agent's close is final (main already killed an agent
          // terminal's PTY) — never soft-close back to a background chip.
          closeTabRef.current(String(params.key), { force: true });
          return { ok: true };
        }
        default:
          return null;
      }
    };

    return desktopApi.onBridgeRequest(({ id, method, params }) => {
      void handle(method, params)
        .catch((error: Error) => ({ error: error.message }))
        .then((result) => desktopApi.bridgeRespond({ id, result }));
    });
  }, [updateWorkspace]);

  // Foreground-command activity from main: chip spinners spin while a
  // command runs, not for the shell's whole lifetime.
  useEffect(
    () =>
      desktopApi.onTerminalBusy(({ sessionId, busy }) => {
        updateWorkspace((ws) => ({
          ...ws,
          terminals: ws.terminals.map((terminal) =>
            terminal.attachSessionId === sessionId ||
            terminal.ptySessionId === sessionId
              ? { ...terminal, busy }
              : terminal,
          ),
        }));
      }),
    [updateWorkspace],
  );

  const activeTab = workspace.tabs.find(
    (tab) => tabKey(tab) === workspace.activeTabKey,
  );

  const chatLabels = Object.fromEntries(
    workspace.chats.map((chat, index) => {
      const session = sessionsById.get(chat.sessionId ?? "");
      return [
        chat.localId,
        session?.title
          ? truncateLabel(session.title)
          : chat.sessionId
            ? `Chat ${index + 1}`
            : "New chat",
      ];
    }),
  );
  // Conversation identity beyond the label: the agent-chosen icon, and
  // whether the chat is a fork (fork glyph, back-to-parent affordance).
  const chatIcons: Record<string, string | null> = Object.fromEntries(
    workspace.chats.map((chat) => [
      chat.localId,
      sessionsById.get(chat.sessionId ?? "")?.icon ?? null,
    ]),
  );
  const chatForks: Record<string, boolean> = Object.fromEntries(
    workspace.chats.map((chat) => [
      chat.localId,
      Boolean(
        chat.parentLocalId ??
          sessionsById.get(chat.sessionId ?? "")?.parentSessionId,
      ),
    ]),
  );
  // Strip entries in visual order (drag-arranged + group-clustered), with
  // group membership stamped for the grouped styling.
  const tabByKey = new Map<string, WorkspaceTab>(
    [
      ...workspace.tabs,
      ...browserTabs(workspace),
      ...terminalTabs(workspace),
      ...editorTabs(workspace),
      ...chatTabs(workspace, chatLabels, chatIcons, chatForks),
    ].map((tab) => [tabKey(tab), tab]),
  );
  const groupOfKey = new Map<string, string>();
  const tabGroups = workspace.chats
    .filter((chat) => chat.mode === "tab")
    .map((chat) => {
      const memberKeys = attachedTabKeys(workspace, chat.localId);
      for (const key of memberKeys) groupOfKey.set(key, chat.localId);
      groupOfKey.set(chatTabKey(chat.localId), chat.localId);
      return {
        parentKey: chatTabKey(chat.localId),
        memberKeys,
        collapsed: Boolean(chat.surfacesCollapsed),
      };
    })
    .filter((group) => group.memberKeys.length > 0);
  const allTabs = orderedTabKeys(workspace)
    .map((key) => {
      const tab = tabByKey.get(key);
      if (!tab) return null;
      const groupId = groupOfKey.get(key);
      return groupId ? { ...tab, groupId } : tab;
    })
    .filter((tab): tab is WorkspaceTab => tab !== null);
  const activeChatTabId = workspace.activeTabKey?.startsWith("chat:")
    ? workspace.activeTabKey.slice("chat:".length)
    : undefined;
  const activeBrowserTabId = workspace.activeTabKey?.startsWith("browser:")
    ? workspace.activeTabKey.slice("browser:".length)
    : undefined;
  const activeTerminalTabId = workspace.activeTabKey?.startsWith("terminal:")
    ? workspace.activeTabKey.slice("terminal:".length)
    : undefined;
  // The split renders only while valid: both panes still exist and one of
  // them is focused. Any mutation that breaks that (a close, a chat mode
  // change, a plain tab open) silently falls back to the single view —
  // no updater needs to know about splits.
  chatLabelsRef.current = chatLabels;
  const allTabKeysNow = orderedTabKeys(workspace);
  const split =
    workspace.split &&
    allTabKeysNow.includes(workspace.split.leftKey) &&
    allTabKeysNow.includes(workspace.split.rightKey) &&
    (workspace.activeTabKey === workspace.split.leftKey ||
      workspace.activeTabKey === workspace.split.rightKey)
      ? workspace.split
      : null;

  /** Which tabs the content area shows, and where. */
  const viewSlots: Record<string, "full" | "left" | "right"> = split
    ? { [split.leftKey]: "left", [split.rightKey]: "right" }
    : workspace.activeTabKey
      ? { [workspace.activeTabKey]: "full" }
      : {};
  const splitRatio = split?.ratio ?? 0.5;
  const SLOT_CLASSES = {
    full: "absolute inset-0 flex flex-col",
    left: "absolute inset-y-0 left-0 flex flex-col border-r border-border",
    right: "absolute inset-y-0 right-0 flex flex-col",
  } as const;
  // Un-siding (and re-tiling) tweens the pane edges instead of snapping;
  // the transition pauses during a divider drag so resizing tracks the
  // pointer 1:1.
  const paneGeometryTransition = dividerDragging
    ? ""
    : " transition-[left,right] duration-200 ease-[cubic-bezier(0.2,0,0,1)]";
  const paneClass = (key: string) => {
    const slot = viewSlots[key];
    if (slot) return SLOT_CLASSES[slot] + paneGeometryTransition;
    // Browser panes keep their layout while hidden — a display:none
    // webview detaches its guest and background pages would stop
    // loading (worse for agent-driven tabs).
    return key.startsWith("browser:")
      ? "invisible pointer-events-none absolute inset-0 flex flex-col"
      : "hidden";
  };
  /** Ratio-driven pane geometry (50/50 until the divider is dragged). */
  const paneStyle = (key: string): React.CSSProperties | undefined => {
    const slot = viewSlots[key];
    if (slot === "left") return { right: `${(1 - splitRatio) * 100}%` };
    if (slot === "right") return { left: `${splitRatio * 100}%` };
    return undefined;
  };
  /** Clicking anywhere in an unfocused pane focuses it. */
  const paneFocusProps = (key: string) =>
    split && workspace.activeTabKey !== key && viewSlots[key]
      ? { onMouseDownCapture: () => selectTab(key) }
      : {};
  const splitCompanionKey = split
    ? workspace.activeTabKey === split.leftKey
      ? split.rightKey
      : split.leftKey
    : undefined;

  /**
   * A rail chip for an attention key with no attached surface behind it
   * (an app tab open_surface prepared in the background, another chat's
   * tab, …): the attention dot needs a chip to live on, so one is
   * synthesized from what the workspace knows about the key.
   */
  const synthesizedSurface = (key: string): ChatSurface => {
    if (key.startsWith("app:")) {
      return { key, kind: "app", label: key.slice("app:".length) };
    }
    if (key.startsWith("browser:")) {
      const entry = workspace.browsers.find(
        (browser) => browserTabKey(browser.localId) === key,
      );
      return {
        key,
        kind: "browser",
        label: entry?.title || entry?.url || "Page",
        faviconUrl: entry?.faviconUrl,
      };
    }
    if (key.startsWith("terminal:")) {
      const entry = workspace.terminals.find(
        (terminal) => terminalTabKey(terminal.localId) === key,
      );
      return { key, kind: "terminal", label: entry?.title || "Terminal" };
    }
    if (key.startsWith("editor:")) {
      const entry = workspace.editors.find(
        (editor) => editorTabKey(editor.localId) === key,
      );
      return {
        key,
        kind: "editor",
        label: entry?.filePath?.split("/").at(-1) || "Editor",
      };
    }
    if (key.startsWith("chat:")) {
      return {
        key,
        kind: "chat",
        label: chatLabels[key.slice("chat:".length)] ?? "Chat",
      };
    }
    const tab = workspace.tabs.find((candidate) => tabKey(candidate) === key);
    return { key, kind: "app", label: tab?.label ?? tab?.name ?? key };
  };

  /** The agent's working tabs for a chat — its surfaces rail. */
  const surfacesFor = (chat: ChatDockEntry): ChatSurface[] => {
    const attentionKeys = chipAttention[chat.localId] ?? [];
    const surfaces: ChatSurface[] = [
      // Conversations forked from this one ride the rail as chips too.
      ...workspace.chats
        .filter((candidate) => candidate.parentLocalId === chat.localId)
        .map((candidate) => ({
          key: chatTabKey(candidate.localId),
          kind: "chat" as const,
          label: chatLabels[candidate.localId] ?? "Fork",
          active: Boolean(signalsByChat[candidate.localId]?.working),
          removable: true,
        })),
      ...workspace.browsers
        .filter((browser) => browser.chatLocalId === chat.localId)
        .map((browser) => ({
          key: browserTabKey(browser.localId),
          kind: "browser" as const,
          label: browser.title || browser.url || "Page",
          faviconUrl: browser.faviconUrl,
          active: Boolean(browser.agentControlled),
          removable: true,
        })),
      ...workspace.terminals
        .filter((terminal) => terminal.chatLocalId === chat.localId)
        .map((terminal) => ({
          key: terminalTabKey(terminal.localId),
          kind: "terminal" as const,
          label: terminal.title || "Terminal",
          // The spinner tracks the COMMAND, not the shell: busy means a
          // foreground process is actually running in there right now.
          active: terminal.busy === true,
          removable: true,
        })),
      ...workspace.editors
        .filter((editor) => editor.chatLocalId === chat.localId)
        .map((editor) => ({
          key: editorTabKey(editor.localId),
          kind: "editor" as const,
          label: editor.filePath?.split("/").at(-1) || "Editor",
          removable: true,
        })),
    ];
    if (attentionKeys.length === 0) return surfaces;
    // Chips whose surface the agent opened in the background carry the
    // attention dot until the user opens them.
    const marked = surfaces.map((surface) =>
      attentionKeys.includes(surface.key)
        ? { ...surface, attention: true }
        : surface,
    );
    for (const key of attentionKeys) {
      if (!marked.some((surface) => surface.key === key)) {
        marked.push({ ...synthesizedSurface(key), attention: true });
      }
    }
    return marked;
  };

  // Everything the palette searches and acts on, shared by both hosts
  // (the Cmd+P overlay and palette "New Tab" tabs).
  const paletteProps = projectId
    ? {
        projectId,
        profileId: activeProfile?.id,
        projects,
        activeProjectId: projectId,
        profiles: profilesData?.profiles ?? [],
        activeProfileId: activeProfile?.id,
        sidebarConfig,
        onOpenUrl: openUrl,
        onOpenTab: openTab,
        onOpenSession: openSession,
        onSelectProject: selectProject,
        onSwitchProfile: switchProfile,
        onSendToAgent: sendToAgent,
        onRunSkill: runSkill,
        actionHandlers,
        agents: agentsData?.agents ?? [],
        defaultAgentId: effectiveDefaultAgentId,
        focusedChat: focusedChat
          ? {
              agentId: focusedSession?.agentId ?? focusedChat.agentId ?? null,
              effort: focusedSession?.modelEffort ?? null,
            }
          : null,
        onPickDefaultAgent: pickDefaultAgent,
        onPickSessionAgent: pickSessionAgent,
        onPickProjectAgent: pickProjectAgent,
        onConfigureAgent: openConfigureAgent,
        defaultAgentOverridden: projectOverrideAgentId !== null,
        onClearDefaultOverride: () => {
          if (projectId) {
            void desktopApi.agentsSetProjectDefault(projectId, null);
          }
        },
        onPickEffort: pickEffort,
        onPickModel: pickModel,
        onHighlightTarget: setPaletteTarget,
      }
    : null;

  return (
    <div className="flex h-full">
      {/* Agent pointers: glow + scroll on data-point-key elements. The
          workspace object is the re-resolve trigger — a pointed tab may
          mount after the point_at call. */}
      <AgentPointers
        pointers={agentPointers}
        onDismiss={dismissPointer}
        revision={workspace}
      />
      {/* MCP elicitation: a connector asking the user a form or to open a
          sign-in URL. URL consent opens the page as a browser tab. */}
      <ElicitationModal
        pending={elicitation}
        onOpenUrl={(url) => openBrowserTab(url)}
      />
      <ToolPermissionModal
        pending={toolPermissions[0] ?? null}
        queued={Math.max(0, toolPermissions.length - 1)}
      />
      <MobilePairingModal
        open={mobilePairing.open}
        context={mobilePairing.context}
        onClose={() => setMobilePairing({ open: false, context: null })}
      />
      {/* Project-agent consent (ADR 0050): approve, then complete the
          original pick and refresh the roster's consent state. */}
      <ProjectAgentConsentDialog
        request={consentRequest}
        onClose={() => setConsentRequest(null)}
        onApproved={(agent) => {
          const target = consentRequest?.target ?? "session";
          setConsentRequest(null);
          applyProjectAgent(agent, target);
        }}
      />
      <aside
        className={`flex shrink-0 flex-col overflow-hidden border-r border-border bg-bg-raised transition-[width] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          sidebarOpen ? "w-[260px]" : "w-0 border-r-0"
        }`}
        aria-hidden={!sidebarOpen}
        inert={!sidebarOpen ? true : undefined}
      >
        <div className="flex w-[260px] flex-1 flex-col overflow-hidden">
          <div className="app-drag h-10 shrink-0" />

          <div className="flex items-center gap-1 px-3 pb-3">
            <ProjectSwitcher
              projects={projects}
              activeProjectId={projectId}
              onSelect={selectProject}
              onNewProject={() => setProjectModalOpen(true)}
              onConnectRemote={() =>
                setRemoteConnect({ open: true, link: null })
              }
              onDeleteProject={setDeletingProject}
            />
            <RemoteConnectionIndicator projectId={projectId} />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            {projectId &&
              (sidebarConfig?.sections ?? []).map((section, index) => (
                <ConfiguredSection
                  // biome-ignore lint/suspicious/noArrayIndexKey: sections have no id; the same type may appear twice, and order IS identity here
                  key={`${section.type}:${index}`}
                  section={section}
                  projectId={projectId}
                  profileId={activeProfile?.id}
                  activeTab={activeTab}
                  activeChatSessionId={
                    workspace.chats.find(
                      (chat) => chat.localId === workspace.activeChatId,
                    )?.sessionId
                  }
                  keybindingLabel={formatBinding(
                    keybindings["new-floating-chat"],
                  )}
                  agentsData={agentsData}
                  defaultAgentId={effectiveDefaultAgentId}
                  projectAgentNames={projectAgentNames}
                  onOpenTab={openTab}
                  onNewChat={() => addChat()}
                  onOpenSession={openSession}
                  onOpenUrl={openUrl}
                  onOpenFile={(filePath) => openEditorTab({ filePath })}
                  onOpenHistory={setRemoteHistoryPath}
                  onPublish={(path, features) =>
                    setRemotePublish({ path, features })
                  }
                  onPropose={(files, features) =>
                    setRemotePropose({ files, features })
                  }
                />
              ))}
          </div>

          <footer className="border-t border-border p-2">
            {profilesData && activeProfile && (
              <ProfileBar
                data={profilesData}
                projects={allProjects}
                activeProfileId={activeProfile.id}
                onSwitch={switchProfile}
                onOpenSettings={(profileId) =>
                  openTab({
                    kind: "profile-settings",
                    name: profileId,
                    label:
                      profilesData.profiles.find(
                        (profile) => profile.id === profileId,
                      )?.name ?? "Profile",
                  })
                }
              />
            )}
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() =>
                  openTab({
                    kind: "settings",
                    name: "settings",
                    label: "Settings",
                  })
                }
                className={`flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-150 ${
                  activeTab?.kind === "settings"
                    ? "bg-bg-overlay text-fg"
                    : "text-fg-muted hover:bg-bg-overlay hover:text-fg"
                }`}
              >
                <SettingsIcon className="size-3.5" />
                Settings
              </button>
              {/* The sidebar is agent-authored (sidebar.js) — this hands
                  the request to the agent instead of a settings form. */}
              <ShortcutHint label="Customize sidebar">
                <button
                  type="button"
                  onClick={() =>
                    sendToAgent(
                      "I want to customize my sidebar. Can you walk me through what's possible and make the changes I ask for?",
                      "float",
                    )
                  }
                  className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                  aria-label="Customize sidebar"
                >
                  <Wand2 className="size-3.5" />
                </button>
              </ShortcutHint>
            </div>
          </footer>
        </div>
      </aside>

      {/* min-h-0/overflow-hidden: the content column must clip its panes
          (terminal canvases refit asynchronously and may overshoot for a
          frame) rather than push the document taller than the window. */}
      <main className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
        {/* One chrome row: drag region + sidebar toggle + tabs. */}
        <div className="app-drag flex h-10 shrink-0 items-center gap-1 border-b border-border pl-2 pr-3">
          <span
            className={`app-no-drag transition-[margin] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
              sidebarOpen ? "" : "ml-[70px]"
            }`}
          >
            <ShortcutHint
              label="Toggle sidebar"
              shortcut={formatBinding(keybindings["toggle-sidebar"])}
            >
              <button
                type="button"
                onClick={() =>
                  setSidebarOpen((value) => {
                    void desktopApi.setPrefs({ sidebarOpen: !value });
                    return !value;
                  })
                }
                className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                aria-label={sidebarOpen ? "Collapse sidebar" : "Expand sidebar"}
                aria-expanded={sidebarOpen}
              >
                <PanelLeft className="size-4" />
              </button>
            </ShortcutHint>
          </span>
          {projectId && (
            <WorkspaceTabBar
              tabs={allTabs}
              activeKey={workspace.activeTabKey}
              secondaryKey={splitCompanionKey}
              highlightKey={targetedTabKey}
              groups={tabGroups}
              onSelect={selectTab}
              onClose={closeTab}
              onNew={openPaletteTab}
              onToggleGroup={toggleChatGroup}
              onReorder={reorderTab}
              onDragStateChange={(key) => {
                setTabDragKey(key);
                if (!key) setDropSideHover(null);
              }}
            />
          )}
        </div>

        {projectId ? (
          <div className="relative flex min-h-0 flex-1 flex-col">
            {/* Every tab pane lives in this wrapper so keyboard cycling
                  can nudge the visible content from the direction of
                  travel; chat docks and bubbles stay outside (they own
                  their own motion). */}
            <div
              className={`relative flex min-h-0 flex-1 flex-col ${
                paneMotion
                  ? paneMotion.direction === "left"
                    ? "animate-pane-in-left"
                    : "animate-pane-in-right"
                  : ""
              }`}
              onAnimationEnd={(event) => {
                if (event.animationName.startsWith("pane-in")) {
                  setPaneMotion(null);
                }
              }}
            >
              {/* Screen-style tabs render whenever they occupy a view
                    slot — in a split that can be two at once. */}
              {workspace.tabs
                .filter((tab) => viewSlots[tabKey(tab)])
                .map((tab) => (
                  <div
                    key={tabKey(tab)}
                    className={paneClass(tabKey(tab))}
                    style={paneStyle(tabKey(tab))}
                    {...paneFocusProps(tabKey(tab))}
                  >
                    {viewSlots[tabKey(tab)] !== "full" && (
                      <PaneUnsplitButton
                        onClick={() => openSurface(tabKey(tab), "tab")}
                      />
                    )}
                    {tab.kind === "workflow" ? (
                      <Suspense fallback={<div className="flex-1 bg-bg" />}>
                        <WorkflowScreen
                          projectId={projectId}
                          workflowName={tab.name}
                        />
                      </Suspense>
                    ) : tab.kind === "app" ? (
                      <AppScreen projectId={projectId} appName={tab.name} />
                    ) : tab.kind === "mcpapp" ? (
                      <McpAppScreen
                        toolKey={tab.toolKey}
                        toolInput={tab.toolInput}
                        toolResult={tab.toolResult}
                        onOpenLink={(url) => openBrowserTab(url)}
                      />
                    ) : tab.kind === "settings" ? (
                      <SettingsScreen
                        onClose={() => closeTab(tabKey(tab))}
                        onAddAgent={() => setWizardModalOpen(true)}
                        onConfigureAgent={openConfigureAgent}
                        onManageConnectors={() => setConnectorsModalOpen(true)}
                      />
                    ) : tab.kind === "profile-settings" && profilesData ? (
                      <ProfileSettingsScreen
                        profileId={tab.name}
                        activeProfileId={
                          activeProfile?.id ?? profilesData.defaultProfileId
                        }
                        data={profilesData}
                        projects={allProjects}
                        onClose={() => closeTab(tabKey(tab))}
                      />
                    ) : tab.kind === "usage" ? (
                      <Suspense fallback={<div className="flex-1 bg-bg" />}>
                        <UsageScreen />
                      </Suspense>
                    ) : tab.kind === "palette" && paletteProps ? (
                      <CommandPalette
                        incognitoAllowed={incognitoAllowed}
                        key={tabKey(tab)}
                        variant="tab"
                        onClose={() => closeTab(tabKey(tab))}
                        {...paletteProps}
                      />
                    ) : tab.kind === "agent-setup" ? (
                      <AgentWizard
                        variant="tab"
                        onClose={() => closeTab(tabKey(tab))}
                        onDone={() => closeTab(tabKey(tab))}
                      />
                    ) : tab.kind === "diff" ? (
                      <Suspense fallback={<div className="flex-1 bg-bg" />}>
                        <DiffScreen
                          projectId={tab.projectId}
                          source={tab.source}
                        />
                      </Suspense>
                    ) : null}
                  </div>
                ))}

              {/* Browser tabs stay mounted while hidden — unmounting a
                  webview would reload the page on every tab switch. */}
              {workspace.browsers.map((browser) => (
                <div
                  key={browser.localId}
                  className={paneClass(browserTabKey(browser.localId))}
                  style={paneStyle(browserTabKey(browser.localId))}
                  {...paneFocusProps(browserTabKey(browser.localId))}
                >
                  <BrowserScreen
                    profileId={browser.profileId}
                    projectId={projectId}
                    // Remounts (project/profile switches) resume at the
                    // last known URL, not the tab's original one.
                    initialUrl={browser.url || browser.initialUrl}
                    active={browser.localId === activeBrowserTabId}
                    visible={Boolean(viewSlots[browserTabKey(browser.localId)])}
                    keepAwake={Boolean(browser.agentControlled)}
                    onStateChange={(state) =>
                      onBrowserState(browser.localId, state)
                    }
                    registerNavigate={(navigate) =>
                      browserNavigatorsRef.current.set(
                        browser.localId,
                        navigate,
                      )
                    }
                    registerGuest={(guestId) => {
                      if (guestId === null) {
                        browserGuestIdsRef.current.delete(browser.localId);
                      } else {
                        browserGuestIdsRef.current.set(
                          browser.localId,
                          guestId,
                        );
                      }
                    }}
                    onUnsplit={
                      viewSlots[browserTabKey(browser.localId)] &&
                      viewSlots[browserTabKey(browser.localId)] !== "full"
                        ? () =>
                            openSurface(browserTabKey(browser.localId), "tab")
                        : undefined
                    }
                  />
                  <AgentControlOverlay
                    kind="page"
                    active={Boolean(browser.agentControlled)}
                    onTakeOver={() =>
                      takeOverSurface(browserTabKey(browser.localId))
                    }
                    onGoToChat={
                      browser.chatLocalId
                        ? () => revealChat(browser.chatLocalId as string)
                        : undefined
                    }
                  />
                </div>
              ))}

              {/* Terminals stay mounted while hidden — unmounting kills
                  the shell. Editors likewise, preserving undo history,
                  scroll position, and unsaved drafts across switches. */}
              {workspace.terminals.map((terminal) => (
                <div
                  key={terminal.localId}
                  data-surface-pane
                  className={paneClass(terminalTabKey(terminal.localId))}
                  style={paneStyle(terminalTabKey(terminal.localId))}
                  {...paneFocusProps(terminalTabKey(terminal.localId))}
                >
                  {viewSlots[terminalTabKey(terminal.localId)] !== undefined &&
                    viewSlots[terminalTabKey(terminal.localId)] !== "full" && (
                      <PaneUnsplitButton
                        onClick={() =>
                          openSurface(terminalTabKey(terminal.localId), "tab")
                        }
                      />
                    )}
                  <TerminalScreen
                    projectId={projectId}
                    active={terminal.localId === activeTerminalTabId}
                    attachSessionId={terminal.attachSessionId}
                    restoreSessionId={terminal.restoreSessionId}
                    readOnly={Boolean(terminal.agentControlled)}
                    onTitle={(title) =>
                      onTerminalTitle(terminal.localId, title)
                    }
                    onSession={(ptySessionId) =>
                      updateWorkspace((ws) => ({
                        ...ws,
                        terminals: ws.terminals.map((t) =>
                          t.localId === terminal.localId
                            ? { ...t, ptySessionId }
                            : t,
                        ),
                      }))
                    }
                    onExit={() => {
                      // Agent terminals stay open to read; the activity
                      // indicator stops. User terminals close as before.
                      if (terminal.attachSessionId) {
                        updateWorkspace((ws) => ({
                          ...ws,
                          terminals: ws.terminals.map((t) =>
                            t.localId === terminal.localId
                              ? { ...t, running: false }
                              : t,
                          ),
                        }));
                      } else {
                        closeTab(terminalTabKey(terminal.localId));
                      }
                    }}
                  />
                  <AgentControlOverlay
                    kind="terminal"
                    active={Boolean(terminal.agentControlled)}
                    onTakeOver={() =>
                      takeOverSurface(terminalTabKey(terminal.localId))
                    }
                    onGoToChat={
                      terminal.chatLocalId
                        ? () => revealChat(terminal.chatLocalId as string)
                        : undefined
                    }
                  />
                </div>
              ))}

              {workspace.editors.map((editor) => (
                <div
                  key={editor.localId}
                  className={paneClass(editorTabKey(editor.localId))}
                  style={paneStyle(editorTabKey(editor.localId))}
                  {...paneFocusProps(editorTabKey(editor.localId))}
                >
                  {viewSlots[editorTabKey(editor.localId)] !== undefined &&
                    viewSlots[editorTabKey(editor.localId)] !== "full" && (
                      <PaneUnsplitButton
                        onClick={() =>
                          openSurface(editorTabKey(editor.localId), "tab")
                        }
                      />
                    )}
                  <Suspense fallback={<div className="flex-1 bg-bg" />}>
                    <EditorScreen
                      projectId={projectId}
                      filePath={editor.filePath}
                      onFileChange={(filePath) =>
                        onEditorState(editor.localId, { filePath })
                      }
                      onDirtyChange={(dirty) =>
                        onEditorState(editor.localId, { dirty })
                      }
                    />
                  </Suspense>
                </div>
              ))}
            </div>

            {/* Split divider: drag to resize. The full-region overlay
                  during a drag keeps webviews from swallowing the moves. */}
            {split && (
              // biome-ignore lint/a11y/noStaticElementInteractions: pointer-only resize handle; the split is keyboard-reachable via Cmd+\ and tab focus
              <div
                data-split-divider
                onMouseDown={startDividerDrag}
                className={`absolute inset-y-0 z-40 w-[7px] -translate-x-1/2 cursor-col-resize ${
                  dividerDragging
                    ? ""
                    : "transition-[left] duration-200 ease-[cubic-bezier(0.2,0,0,1)]"
                }`}
                style={{ left: `${splitRatio * 100}%` }}
              >
                <div className="mx-auto h-full w-px bg-transparent transition-colors duration-150 hover:bg-accent/60" />
              </div>
            )}
            {dividerDragging && (
              <div className="absolute inset-0 z-50 cursor-col-resize" />
            )}

            {/* Dragging a tab: side drop zones tile it left or right. While
                a chat is in front, the bottom band stays clear of the zones
                so the tab can be dropped on the chat's composer instead
                (it becomes a tab pill there). */}
            {tabDragKey && (
              <div
                className={`absolute inset-x-0 top-0 z-50 flex ${
                  workspace.chats.some(
                    (entry) =>
                      entry.mode === "partial" ||
                      Boolean(viewSlots[chatTabKey(entry.localId)]),
                  )
                    ? "bottom-40"
                    : "bottom-0"
                }`}
              >
                {(["left", "right"] as const).map((side) => (
                  // biome-ignore lint/a11y/noStaticElementInteractions: drop target for an in-progress HTML5 drag only
                  <div
                    key={side}
                    onDragOver={(event) => {
                      event.preventDefault();
                      setDropSideHover(side);
                    }}
                    onDragLeave={() =>
                      setDropSideHover((current) =>
                        current === side ? null : current,
                      )
                    }
                    onDrop={(event) => {
                      event.preventDefault();
                      dropTabToSide(tabDragKey, side);
                      setTabDragKey(null);
                      setDropSideHover(null);
                    }}
                    className={`flex-1 border-2 border-dashed transition-colors duration-150 ${
                      dropSideHover === side
                        ? "border-accent/60 bg-accent/10"
                        : "border-transparent"
                    }`}
                  />
                ))}
              </div>
            )}

            {workspace.chats.map((entry) => (
              <ChatDock
                key={entry.localId}
                projectId={projectId}
                entry={entry}
                title={chatLabels[entry.localId] ?? "AI assistant"}
                tabActive={Boolean(viewSlots[chatTabKey(entry.localId)])}
                refreshWhileIdle={
                  entry.localId === workspace.activeChatId &&
                  chatVisible(workspace, entry)
                }
                slot={viewSlots[chatTabKey(entry.localId)] ?? "full"}
                splitRatio={splitRatio}
                splitResizing={dividerDragging}
                bubbleClearance={bubblesCollapsed ? "corner" : "strip"}
                backdropTab={
                  workspace.activeTabKey !== undefined &&
                  workspace.activeTabKey !== chatTabKey(entry.localId)
                }
                defaultAgentId={effectiveDefaultAgentId ?? undefined}
                paletteTargeted={entry.localId === targetedChat?.localId}
                surfaces={surfacesFor(entry)}
                onOpenSurface={openSurface}
                onRemoveSurface={removeSurface}
                onOpenMcpApp={(view, mode) => {
                  const name = view.toolUseId;
                  openTab(
                    {
                      kind: "mcpapp",
                      name,
                      label: view.title,
                      toolKey: view.toolKey,
                      toolInput: view.toolInput,
                      toolResult: view.toolResult,
                    },
                    mode === "split" ? "side" : undefined,
                  );
                }}
                onLinkClick={(url, modifiers) => {
                  // The palette's grammar, applied to links: plain =
                  // open (the page takes the view, a fullscreen chat
                  // steps down to the floating dock), ⌘ = new tab (the
                  // chat keeps its place), ⌘⇧ = open to the side.
                  if (modifiers.metaKey && modifiers.shiftKey) {
                    openBrowserTab(url, {
                      side: true,
                      chatLocalId: entry.localId,
                    });
                    return;
                  }
                  if (modifiers.metaKey) {
                    openBrowserTab(url, { chatLocalId: entry.localId });
                    return;
                  }
                  openBrowserTab(url, { chatLocalId: entry.localId });
                  if (entry.mode === "tab") {
                    updateWorkspace((ws) => ({
                      ...ws,
                      activeChatId: entry.localId,
                      chats: ws.chats.map((chat) =>
                        chat.localId === entry.localId
                          ? { ...chat, mode: "partial" }
                          : chat.mode === "partial"
                            ? { ...chat, mode: "min" }
                            : chat,
                      ),
                    }));
                  }
                }}
                onFileClick={(path) => {
                  if (!projectId) {
                    openEditorTab({
                      filePath: path,
                      chatLocalId: entry.localId,
                    });
                    return;
                  }
                  void desktopApi.projectRoot(projectId).then((root) => {
                    if (!root) {
                      openEditorTab({
                        filePath: path,
                        chatLocalId: entry.localId,
                      });
                      return;
                    }
                    const location = resolveProjectFileLocation(root, path);
                    if (isPdfPath(location.relativePath)) {
                      openBrowserTab(localFileUrl(location.absolutePath), {
                        chatLocalId: entry.localId,
                        title: fileNameFromPath(location.relativePath),
                      });
                      return;
                    }
                    openEditorTab({
                      filePath: location.relativePath,
                      chatLocalId: entry.localId,
                    });
                  });
                }}
                onFork={(messageId) => forkChat(entry, messageId)}
                onOpenParent={
                  chatForks[entry.localId]
                    ? () => openParentChat(entry)
                    : undefined
                }
                pullSelectionNonce={selectionPulls[entry.localId] ?? 0}
                onFocusRequest={
                  split &&
                  viewSlots[chatTabKey(entry.localId)] &&
                  workspace.activeTabKey !== chatTabKey(entry.localId)
                    ? () => selectTab(chatTabKey(entry.localId))
                    : undefined
                }
                onUnsplit={
                  viewSlots[chatTabKey(entry.localId)] &&
                  viewSlots[chatTabKey(entry.localId)] !== "full"
                    ? () => openSurface(chatTabKey(entry.localId), "tab")
                    : undefined
                }
                onEntryChange={(next) =>
                  updateWorkspace((ws) => ({
                    ...ws,
                    activeChatId: next.localId,
                    activeTabKey:
                      next.mode === "tab"
                        ? chatTabKey(next.localId)
                        : ws.activeTabKey === chatTabKey(next.localId)
                          ? nextActiveTabKey(
                              ws,
                              chatTabKey(next.localId),
                              ws.chats.map((chat) =>
                                chat.localId === next.localId ? next : chat,
                              ),
                            )
                          : ws.activeTabKey,
                    chats: ws.chats.map((chat) =>
                      chat.localId === next.localId ? next : chat,
                    ),
                  }))
                }
                onClose={closeChat}
                registerClose={(close) =>
                  chatClosersRef.current.set(entry.localId, close)
                }
                registerMinimize={(minimize) =>
                  chatMinimizersRef.current.set(entry.localId, minimize)
                }
                registerSend={(send) =>
                  chatSendersRef.current.set(entry.localId, send)
                }
                onSessionCreated={onSessionCreated}
                onSignalsChange={onSignalsChange}
              />
            ))}

            <ChatBubbles
              entries={workspace.chats}
              labels={chatLabels}
              icons={chatIcons}
              forks={chatForks}
              signals={signalsByChat}
              unread={unreadByChat}
              activeLocalId={workspace.activeChatId}
              autoCollapse={activeChatTabId !== undefined}
              onCollapsedChange={setBubblesCollapsed}
              onToggle={toggleChat}
              onClose={closeChat}
              onNewChat={() => addChat()}
              onCollapse={minimizeFloatingChats}
            />
          </div>
        ) : (
          <EmptyState
            loading={projectsQuery.isLoading}
            onNewProject={() => setProjectModalOpen(true)}
            onConnectRemote={() => setRemoteConnect({ open: true, link: null })}
            onStartWithAgent={startWithAgent}
          />
        )}
      </main>

      {/* Stays mounted so the close transition can play out. */}
      {paletteProps && (
        <CommandPalette
          incognitoAllowed={incognitoAllowed}
          variant="overlay"
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          pickerRequest={pickerRequest}
          {...paletteProps}
        />
      )}

      {/* The wizard modal: same experience as the setup tab, reachable from
          chat gating, Settings, and the palette command. */}
      <AgentWizard
        variant="modal"
        open={wizardModalOpen}
        onClose={() => setWizardModalOpen(false)}
        onDone={() => setWizardModalOpen(false)}
      />

      {/* Configure-agent modal (ADR 0056): palette picker + Settings both
          land here; project agents get the read-only definition view. */}
      <ConfigureAgentModal
        open={configureAgentOpen}
        agentId={configureAgentId}
        projectId={projectId}
        onClose={() => setConfigureAgentOpen(false)}
      />

      {/* Connectors manager: reachable from the palette and Settings. */}
      <ConnectorsModal
        open={connectorsModalOpen}
        onClose={() => {
          setConnectorsModalOpen(false);
          void finalizeConnectorRequest();
        }}
        // OAuth: the modal steps aside so the consent tab is visible, then
        // comes back once the callback landed. Stepping aside is not the
        // user closing it — an agent's request stays pending until then.
        onStepAside={() => setConnectorsModalOpen(false)}
        onReturn={() => setConnectorsModalOpen(true)}
        onOpenUrl={(url) => openBrowserTab(url)}
        agentRequest={
          connectorRequest
            ? {
                query: connectorRequest.query,
                ...(connectorRequest.reason
                  ? { reason: connectorRequest.reason }
                  : {}),
              }
            : null
        }
      />

      {/* Boot veil: covers the workspace until its first real paint is
          ready, then fades — launch shows one composed frame, not pieces
          popping in. */}
      {!bootVeilGone && (
        <div
          className={`fixed inset-0 z-[400] bg-bg transition-opacity duration-250 ease-[cubic-bezier(0.2,0,0,1)] ${
            bootRevealed ? "pointer-events-none opacity-0" : "opacity-100"
          }`}
          onTransitionEnd={() => {
            if (bootRevealed) setBootVeilGone(true);
          }}
        />
      )}

      {/* In-place profile switch veil: opaque at the midpoint, so the
          workspace swap beneath it is never visible. */}
      {profileVeil && (
        <div
          className={`fixed inset-0 z-[300] bg-bg ${
            profileVeil.stage === "in"
              ? "animate-profile-veil-in"
              : "animate-profile-veil-out"
          }`}
          onAnimationEnd={() => {
            if (profileVeil.stage === "in" && profileVeil.target) {
              void completeProfileSwitch(profileVeil.target);
            } else if (profileVeil.stage === "out") {
              setProfileVeil(null);
            }
          }}
        />
      )}

      <ProjectModal
        open={projectModalOpen}
        onClose={() => setProjectModalOpen(false)}
        onCreated={(project) => {
          setProjectModalOpen(false);
          // New projects belong to the profile they were created in.
          if (activeProfile) {
            void desktopApi.profilesClaimProject(activeProfile.id, project.id);
          }
          selectProject(project.id);
        }}
      />
      <DeleteProjectModal
        project={deletingProject}
        onClose={() => setDeletingProject(null)}
        onDeleted={onProjectDeleted}
      />
      <RemoteConnectModal
        open={remoteConnect.open}
        link={remoteConnect.link}
        onClose={() => setRemoteConnect({ open: false, link: null })}
        onConnected={(project) => {
          setRemoteConnect({ open: false, link: null });
          if (activeProfile) {
            void desktopApi.profilesClaimProject(activeProfile.id, project.id);
          }
          selectProject(project.id);
        }}
      />
      {projectId && (
        <>
          <RemoteHistoryModal
            projectId={projectId}
            path={remoteHistoryPath}
            onClose={() => setRemoteHistoryPath(null)}
          />
          <RemotePublishModal
            projectId={projectId}
            path={remotePublish?.path ?? null}
            features={remotePublish?.features}
            onClose={() => setRemotePublish(null)}
          />
          <RemoteProposeModal
            projectId={projectId}
            open={remotePropose !== null}
            files={remotePropose?.files ?? []}
            features={remotePropose?.features}
            onClose={() => setRemotePropose(null)}
          />
        </>
      )}
    </div>
  );
}

/** One sidebar section, shaped by the user's sidebar.js config. */
function ConfiguredSection({
  section,
  projectId,
  profileId,
  activeTab,
  activeChatSessionId,
  keybindingLabel,
  agentsData,
  defaultAgentId,
  projectAgentNames,
  onOpenTab,
  onNewChat,
  onOpenSession,
  onOpenUrl,
  onOpenFile,
  onOpenHistory,
  onPublish,
  onPropose,
}: {
  section: SidebarSectionConfig;
  projectId: string;
  profileId?: string;
  activeTab?: WorkspaceTab;
  activeChatSessionId?: string;
  keybindingLabel: string;
  agentsData: AgentsData | null;
  defaultAgentId: string | null;
  projectAgentNames: Record<string, string>;
  onOpenTab: (tab: WorkspaceTab) => void;
  onNewChat: () => void;
  onOpenSession: (session: AgentSession) => void;
  onOpenUrl: (url: string, mode: "tab" | "replace") => void;
  onOpenFile: (filePath: string) => void;
  onOpenHistory: (filePath: string) => void;
  onPublish: (filePath: string, features: RemoteFeatures | undefined) => void;
  onPropose: (files: string[], features: RemoteFeatures | undefined) => void;
}) {
  const defaultOpen = !section.collapsed;
  // Hide-when-empty: a section with nothing to list can drop its header
  // entirely. Workflows and Apps default to hidden-until-non-empty (a new
  // project isn't about either until an agent makes it so); any section
  // opts in or out with `hideEmpty` in sidebar.js. The nav stays mounted
  // (hidden, not unmounted) so its data fetch is what reveals the section.
  const hideEmpty =
    section.hideEmpty ??
    (section.type === "workflows" ||
      section.type === "apps" ||
      section.type === "remote");
  const [empty, setEmpty] = useState(true);
  const body = (() => {
    switch (section.type) {
      case "workflows":
        return (
          <SidebarSection
            title={section.title ?? "Workflows"}
            defaultOpen={defaultOpen}
          >
            <WorkflowsNav
              projectId={projectId}
              active={
                activeTab?.kind === "workflow" ? activeTab.name : undefined
              }
              onEmptyChange={setEmpty}
              onSelect={(workflow) =>
                onOpenTab({
                  kind: "workflow",
                  name: workflow.name,
                  label: workflow.displayName ?? workflow.name,
                })
              }
            />
          </SidebarSection>
        );
      case "apps":
        return (
          <SidebarSection
            title={section.title ?? "Apps"}
            defaultOpen={defaultOpen}
          >
            <AppsNav
              projectId={projectId}
              active={activeTab?.kind === "app" ? activeTab.name : undefined}
              onEmptyChange={setEmpty}
              onSelect={(appName) => onOpenTab({ kind: "app", name: appName })}
            />
          </SidebarSection>
        );
      case "chats":
        return (
          <SidebarSection
            title={section.title ?? "Chats"}
            defaultOpen={defaultOpen}
            action={
              <ShortcutHint label="New chat" shortcut={keybindingLabel}>
                <button
                  type="button"
                  onClick={onNewChat}
                  className="grid size-6 cursor-pointer place-items-center rounded text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                  aria-label="New chat"
                >
                  <Plus className="size-3.5" />
                </button>
              </ShortcutHint>
            }
          >
            <SessionsNav
              projectId={projectId}
              activeSessionId={activeChatSessionId}
              agentsData={agentsData}
              defaultAgentId={defaultAgentId}
              projectAgentNames={projectAgentNames}
              onEmptyChange={setEmpty}
              onSelect={onOpenSession}
            />
          </SidebarSection>
        );
      case "bookmarks":
        if (!profileId) return null;
        return (
          <SidebarSection
            title={section.title ?? "Bookmarks"}
            defaultOpen={defaultOpen}
          >
            <BookmarksNav
              projectId={projectId}
              profileId={profileId}
              menuOverride={section.menu}
              onEmptyChange={setEmpty}
              onOpen={(url, mode) =>
                onOpenUrl(url, mode ?? section.open ?? "replace")
              }
            />
          </SidebarSection>
        );
      case "git":
        return (
          <SidebarSection
            title={section.title ?? "Changes"}
            defaultOpen={defaultOpen}
          >
            <GitNav
              projectId={projectId}
              onOpenDiff={onOpenTab}
              onEmptyChange={setEmpty}
            />
          </SidebarSection>
        );
      case "prs":
        return (
          <SidebarSection
            title={section.title ?? "Pull Requests"}
            defaultOpen={defaultOpen}
          >
            <PrsNav
              projectId={projectId}
              onOpenDiff={onOpenTab}
              onOpenUrl={onOpenUrl}
              onEmptyChange={setEmpty}
            />
          </SidebarSection>
        );
      case "remote":
        return (
          <SidebarSection
            title={section.title ?? "Server"}
            defaultOpen={defaultOpen}
          >
            <RemoteNav
              projectId={projectId}
              onEmptyChange={setEmpty}
              onOpenFile={onOpenFile}
              onOpenHistory={onOpenHistory}
              onPublish={onPublish}
              onPropose={onPropose}
            />
          </SidebarSection>
        );
      case "custom":
        return (
          <SidebarSection
            title={section.title ?? "Links"}
            defaultOpen={defaultOpen}
          >
            <CustomItems
              section={section}
              onOpenUrl={onOpenUrl}
              onEmptyChange={setEmpty}
            />
          </SidebarSection>
        );
      default:
        return null;
    }
  })();
  if (!body) return null;
  if (!hideEmpty) return body;
  return <div className={empty ? "hidden" : undefined}>{body}</div>;
}

/**
 * A user-defined section's items. Same row component as bookmarks, so a
 * config-authored item gets the identical ⋯ menu behavior; only the
 * bookmark-specific actions (pin/rename/remove) are inert here.
 */
function CustomItems({
  section,
  onOpenUrl,
  onEmptyChange,
}: {
  section: SidebarSectionConfig;
  onOpenUrl: (url: string, mode: "tab" | "replace") => void;
  onEmptyChange?: (empty: boolean) => void;
}) {
  const items = section.items ?? [];
  const isEmpty = items.length === 0;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);
  if (items.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">
        No items yet. Add some in sidebar.js.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {items.map((item) => {
        const mode = item.open ?? section.open ?? "replace";
        return (
          <li key={`${item.label}:${item.url}`}>
            <SidebarItemRow
              label={item.label}
              title={item.url}
              icon={item.icon ?? "Globe"}
              menu={item.menu ?? section.menu ?? DEFAULT_CUSTOM_MENU}
              preview={item.preview}
              onOpen={() => onOpenUrl(item.url, mode)}
              onAction={(entry) => {
                switch (entry.action) {
                  case "open":
                    onOpenUrl(item.url, mode);
                    break;
                  case "open-tab":
                    onOpenUrl(item.url, "tab");
                    break;
                  case "open-here":
                    onOpenUrl(item.url, "replace");
                    break;
                  case "copy-url":
                    void navigator.clipboard.writeText(item.url);
                    break;
                  // pin/unpin/rename/remove are bookmark-only; a config
                  // may list them, but there's nothing to act on here.
                  default:
                    break;
                }
              }}
            />
          </li>
        );
      })}
    </ul>
  );
}

function SidebarSection({
  title,
  defaultOpen = false,
  action,
  children,
}: {
  title: string;
  defaultOpen?: boolean;
  action?: ReactNode;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <section className="pb-2">
      <div className="flex items-center">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex h-7 min-w-0 flex-1 cursor-pointer items-center gap-1 rounded-md px-2 text-[11px] font-semibold uppercase tracking-wider text-fg-faint transition-colors duration-150 hover:text-fg-muted"
          aria-expanded={open}
        >
          <ChevronRight
            className={`size-3 transition-transform duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
              open ? "rotate-90" : ""
            }`}
          />
          {title}
        </button>
        {action}
      </div>
      <div
        className={`grid transition-[grid-template-rows] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          open ? "grid-rows-[1fr]" : "grid-rows-[0fr]"
        }`}
      >
        <div className="overflow-hidden">{children}</div>
      </div>
    </section>
  );
}

function WorkflowsNav({
  projectId,
  active,
  onEmptyChange,
  onSelect,
}: {
  projectId: string;
  active?: string;
  /** Reports emptiness up so hide-when-empty sections can drop entirely. */
  onEmptyChange?: (empty: boolean) => void;
  onSelect: (workflow: { name: string; displayName?: string }) => void;
}) {
  const workflowsQuery = useWorkflows(projectId);
  const workflows = workflowsQuery.data ?? [];
  const isEmpty = workflows.length === 0;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);
  if (workflows.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">
        Ask the agent to create one.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {workflows.map((workflow) => (
        <li key={workflow.name}>
          <button
            type="button"
            onClick={() =>
              onSelect({
                name: workflow.name,
                displayName: workflow.displayName ?? undefined,
              })
            }
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
              workflow.name === active
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
          >
            <WorkflowIcon className="size-3.5 shrink-0" />
            <span className="truncate">
              {workflow.displayName ?? workflow.name}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function AppsNav({
  projectId,
  active,
  onEmptyChange,
  onSelect,
}: {
  projectId: string;
  active?: string;
  onEmptyChange?: (empty: boolean) => void;
  onSelect: (appName: string) => void;
}) {
  const appsQuery = useApps(projectId);
  const apps = appsQuery.data ?? [];
  const isEmpty = apps.length === 0;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);
  if (apps.length === 0) {
    return (
      <p className="px-2 py-1 text-xs text-fg-faint">
        Ask the agent to build one.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {apps.map((app) => (
        <li key={app.name} data-point-key={`app:${app.name}`}>
          <button
            type="button"
            onClick={() => onSelect(app.name)}
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${
              app.name === active
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
          >
            <LayoutGrid className="size-3.5 shrink-0" />
            <span className="truncate">{app.name}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function SessionsNav({
  projectId,
  activeSessionId,
  agentsData,
  defaultAgentId,
  projectAgentNames,
  onEmptyChange,
  onSelect,
}: {
  projectId: string;
  activeSessionId?: string;
  agentsData: AgentsData | null;
  defaultAgentId: string | null;
  projectAgentNames: Record<string, string>;
  onEmptyChange?: (empty: boolean) => void;
  onSelect: (session: AgentSession) => void;
}) {
  const sessionsQuery = useAgentSessions(projectId);
  const sessions = sessionsQuery.data?.items ?? [];
  const [checkouts, setCheckouts] = useState<SessionCheckoutInfo[]>([]);
  useEffect(() => {
    const load = () => {
      void desktopApi.sessionCheckouts(projectId).then(setCheckouts);
    };
    load();
    return desktopApi.onGitChanged((event) => {
      if (event.projectId === projectId) load();
    });
  }, [projectId]);
  const checkoutBySession = new Map(
    checkouts.map((checkout) => [checkout.sessionId, checkout]),
  );
  const isEmpty = sessions.length === 0;
  useEffect(() => {
    onEmptyChange?.(isEmpty);
  }, [isEmpty, onEmptyChange]);
  if (sessions.length === 0) {
    return <p className="px-2 py-1 text-xs text-fg-faint">No chats yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {sessions.map((session) => {
        const checkout = checkoutBySession.get(session.id);
        const agentId = session.agentId ?? defaultAgentId;
        const agentName =
          agentsData?.agents.find((agent) => agent.id === agentId)?.name ??
          (agentId ? projectAgentNames[agentId] : undefined) ??
          "Default";
        const checkoutLabel = checkout
          ? checkout.kind === "external"
            ? "External"
            : (checkout.branch ?? "Worktree")
          : undefined;
        return (
          <li key={session.id}>
            <SidebarItemRow
              label={sessionLabel(session)}
              icon={
                <ChatGlyph
                  icon={session.icon}
                  fork={Boolean(session.parentSessionId)}
                  className="size-3.5 shrink-0"
                />
              }
              active={session.id === activeSessionId}
              labelContent={<AnimatedTitle text={sessionLabel(session)} />}
              preview={{
                title: sessionLabel(session),
                description: session.activity ?? undefined,
                metadata: [
                  { label: "Agent", value: agentName },
                  {
                    label: "Environment",
                    value: session.environment ?? "Default",
                  },
                  {
                    label: "Status",
                    value: session.running
                      ? "Working"
                      : session.status === "closed"
                        ? "Closed"
                        : "Ready",
                  },
                  ...(checkoutLabel
                    ? [{ label: "Checkout", value: checkoutLabel }]
                    : []),
                ],
              }}
              end={
                checkoutLabel ? (
                  <span className="ml-auto flex max-w-28 shrink-0 items-center gap-1 truncate rounded bg-bg-inset px-1.5 py-0.5 text-[10px] text-fg-faint">
                    <GitBranch className="size-2.5 shrink-0" />
                    <span className="truncate">{checkoutLabel}</span>
                  </span>
                ) : null
              }
              onOpen={() => onSelect(session)}
              onAction={() => {}}
            />
          </li>
        );
      })}
    </ul>
  );
}

function sessionLabel(session: AgentSession): string {
  if (session.title) return session.title;
  const created = new Date(session.createdAt);
  return `Chat ${created.toLocaleDateString()} ${created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}

function EmptyState({
  loading,
  onNewProject,
  onConnectRemote,
  onStartWithAgent,
}: {
  loading: boolean;
  onNewProject: () => void;
  onConnectRemote: () => void;
  onStartWithAgent: () => Promise<void>;
}) {
  const [startingAgent, setStartingAgent] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const start = async () => {
    if (startingAgent) return;
    setStartingAgent(true);
    setError(null);
    try {
      await onStartWithAgent();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setStartingAgent(false);
    }
  };

  return (
    <div className="grid flex-1 place-items-center">
      <div className="max-w-sm text-center">
        {loading ? (
          <p className="animate-pulse text-sm text-fg-muted">Loading…</p>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Start with an agent, create a project, or connect to a server.
            </p>
            <div className="mt-4 flex flex-wrap items-center justify-center gap-2">
              <PendingButton
                type="button"
                pending={startingAgent}
                pendingLabel="Starting…"
                onClick={() => void start()}
                data-testid="empty-start-agent"
                className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                <span className="inline-flex items-center gap-2">
                  <Sparkles className="size-3.5" />
                  Start with an agent
                </span>
              </PendingButton>
              <button
                type="button"
                onClick={onNewProject}
                disabled={startingAgent}
                className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
              >
                <FolderPlus className="size-3.5" />
                New project
              </button>
              <button
                type="button"
                onClick={onConnectRemote}
                disabled={startingAgent}
                data-testid="empty-connect-remote"
                className="inline-flex h-8 cursor-pointer items-center gap-2 rounded-md border border-border px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg disabled:cursor-not-allowed disabled:opacity-60"
              >
                <Link2 className="size-3.5" />
                Connect to a server
              </button>
            </div>
            {error && <p className="mt-3 text-[12px] text-danger">{error}</p>}
          </>
        )}
      </div>
    </div>
  );
}
