import {
  useAgentSessions,
  useProjects,
  useUpdateAgentSession,
  useWorkflows,
} from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import {
  ChevronRight,
  FolderPlus,
  Globe,
  LayoutGrid,
  PanelLeft,
  Plus,
  Settings as SettingsIcon,
  Workflow as WorkflowIcon,
} from "lucide-react";
import {
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
import { ChatDock, type ChatDockEntry } from "./components/chat-dock.js";
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
import { SettingsScreen } from "./screens/settings-screen.js";
import { WorkflowScreen } from "./screens/workflow-screen.js";

interface BrowserEntry {
  localId: string;
  /** Session/profile the page lives in — fixed at tab creation. */
  profileId: string;
  initialUrl: string;
  url: string;
  title: string;
  faviconUrl: string | null;
}

interface Workspace {
  tabs: WorkspaceTab[];
  activeTabKey?: string;
  chats: ChatDockEntry[];
  activeChatId?: string;
  browsers: BrowserEntry[];
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
  };
};

const chatTabKey = (localId: string) => `chat:${localId}`;
const browserTabKey = (localId: string) => `browser:${localId}`;

/** Offered to config-defined items that don't declare their own menu. */
const DEFAULT_CUSTOM_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
];

const truncateLabel = (value: string): string =>
  value.length <= 40 ? value : `${value.slice(0, 39)}…`;

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

  const selectTab = (key: string) =>
    updateWorkspace((ws) => ({
      ...ws,
      activeTabKey: key,
      ...(key.startsWith("chat:")
        ? { activeChatId: key.slice("chat:".length) }
        : {}),
    }));

  /** Open a page in a new browser tab (profile session of the workspace). */
  const openBrowserTab = useCallback(
    (url: string, opts?: { background?: boolean }) => {
      if (!activeProfile) return;
      const entry: BrowserEntry = {
        localId: crypto.randomUUID(),
        profileId: activeProfile.id,
        initialUrl: url,
        url,
        title: url || "New Tab",
        faviconUrl: null,
      };
      updateWorkspace((ws) => ({
        ...ws,
        browsers: [...ws.browsers, entry],
        activeTabKey: opts?.background
          ? ws.activeTabKey
          : browserTabKey(entry.localId),
      }));
    },
    [activeProfile, updateWorkspace],
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

  /**
   * Bookmark/link click behavior: "replace" reuses the focused browser
   * tab; anything else (or no focused browser tab) opens a new tab.
   */
  const openUrl = (url: string, mode: "tab" | "replace") => {
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
    openBrowserTab(url);
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
      ...chats
        .filter((chat) => chat.mode === "tab")
        .map((chat) => chatTabKey(chat.localId)),
    ].filter((key) => key !== closedKey);
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

  const closeChat = (localId: string) =>
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
      closeChatRef.current(floating.localId);
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
  const actionHandlers: Record<ActionId, () => void> = {
    "new-tab": openPaletteTab,
    "command-palette": () => setPaletteOpen((value) => !value),
    "new-floating-chat": () => addChat(),
    "new-browser-tab": () => openBrowserTab(""),
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
  const allTabs = [
    ...workspace.tabs,
    ...browserTabs(workspace),
    ...chatTabs(workspace, chatLabels),
  ];
  const activeChatTabId = workspace.activeTabKey?.startsWith("chat:")
    ? workspace.activeTabKey.slice("chat:".length)
    : undefined;
  const activeBrowserTabId = workspace.activeTabKey?.startsWith("browser:")
    ? workspace.activeTabKey.slice("browser:".length)
    : undefined;

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
              highlightKey={targetedTabKey}
              onSelect={selectTab}
              onClose={closeTab}
              onNew={openPaletteTab}
            />
          )}
          {projectId && (
            <ShortcutHint
              label="New browser tab"
              shortcut={formatBinding(keybindings["new-browser-tab"])}
            >
              <button
                type="button"
                onClick={() => openBrowserTab("")}
                className="app-no-drag grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                aria-label="New browser tab"
              >
                <Globe className="size-4" />
              </button>
            </ShortcutHint>
          )}
        </div>

        {projectId ? (
          <>
            <div className="relative flex min-h-0 flex-1 flex-col">
              {activeTab?.kind === "workflow" ? (
                <WorkflowScreen
                  projectId={projectId}
                  workflowName={activeTab.name}
                />
              ) : activeTab?.kind === "app" ? (
                <AppScreen projectId={projectId} appName={activeTab.name} />
              ) : activeTab?.kind === "settings" ? (
                <SettingsScreen
                  onClose={() => closeTab(tabKey(activeTab))}
                  onAddAgent={() => setWizardModalOpen(true)}
                />
              ) : activeTab?.kind === "palette" && paletteProps ? (
                <CommandPalette
                  key={tabKey(activeTab)}
                  variant="tab"
                  onClose={() => closeTab(tabKey(activeTab))}
                  {...paletteProps}
                />
              ) : activeTab?.kind === "agent-setup" ? (
                <AgentWizard
                  variant="tab"
                  onClose={() => closeTab(tabKey(activeTab))}
                  onDone={() => closeTab(tabKey(activeTab))}
                />
              ) : null}

              {/* Browser tabs stay mounted while hidden — unmounting a
                  webview would reload the page on every tab switch. */}
              {workspace.browsers.map((browser) => (
                <div
                  key={browser.localId}
                  className={
                    browser.localId === activeBrowserTabId
                      ? "absolute inset-0 flex flex-col"
                      : "hidden"
                  }
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
                  />
                </div>
              ))}

              {workspace.chats.map((entry) => (
                <ChatDock
                  key={entry.localId}
                  projectId={projectId}
                  entry={entry}
                  title={chatLabels[entry.localId] ?? "AI assistant"}
                  tabActive={entry.localId === activeChatTabId}
                  bubbleClearance={bubblesCollapsed ? "corner" : "strip"}
                  defaultAgentId={agentsData?.defaultAgentId ?? undefined}
                  paletteTargeted={entry.localId === targetedChat?.localId}
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
        No items — add some in sidebar.js.
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
