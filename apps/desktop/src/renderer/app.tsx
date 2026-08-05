import {
  useAgentSessions,
  useProjects,
  useUpdateAgentSession,
  useWorkflows,
} from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import {
  ChevronRight,
  Columns2,
  FolderPlus,
  LayoutGrid,
  PanelLeft,
  Plus,
  Settings as SettingsIcon,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { type ActionId, KEYBINDING_ACTIONS } from "../shared/actions.js";
import { AgentWizard } from "./components/agent-wizard.js";
import { AnimatedTitle } from "./components/animated-title.js";
import { BookmarksNav } from "./components/bookmarks-nav.js";
import { ChatBubbles } from "./components/chat-bubbles.js";
import {
  ChatDock,
  type ChatDockEntry,
  type ChatSurface,
} from "./components/chat-dock.js";
import { CommandPalette } from "./components/command-palette.js";
import { DeleteProjectModal } from "./components/delete-project-modal.js";
import { ProfileBar } from "./components/profile-bar.js";
import { ProjectModal } from "./components/project-modal.js";
import { ProjectSwitcher } from "./components/project-switcher.js";
import { ShortcutHint } from "./components/shortcut-hint.js";
import { SidebarItemRow } from "./components/sidebar-item-row.js";
import {
  tabKey,
  type WorkspaceTab,
  WorkspaceTabBar,
} from "./components/workspace-tabs.js";
import {
  type AgentEffort,
  type AgentsData,
  desktopApi,
  type Profile,
  type ProfilesData,
  type SidebarConfig,
  type SidebarMenuEntry,
  type SidebarSectionConfig,
} from "./lib/desktop-api.js";
import {
  formatBinding,
  matchesBinding,
  useKeybindings,
} from "./lib/keybindings.js";
import { AppScreen, useApps } from "./screens/app-screen.js";
import {
  type BrowserPageState,
  BrowserScreen,
} from "./screens/browser-screen.js";
import { EditorScreen } from "./screens/editor-screen.js";
import { SettingsScreen } from "./screens/settings-screen.js";
import { TerminalScreen } from "./screens/terminal-screen.js";
import { WorkflowScreen } from "./screens/workflow-screen.js";

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
}

interface TerminalEntry {
  localId: string;
  /** Shell title (OSC 0/2) — feeds the tab label. */
  title: string;
  /** Chat this tab is attached to (its surfaces rail), if any. */
  chatLocalId?: string;
}

interface EditorEntry {
  localId: string;
  /** Open file (project-relative), or null while the picker shows. */
  filePath: string | null;
  /** Unsaved draft in the tab — a dot on the tab icon. */
  dirty: boolean;
  /** Chat this tab is attached to (its surfaces rail), if any. */
  chatLocalId?: string;
}

/** Two tabs tiled side by side; the focused one is `activeTabKey`. */
interface SplitView {
  leftKey: string;
  rightKey: string;
  /** Left pane's fraction of the width (drag the divider to change). */
  ratio: number;
}

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
}

const newChatEntry = (mode: ChatDockEntry["mode"]): ChatDockEntry => ({
  localId: crypto.randomUUID(),
  mode,
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
  };
};

const chatTabKey = (localId: string) => `chat:${localId}`;
const browserTabKey = (localId: string) => `browser:${localId}`;
const terminalTabKey = (localId: string) => `terminal:${localId}`;
const editorTabKey = (localId: string) => `editor:${localId}`;

/** Offered to config-defined items that don't declare their own menu. */
const DEFAULT_CUSTOM_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
];

const truncateLabel = (value: string): string =>
  value.length <= 40 ? value : `${value.slice(0, 39)}…`;

/** Floating "return to full width" control on non-browser split panes. */
function PaneUnsplitButton({ onClick }: { onClick: () => void }) {
  return (
    <span className="absolute right-2 top-2 z-10">
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

export function App() {
  const projectsQuery = useProjects();
  const [activeProjectId, setActiveProjectId] = useState<string>();
  const [workspaces, setWorkspaces] = useState<Record<string, Workspace>>({});
  const [projectModalOpen, setProjectModalOpen] = useState(false);
  const [deletingProject, setDeletingProject] = useState<ProjectSummary | null>(
    null,
  );
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [sendingByChat, setSendingByChat] = useState<Record<string, boolean>>(
    {},
  );
  const [unreadByChat, setUnreadByChat] = useState<Record<string, boolean>>({});
  const [bubblesCollapsed, setBubblesCollapsed] = useState(false);

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

  // User-customizable sidebar layout (sidebar.js, file-watched).
  const [sidebarConfig, setSidebarConfig] = useState<SidebarConfig | null>(
    null,
  );
  useEffect(() => {
    void desktopApi.sidebarConfigGet().then(setSidebarConfig);
    return desktopApi.onSidebarConfigChanged(setSidebarConfig);
  }, []);

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
    projects.find(
      (project) => project.id === activeProfile?.defaultProjectId,
    ) ??
    projects[0];
  const projectId = activeProject?.id;

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
      const [sidebar, agents] = await Promise.all([
        desktopApi.sidebarConfigGet(),
        desktopApi.agentsList(),
      ]);
      setSidebarConfig(sidebar);
      setAgentsData(agents);
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

  const openTab = (tab: WorkspaceTab) =>
    updateWorkspace((ws) => {
      const key = tabKey(tab);
      const exists = ws.tabs.some((existing) => tabKey(existing) === key);
      return {
        ...ws,
        tabs: exists ? ws.tabs : [...ws.tabs, tab],
        activeTabKey: key,
      };
    });

  // Chrome's New Tab analog: a fresh tab whose content is the palette.
  const openPaletteTab = () =>
    openTab({ kind: "palette", name: crypto.randomUUID(), label: "New Tab" });

  /** Tab bar entries: fixed tabs plus one derived tab per tab-mode chat. */
  const chatTabs = (ws: Workspace, chatLabels: Record<string, string>) =>
    ws.chats
      .filter((chat) => chat.mode === "tab")
      .map(
        (chat): WorkspaceTab => ({
          kind: "chat",
          name: chat.localId,
          label: chatLabels[chat.localId] ?? "Chat",
          // Same signals as the chat's bubble: spinner while the agent
          // works, dot for a reply that landed while the tab was hidden.
          sending: sendingByChat[chat.localId] ?? false,
          unread: unreadByChat[chat.localId] ?? false,
        }),
      );

  const browserTabs = (ws: Workspace) =>
    ws.browsers.map(
      (browser): WorkspaceTab => ({
        kind: "browser",
        name: browser.localId,
        label: browser.title || "New Tab",
        faviconUrl: browser.faviconUrl,
      }),
    );

  const terminalTabs = (ws: Workspace) =>
    ws.terminals.map(
      (terminal): WorkspaceTab => ({
        kind: "terminal",
        name: terminal.localId,
        label: terminal.title || "Terminal",
      }),
    );

  const editorTabs = (ws: Workspace) =>
    ws.editors.map(
      (editor): WorkspaceTab => ({
        kind: "editor",
        name: editor.localId,
        label: editor.filePath?.split("/").at(-1) || "Editor",
        // Unsaved draft rides the same dot as an unread chat reply.
        unread: editor.dirty,
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
      opts?: { background?: boolean; chatLocalId?: string; side?: boolean },
    ) => {
      if (!activeProfile) return;
      const entry: BrowserEntry = {
        localId: crypto.randomUUID(),
        profileId: activeProfile.id,
        initialUrl: url,
        url,
        title: url || "New Tab",
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
  const openTerminalTab = (opts?: { chatLocalId?: string }) => {
    const entry: TerminalEntry = {
      localId: crypto.randomUUID(),
      title: "",
      chatLocalId: opts?.chatLocalId,
    };
    updateWorkspace((ws) => ({
      ...ws,
      terminals: [...ws.terminals, entry],
      activeTabKey: terminalTabKey(entry.localId),
      split: null,
    }));
  };

  /** Open an editor tab; without a file it greets with the quick-open. */
  const openEditorTab = (opts?: {
    filePath?: string;
    chatLocalId?: string;
  }) => {
    const entry: EditorEntry = {
      localId: crypto.randomUUID(),
      filePath: opts?.filePath ?? null,
      dirty: false,
      chatLocalId: opts?.chatLocalId,
    };
    updateWorkspace((ws) => ({
      ...ws,
      editors: [...ws.editors, entry],
      activeTabKey: editorTabKey(entry.localId),
      split: null,
    }));
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

  const closeTab = (key: string) =>
    updateWorkspace((ws) => {
      if (key.startsWith("browser:")) {
        const localId = key.slice("browser:".length);
        browserNavigatorsRef.current.delete(localId);
        const browsers = ws.browsers.filter(
          (browser) => browser.localId !== localId,
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
      // Closing a terminal tab kills its shell (the screen's unmount
      // cleanup sends the PTY kill).
      if (key.startsWith("terminal:")) {
        const localId = key.slice("terminal:".length);
        const terminals = ws.terminals.filter(
          (terminal) => terminal.localId !== localId,
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
      // Closing an editor tab drops its unsaved drafts.
      if (key.startsWith("editor:")) {
        const localId = key.slice("editor:".length);
        const editors = ws.editors.filter(
          (editor) => editor.localId !== localId,
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
      // Closing a chat tab closes the chat (the session stays in the
      // sidebar); it does NOT linger as a bubble.
      if (key.startsWith("chat:")) {
        const localId = key.slice("chat:".length);
        const chats = ws.chats.filter((chat) => chat.localId !== localId);
        return {
          ...ws,
          chats,
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
      const tabs = ws.tabs.filter((tab) => tabKey(tab) !== key);
      return {
        ...ws,
        tabs,
        activeTabKey:
          ws.activeTabKey === key
            ? nextActiveTabKey({ ...ws, tabs }, key, ws.chats)
            : ws.activeTabKey,
      };
    });

  const nextActiveTabKey = (
    ws: Workspace,
    closedKey: string,
    chats: ChatDockEntry[],
  ): string | undefined => {
    const keys = [
      ...ws.tabs.map(tabKey),
      ...ws.browsers.map((browser) => browserTabKey(browser.localId)),
      ...ws.terminals.map((terminal) => terminalTabKey(terminal.localId)),
      ...ws.editors.map((editor) => editorTabKey(editor.localId)),
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

  const closeChat = (localId: string) => {
    chatClosersRef.current.delete(localId);
    updateWorkspace((ws) => {
      const chats = ws.chats.filter((chat) => chat.localId !== localId);
      return {
        ...ws,
        chats,
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
  const addChat = (forceMode?: "tab") => {
    if (!requireAgents()) return;
    updateWorkspace((ws) => {
      // Already looking at a fresh chat (no session yet)? Don't stack
      // another empty one on top — Cmd+N/+ is a no-op there.
      const active = ws.chats.find((chat) => chat.localId === ws.activeChatId);
      const activeIsVisible =
        active?.mode === "partial" ||
        (active?.mode === "tab" &&
          ws.activeTabKey === chatTabKey(active.localId));
      if (activeIsVisible && !active.sessionId && !active.pendingMessage) {
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
      const entry = newChatEntry(forceMode ?? (noTabsOpen ? "tab" : "partial"));
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

  // A chat's surface is on screen: the floating dock, or its focused tab.
  const chatVisible = (ws: Workspace, chat: ChatDockEntry) =>
    chat.mode === "partial" ||
    (chat.mode === "tab" && ws.activeTabKey === chatTabKey(chat.localId));

  const sendingRef = useRef<Record<string, boolean>>({});
  const onSendingChange = useCallback((localId: string, sending: boolean) => {
    const wasSending = sendingRef.current[localId];
    if (wasSending === sending) return;
    sendingRef.current = { ...sendingRef.current, [localId]: sending };
    setSendingByChat(sendingRef.current);
    // Response landed while the chat was hidden (minimized bubble or a
    // background tab) → unread dot.
    const ws = workspaceRef.current;
    const chat = ws.chats.find((candidate) => candidate.localId === localId);
    if (!sending && wasSending && chat && !chatVisible(ws, chat)) {
      setUnreadByChat((unread) => ({ ...unread, [localId]: true }));
    }
  }, []);

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
  const closeActiveSurface = useCallback(() => {
    const ws = workspaceRef.current;
    const floating = ws.chats.find((chat) => chat.mode === "partial");
    if (floating) {
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

  const updateSession = useUpdateAgentSession(projectId);

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
    kind: "default-agent" | "switch-agent" | "effort" | "model";
    nonce: string;
  } | null>(null);
  const openPalettePicker = (
    kind: "default-agent" | "switch-agent" | "effort" | "model",
  ) => {
    setPaletteOpen(true);
    setPickerRequest({ kind, nonce: crypto.randomUUID() });
  };

  const pickDefaultAgent = (agentId: string) => {
    void desktopApi.agentsSetDefault(agentId);
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

  const pickEffort = (effort: AgentEffort) => {
    const chat = workspaceRef.current.chats.find(
      (candidate) => candidate.localId === workspaceRef.current.activeChatId,
    );
    if (chat?.sessionId) {
      updateSession.mutate({ sessionId: chat.sessionId, effort });
      return;
    }
    // No focused session: the effort applies to the profile's default agent.
    const defaultAgentId = agentsData?.defaultAgentId;
    if (defaultAgentId) {
      void desktopApi.agentsUpdate(defaultAgentId, { effort });
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

  /** Tab keys attached to a chat, in per-kind order. */
  const attachedTabKeys = (ws: Workspace, chatLocalId: string) => [
    ...ws.browsers
      .filter((browser) => browser.chatLocalId === chatLocalId)
      .map((browser) => browserTabKey(browser.localId)),
    ...ws.terminals
      .filter((terminal) => terminal.chatLocalId === chatLocalId)
      .map((terminal) => terminalTabKey(terminal.localId)),
    ...ws.editors
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
      ...ws.browsers.map((browser) => browserTabKey(browser.localId)),
      ...ws.terminals.map((terminal) => terminalTabKey(terminal.localId)),
      ...ws.editors.map((editor) => editorTabKey(editor.localId)),
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
  const openSurface = (key: string, mode: "tab" | "split") => {
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
      const anchor =
        ws.activeTabKey && ws.activeTabKey !== key ? ws.activeTabKey : null;
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
    const chat = actionChat(workspaceRef.current);
    if (chat) toggleChat(chat.localId);
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

  const actionHandlers: Record<ActionId, () => void> = {
    "new-tab": openPaletteTab,
    "command-palette": () => setPaletteOpen((value) => !value),
    "new-floating-chat": () => addChat(),
    "toggle-chat-minimized": toggleChatMinimized,
    "chat-to-tab": expandChatToTab,
    "prev-chat": () => cycleChat(-1),
    "next-chat": () => cycleChat(1),
    "prev-tab": () => cycleTab(-1),
    "next-tab": () => cycleTab(1),
    "split-view": toggleSplit,
    "new-browser-tab": () => openBrowserTab(""),
    "new-terminal-tab": openTerminalTab,
    "new-editor-tab": openEditorTab,
    "toggle-sidebar": () => setSidebarOpen((value) => !value),
    "close-tab": closeActiveSurface,
    "setup-agent": () => setWizardModalOpen(true),
    "default-agent": () => openPalettePicker("default-agent"),
    "switch-agent": () => openPalettePicker("switch-agent"),
    "change-effort": () => openPalettePicker("effort"),
    "switch-model": () => openPalettePicker("model"),
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
      if (dispatchShortcut(event)) event.preventDefault();
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
  };

  const onProjectDeleted = (deletedId: string) => {
    setDeletingProject(null);
    setWorkspaces(({ [deletedId]: _removed, ...rest }) => rest);
    defaultWorkspacesRef.current.delete(deletedId);
    void desktopApi.profilesReleaseProject(deletedId);
    if (activeProjectId === deletedId) setActiveProjectId(undefined);
  };

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
  // Strip entries in visual order (drag-arranged + group-clustered), with
  // group membership stamped for the grouped styling.
  const tabByKey = new Map<string, WorkspaceTab>(
    [
      ...workspace.tabs,
      ...browserTabs(workspace),
      ...terminalTabs(workspace),
      ...editorTabs(workspace),
      ...chatTabs(workspace, chatLabels),
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
    return slot ? SLOT_CLASSES[slot] + paneGeometryTransition : "hidden";
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

  /** The agent's working tabs for a chat — its surfaces rail. */
  const surfacesFor = (chat: ChatDockEntry): ChatSurface[] => [
    ...workspace.browsers
      .filter((browser) => browser.chatLocalId === chat.localId)
      .map((browser) => ({
        key: browserTabKey(browser.localId),
        kind: "browser" as const,
        label: browser.title || browser.url || "Page",
        faviconUrl: browser.faviconUrl,
      })),
    ...workspace.terminals
      .filter((terminal) => terminal.chatLocalId === chat.localId)
      .map((terminal) => ({
        key: terminalTabKey(terminal.localId),
        kind: "terminal" as const,
        label: terminal.title || "Terminal",
      })),
    ...workspace.editors
      .filter((editor) => editor.chatLocalId === chat.localId)
      .map((editor) => ({
        key: editorTabKey(editor.localId),
        kind: "editor" as const,
        label: editor.filePath?.split("/").at(-1) || "Editor",
      })),
  ];

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
        actionHandlers,
        agents: agentsData?.agents ?? [],
        defaultAgentId: agentsData?.defaultAgentId ?? null,
        focusedChat: focusedChat
          ? {
              agentId: focusedSession?.agentId ?? focusedChat.agentId ?? null,
              effort: focusedSession?.modelEffort ?? null,
            }
          : null,
        onPickDefaultAgent: pickDefaultAgent,
        onPickSessionAgent: pickSessionAgent,
        onPickEffort: pickEffort,
        onPickModel: pickModel,
        onHighlightTarget: setPaletteTarget,
      }
    : null;

  return (
    <div className="flex h-full">
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
              onDeleteProject={setDeletingProject}
            />
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto px-2">
            {projectId &&
              (sidebarConfig?.sections ?? []).map((section, index) => (
                <ConfiguredSection
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
                  onOpenTab={openTab}
                  onNewChat={() => addChat()}
                  onOpenSession={openSession}
                  onOpenUrl={openUrl}
                />
              ))}
          </div>

          <footer className="border-t border-border p-2">
            {profilesData && activeProfile && (
              <ProfileBar
                data={profilesData}
                activeProfileId={activeProfile.id}
                onSwitch={switchProfile}
              />
            )}
            <button
              type="button"
              onClick={() =>
                openTab({
                  kind: "settings",
                  name: "settings",
                  label: "Settings",
                })
              }
              className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-150 ${
                activeTab?.kind === "settings"
                  ? "bg-bg-overlay text-fg"
                  : "text-fg-muted hover:bg-bg-overlay hover:text-fg"
              }`}
            >
              <SettingsIcon className="size-3.5" />
              Settings
            </button>
          </footer>
        </div>
      </aside>

      <main className="relative flex min-w-0 flex-1 flex-col">
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
                onClick={() => setSidebarOpen((value) => !value)}
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
          <>
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
                        <WorkflowScreen
                          projectId={projectId}
                          workflowName={tab.name}
                        />
                      ) : tab.kind === "app" ? (
                        <AppScreen projectId={projectId} appName={tab.name} />
                      ) : tab.kind === "settings" ? (
                        <SettingsScreen
                          onClose={() => closeTab(tabKey(tab))}
                          onAddAgent={() => setWizardModalOpen(true)}
                        />
                      ) : tab.kind === "palette" && paletteProps ? (
                        <CommandPalette
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
                      onStateChange={(state) =>
                        onBrowserState(browser.localId, state)
                      }
                      registerNavigate={(navigate) =>
                        browserNavigatorsRef.current.set(
                          browser.localId,
                          navigate,
                        )
                      }
                      onUnsplit={
                        viewSlots[browserTabKey(browser.localId)] &&
                        viewSlots[browserTabKey(browser.localId)] !== "full"
                          ? () =>
                              openSurface(browserTabKey(browser.localId), "tab")
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
                    className={paneClass(terminalTabKey(terminal.localId))}
                    style={paneStyle(terminalTabKey(terminal.localId))}
                    {...paneFocusProps(terminalTabKey(terminal.localId))}
                  >
                    {viewSlots[terminalTabKey(terminal.localId)] !==
                      undefined &&
                      viewSlots[terminalTabKey(terminal.localId)] !==
                        "full" && (
                        <PaneUnsplitButton
                          onClick={() =>
                            openSurface(terminalTabKey(terminal.localId), "tab")
                          }
                        />
                      )}
                    <TerminalScreen
                      projectId={projectId}
                      active={terminal.localId === activeTerminalTabId}
                      onTitle={(title) =>
                        onTerminalTitle(terminal.localId, title)
                      }
                      onExit={() => closeTab(terminalTabKey(terminal.localId))}
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

              {/* Dragging a tab: side drop zones tile it left or right. */}
              {tabDragKey && (
                <div className="absolute inset-0 z-50 flex">
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
                  slot={viewSlots[chatTabKey(entry.localId)] ?? "full"}
                  splitRatio={splitRatio}
                  splitResizing={dividerDragging}
                  bubbleClearance={bubblesCollapsed ? "corner" : "strip"}
                  defaultAgentId={agentsData?.defaultAgentId ?? undefined}
                  paletteTargeted={entry.localId === targetedChat?.localId}
                  surfaces={surfacesFor(entry)}
                  onOpenSurface={openSurface}
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
                  onFileClick={(path) =>
                    openEditorTab({
                      filePath: path,
                      chatLocalId: entry.localId,
                    })
                  }
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
                  onSessionCreated={onSessionCreated}
                  onSendingChange={onSendingChange}
                />
              ))}

              <ChatBubbles
                entries={workspace.chats}
                labels={chatLabels}
                sending={sendingByChat}
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
          </>
        ) : (
          <EmptyState
            loading={projectsQuery.isLoading}
            onNewProject={() => setProjectModalOpen(true)}
          />
        )}
      </main>

      {/* Stays mounted so the close transition can play out. */}
      {paletteProps && (
        <CommandPalette
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
  onOpenTab,
  onNewChat,
  onOpenSession,
  onOpenUrl,
}: {
  section: SidebarSectionConfig;
  projectId: string;
  profileId?: string;
  activeTab?: WorkspaceTab;
  activeChatSessionId?: string;
  keybindingLabel: string;
  onOpenTab: (tab: WorkspaceTab) => void;
  onNewChat: () => void;
  onOpenSession: (session: AgentSession) => void;
  onOpenUrl: (url: string, mode: "tab" | "replace") => void;
}) {
  const defaultOpen = !section.collapsed;
  switch (section.type) {
    case "workflows":
      return (
        <SidebarSection
          title={section.title ?? "Workflows"}
          defaultOpen={defaultOpen}
        >
          <WorkflowsNav
            projectId={projectId}
            active={activeTab?.kind === "workflow" ? activeTab.name : undefined}
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
            onOpen={(url, mode) =>
              onOpenUrl(url, mode ?? section.open ?? "replace")
            }
          />
        </SidebarSection>
      );
    case "custom":
      return (
        <SidebarSection
          title={section.title ?? "Links"}
          defaultOpen={defaultOpen}
        >
          <CustomItems section={section} onOpenUrl={onOpenUrl} />
        </SidebarSection>
      );
    default:
      return null;
  }
}

/**
 * A user-defined section's items. Same row component as bookmarks, so a
 * config-authored item gets the identical ⋯ menu behavior; only the
 * bookmark-specific actions (pin/rename/remove) are inert here.
 */
function CustomItems({
  section,
  onOpenUrl,
}: {
  section: SidebarSectionConfig;
  onOpenUrl: (url: string, mode: "tab" | "replace") => void;
}) {
  const items = section.items ?? [];
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
  onSelect,
}: {
  projectId: string;
  active?: string;
  onSelect: (workflow: { name: string; displayName?: string }) => void;
}) {
  const workflowsQuery = useWorkflows(projectId);
  const workflows = workflowsQuery.data ?? [];
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
  onSelect,
}: {
  projectId: string;
  active?: string;
  onSelect: (appName: string) => void;
}) {
  const appsQuery = useApps(projectId);
  const apps = appsQuery.data ?? [];
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
        <li key={app.name}>
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
  onSelect,
}: {
  projectId: string;
  activeSessionId?: string;
  onSelect: (session: AgentSession) => void;
}) {
  const sessionsQuery = useAgentSessions(projectId);
  const sessions = sessionsQuery.data?.items ?? [];
  if (sessions.length === 0) {
    return <p className="px-2 py-1 text-xs text-fg-faint">No chats yet.</p>;
  }
  return (
    <ul className="flex flex-col gap-0.5">
      {sessions.map((session) => (
        <li key={session.id}>
          <button
            type="button"
            onClick={() => onSelect(session)}
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded px-2 text-left text-[13px] transition-colors duration-150 ${
              session.id === activeSessionId
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay/60 hover:text-fg"
            }`}
            aria-current={session.id === activeSessionId || undefined}
          >
            <AnimatedTitle text={sessionLabel(session)} />
          </button>
        </li>
      ))}
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
}: {
  loading: boolean;
  onNewProject: () => void;
}) {
  return (
    <div className="grid flex-1 place-items-center">
      <div className="max-w-sm text-center">
        {loading ? (
          <p className="animate-pulse text-sm text-fg-muted">Loading…</p>
        ) : (
          <>
            <p className="text-sm text-fg-muted">
              Create a project from scratch or import an existing folder.
            </p>
            <button
              type="button"
              onClick={onNewProject}
              className="mt-4 inline-flex h-8 cursor-pointer items-center gap-2 rounded-md bg-accent px-3 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
            >
              <FolderPlus className="size-3.5" />
              New project
            </button>
          </>
        )}
      </div>
    </div>
  );
}
