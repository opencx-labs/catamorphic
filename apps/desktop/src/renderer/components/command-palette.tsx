import { useAgentSessions, useWorkflows } from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import * as lucide from "lucide-react";
import {
  ArrowRight,
  Bot,
  ChevronLeft,
  ChevronRight,
  Cpu,
  FileCode,
  Gauge,
  Globe,
  LayoutGrid,
  type LucideIcon,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  PanelLeft,
  Search,
  Settings as SettingsIcon,
  SquareTerminal,
  Star,
  UserRound,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from "lucide-react";
import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  type ActionDefinition,
  type ActionId,
  BUILTIN_ACTIONS,
  type KeybindingAction,
} from "../../shared/actions.js";
import { commandScore } from "../lib/command-score.js";
import {
  type AgentEffort,
  type AgentInfo,
  type Bookmark,
  desktopApi,
  type HarnessModelInfo,
  type OpenRouterCatalog,
  type Profile,
  type SidebarConfig,
} from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { useApps } from "../screens/app-screen.js";
import { resolveInput } from "../screens/browser-screen.js";
import type { WorkspaceTab } from "./workspace-tabs.js";

/**
 * The command palette, in two hosts: a Cmd+P overlay above everything, and
 * the content of a "New Tab" (Cmd+T). Matching is Superhuman's
 * command-score over label + keywords — the same algorithm cmdk uses, so
 * subsequences ("gto proj") and synonyms both hit.
 *
 * Enter/Cmd+Enter: in the overlay, Enter opens in the current tab and
 * Cmd+Enter in a new one; in a palette tab both land in the tab itself
 * (the palette tab is consumed).
 */

type CommitMode = "replace" | "tab";

/**
 * Icons stay renderer-side (the shared registry is plain data usable by
 * the main process). Unknown ids — e.g. future plugin actions — fall back
 * to Zap.
 */
const ACTION_ICONS: Partial<Record<ActionId, LucideIcon>> = {
  "new-floating-chat": MessageSquarePlus,
  "toggle-chat-minimized": Minimize2,
  "chat-to-tab": Maximize2,
  "prev-chat": MessageSquare,
  "next-chat": MessageSquare,
  "prev-tab": ChevronLeft,
  "next-tab": ChevronRight,
  "new-browser-tab": Globe,
  "new-terminal-tab": SquareTerminal,
  "new-editor-tab": FileCode,
  "toggle-sidebar": PanelLeft,
  "close-tab": X,
  "setup-agent": Bot,
  "default-agent": Bot,
  "switch-agent": Bot,
  "change-effort": Gauge,
  "switch-model": Cpu,
};

/**
 * Pickers: palette-local flows where a command narrows the list to one
 * question ("which agent?", "which effort?"). Same chip visual as the @
 * modes; Backspace on empty input pops back out.
 */
export type PaletteInPicker =
  | "default-agent"
  | "switch-agent"
  | "effort"
  | "model";

const PICKER_CHIPS: Record<
  PaletteInPicker,
  { chip: string; icon: LucideIcon; placeholder: string }
> = {
  "default-agent": {
    chip: "Default agent",
    icon: Bot,
    placeholder: "Pick the profile's default agent…",
  },
  "switch-agent": {
    chip: "Chat agent",
    icon: Bot,
    placeholder: "Pick an agent for this chat…",
  },
  effort: {
    chip: "Effort",
    icon: Gauge,
    placeholder: "Pick reasoning effort…",
  },
  model: {
    chip: "Model",
    icon: Cpu,
    placeholder: "Type or pick a model…",
  },
};

/** Action rows that open a picker instead of running an app handler. */
const PICKER_ACTIONS: Partial<Record<ActionId, PaletteInPicker>> = {
  "default-agent": "default-agent",
  "switch-agent": "switch-agent",
  "change-effort": "effort",
  "switch-model": "model",
};

const HARNESS_LABELS: Record<AgentInfo["harness"], string> = {
  "ai-sdk": "Built-in",
  "claude-code": "Claude Code",
  codex: "Codex",
};

const PROVIDER_LABELS: Record<string, string> = {
  anthropic: "Anthropic",
  openai: "OpenAI",
  openrouter: "OpenRouter",
};

/**
 * What an agent runs on, for the faded detail: the built-in agent is
 * named by its provider (the harness name says nothing useful next to a
 * user-chosen agent name), the CLIs by the harness.
 */
function agentSourceLabel(agent: AgentInfo): string {
  if (agent.harness === "ai-sdk" && agent.provider) {
    return PROVIDER_LABELS[agent.provider] ?? agent.provider;
  }
  return HARNESS_LABELS[agent.harness];
}

/** How it authenticates, in the user's terms. */
function agentAuthLabel(agent: AgentInfo): string {
  if (agent.auth === "api-key") return "API key";
  if (agent.auth === "local") return "this machine";
  return agent.harness === "ai-sdk" && agent.provider === "openrouter"
    ? "signed in"
    : "separate account";
}

const EFFORT_LEVELS: Array<{
  id: AgentEffort;
  label: string;
  description: string;
}> = [
  { id: "low", label: "Low effort", description: "Fast, direct responses" },
  { id: "medium", label: "Medium effort", description: "Balanced reasoning" },
  { id: "high", label: "High effort", description: "Deep, thorough reasoning" },
];

interface PaletteItem {
  id: string;
  icon: LucideIcon;
  label: string;
  /** Muted inline text, e.g. a URL host or the item's type. */
  detail?: string;
  keywords: string[];
  /** Preformatted chip, e.g. "⌘B". */
  shortcut?: string;
  /** Navigate items load something tab-shaped and honor the commit mode. */
  kind: "action" | "navigate";
  run: (mode: CommitMode) => void;
}

/** The whole input is URL-shaped: scheme, or domain(+path) with no spaces. */
const URLISH =
  /^(https?:\/\/\S+|[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?|localhost(:\d+)?(\/\S*)?)$/i;
const LONG_QUERY = 60;
const LIST_MAX_HEIGHT = 350;

/**
 * Explicit intent modes (Chrome omnibox @-shortcuts pattern): typing the
 * trigger then Tab/Space — or picking the zero-state row — commits the
 * mode as a chip; the input then only feeds that mode. Backspace on empty
 * input pops the chip (cmdk convention).
 */
export interface PaletteMode {
  id: "agent" | "web";
  /** Typed trigger, matched with or without the leading @. */
  trigger: string;
  /** Alternate typed names that commit the same mode (e.g. "chat"). */
  aliases?: string[];
  /** Chip text once committed. */
  chip: string;
  icon: LucideIcon;
  /** Zero-state row label + description. */
  label: string;
  description: string;
  placeholder: string;
}

export const PALETTE_MODES: PaletteMode[] = [
  {
    id: "agent",
    trigger: "agent",
    aliases: ["chat"],
    chip: "Ask agent",
    icon: Bot,
    label: "Ask the agent",
    description: "Send everything you type to a new chat",
    placeholder: "Message the agent…",
  },
  {
    id: "web",
    trigger: "web",
    chip: "Search web",
    icon: Search,
    label: "Search the web",
    description: "Google search in a browser tab",
    placeholder: "Search the web…",
  },
];

/** A mode's typed names: the trigger plus any aliases. */
const modeNames = (mode: PaletteMode): string[] => [
  mode.trigger,
  ...(mode.aliases ?? []),
];

/** "@age", "age", or "chat" → the agent mode, once unambiguous. */
const matchMode = (input: string): PaletteMode | undefined => {
  const raw = (input.startsWith("@") ? input.slice(1) : input).toLowerCase();
  if (raw.length === 0) return undefined;
  const matches = PALETTE_MODES.filter((mode) =>
    modeNames(mode).some((name) => name.startsWith(raw)),
  );
  return matches.length === 1 ? matches[0] : undefined;
};

/** The input IS a full mode name (trigger or alias), no @ needed. */
const isFullModeName = (input: string): boolean => {
  const raw = input.toLowerCase();
  return PALETTE_MODES.some((mode) => modeNames(mode).includes(raw));
};

function FooterHint({ keycap, label }: { keycap: string; label: string }) {
  return (
    <span className="flex items-center gap-1">
      <kbd className="rounded border border-border bg-bg-inset px-1 py-px font-sans text-[10px]">
        {keycap}
      </kbd>
      {label}
    </span>
  );
}

const hostOf = (url: string): string => {
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url;
  }
};

const bareUrl = (url: string): string =>
  url.replace(/^https?:\/\/(www\.)?/, "");

const lucideIcon = (name: string | undefined): LucideIcon => {
  if (!name) return Globe;
  const icon = (lucide as unknown as Record<string, LucideIcon>)[name];
  return icon ?? Globe;
};

export function CommandPalette({
  variant,
  open = true,
  onClose,
  projectId,
  profileId,
  projects,
  activeProjectId,
  profiles,
  activeProfileId,
  sidebarConfig,
  onOpenUrl,
  onOpenTab,
  onOpenSession,
  onSelectProject,
  onSwitchProfile,
  onSendToAgent,
  actionHandlers,
  agents,
  defaultAgentId,
  focusedChat,
  onPickDefaultAgent,
  onPickSessionAgent,
  onPickEffort,
  onPickModel,
  onHighlightTarget,
  pickerRequest,
}: {
  variant: "overlay" | "tab";
  /**
   * Overlay only: stays mounted while closed so the exit transition can
   * play (unmounting kills it mid-frame). Tab variant is always open.
   */
  open?: boolean;
  /** Overlay: hide the palette. Tab: close/consume the palette tab. */
  onClose: () => void;
  projectId: string;
  profileId?: string;
  projects: ProjectSummary[];
  activeProjectId?: string;
  profiles: Profile[];
  activeProfileId?: string;
  sidebarConfig: SidebarConfig | null;
  onOpenUrl: (url: string, mode: CommitMode) => void;
  onOpenTab: (tab: WorkspaceTab) => void;
  onOpenSession: (session: AgentSession) => void;
  onSelectProject: (id: string) => void;
  onSwitchProfile: (profile: Profile) => void;
  onSendToAgent: (message: string, mode: "float" | "tab") => void;
  /** One handler per registry action — the same map the shortcuts use. */
  actionHandlers: Record<ActionId, () => void>;
  /** The profile's configured agents (for the agent/effort pickers). */
  agents: AgentInfo[];
  defaultAgentId: string | null;
  /** The chat the session-scoped commands act on; null = none focused. */
  focusedChat: {
    agentId: string | null;
    effort: AgentEffort | null;
  } | null;
  onPickDefaultAgent: (agentId: string) => void;
  onPickSessionAgent: (agentId: string) => void;
  onPickEffort: (effort: AgentEffort) => void;
  /** Change the target agent's model ("" = the automatic default). */
  onPickModel: (agentId: string, model: string) => void;
  /**
   * The highlighted row targets a specific surface ("chat" = the focused
   * chat, "close" = whatever close-tab would close) — reported up so the
   * app can accent that surface's border while the row is highlighted.
   */
  onHighlightTarget?: (target: "chat" | "close" | null) => void;
  /** Overlay only: open straight into a picker (Cmd+P agent commands). */
  pickerRequest?: { kind: PaletteInPicker; nonce: string } | null;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [mode, setMode] = useState<PaletteMode | null>(null);
  // Exiting chip lingers to play chip-out; removed on animationend.
  const [exitingMode, setExitingMode] = useState<PaletteMode | null>(null);
  const [picker, setPicker] = useState<PaletteInPicker | null>(null);
  const [exitingPicker, setExitingPicker] = useState<PaletteInPicker | null>(
    null,
  );
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const sizerRef = useRef<HTMLDivElement>(null);

  const enterMode = useCallback((next: PaletteMode) => {
    setMode(next);
    setExitingMode(null);
    setPicker(null);
    setExitingPicker(null);
    setQuery("");
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  const exitMode = useCallback(() => {
    setMode((current) => {
      if (current) setExitingMode(current);
      return null;
    });
  }, []);

  // OpenRouter catalog for the model picker, fetched when first needed
  // (main caches it for an hour).
  const [catalog, setCatalog] = useState<OpenRouterCatalog | null>(null);
  // Per-agent supported models (Claude Code / Codex / provider APIs),
  // resolved live by main — never a hardcoded list.
  const [harnessModels, setHarnessModels] = useState<{
    agentId: string;
    models: HarnessModelInfo[];
  } | null>(null);

  const enterPicker = useCallback((next: PaletteInPicker) => {
    setPicker(next);
    setExitingPicker(null);
    setMode(null);
    setExitingMode(null);
    setQuery("");
    setSelectedIndex(0);
    inputRef.current?.focus();
  }, []);

  const exitPicker = useCallback(() => {
    setPicker((current) => {
      if (current) setExitingPicker(current);
      return null;
    });
  }, []);

  // The model picker's target: the focused chat's agent, else the default.
  const targetAgent = agents.find(
    (candidate) =>
      candidate.id === ((focusedChat?.agentId ?? defaultAgentId) || ""),
  );

  useEffect(() => {
    if (picker !== "model" || !targetAgent) return;
    let cancelled = false;
    if (
      targetAgent.harness === "ai-sdk" &&
      targetAgent.provider === "openrouter"
    ) {
      if (catalog === null) {
        void desktopApi.openrouterModels().then((data) => {
          if (!cancelled) setCatalog(data);
        });
      }
    } else if (harnessModels?.agentId !== targetAgent.id) {
      void desktopApi.agentModels(targetAgent.id).then((data) => {
        if (!cancelled) {
          setHarnessModels({ agentId: targetAgent.id, models: data.models });
        }
      });
    }
    return () => {
      cancelled = true;
    };
  }, [picker, catalog, harnessModels, targetAgent]);

  // Cmd+P agent commands open the overlay already inside a picker.
  useEffect(() => {
    if (variant !== "overlay" || !pickerRequest) return;
    enterPicker(pickerRequest.kind);
  }, [variant, pickerRequest, enterPicker]);

  const keybindings = useKeybindings();

  const workflows = useWorkflows(projectId).data ?? [];
  const apps = useApps(projectId).data ?? [];
  const sessions = useAgentSessions(projectId).data?.items ?? [];

  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);
  useEffect(() => {
    if (!profileId) return;
    let cancelled = false;
    void desktopApi.bookmarksGet({ projectId, profileId }).then((data) => {
      if (!cancelled) {
        setBookmarks([...data.pinned, ...data.project.bookmarks]);
      }
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.profileId !== profileId) return;
      // Profile-wide changes (projectId null, e.g. a browser import) have
      // no project scope attached — refetch the combined view.
      if (change.projectId === null) {
        void desktopApi.bookmarksGet({ projectId, profileId }).then((data) => {
          setBookmarks([...data.pinned, ...data.project.bookmarks]);
        });
        return;
      }
      if (change.projectId === projectId && change.project) {
        setBookmarks([...change.pinned, ...change.project.bookmarks]);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, profileId]);

  // Refetched on every open — the overlay stays mounted while closed, so
  // a mount-only fetch would serve stale history forever.
  const [history, setHistory] = useState<{ url: string; title: string }[]>([]);
  useEffect(() => {
    if (!profileId || !open) return;
    let cancelled = false;
    void desktopApi
      .browserRecentHistory({ profileId, limit: 150 })
      .then((entries) => {
        if (!cancelled) setHistory(entries);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId, open]);

  // Focus on open; reset the query after the exit transition so the list
  // doesn't visibly re-expand while the panel is still fading out (the
  // opencx trick, minus their 500ms — ours matches the 200ms transition).
  useEffect(() => {
    if (open) {
      // rAF waits out the `inert` removal — focus() no-ops on inert trees.
      const frame = requestAnimationFrame(() => inputRef.current?.focus());
      return () => cancelAnimationFrame(frame);
    }
    const timer = setTimeout(() => {
      setQuery("");
      setSelectedIndex(0);
      setMode(null);
      setExitingMode(null);
      setPicker(null);
      setExitingPicker(null);
      // Next open is a fresh first paint — the panel's enter animation
      // covers it; stale row positions would fade-rise every row.
      rowTopsRef.current.clear();
    }, 250);
    return () => clearTimeout(timer);
  }, [open]);

  // Action rows come straight from the shared registry — one entry there
  // yields the shortcut, the Settings row, the agent doc, and this row.
  // Handlers are read through a ref: the map is rebuilt every app render
  // (closures over fresh state), and letting it invalidate this memo
  // would cascade into the results memo and the FLIP pass per render.
  const actionHandlersRef = useRef(actionHandlers);
  actionHandlersRef.current = actionHandlers;
  const hasFocusedChat = focusedChat !== null;
  const actionItems = useMemo<PaletteItem[]>(
    () =>
      BUILTIN_ACTIONS.filter(
        (action: ActionDefinition) =>
          !action.hiddenInPalette &&
          // Session-scoped: only offered while a chat is focused.
          (action.id !== "switch-agent" || hasFocusedChat),
      ).map((action) => {
        const targetPicker = PICKER_ACTIONS[action.id];
        return {
          id: `action:${action.id}`,
          icon: ACTION_ICONS[action.id] ?? Zap,
          label: action.label,
          keywords: [...action.keywords],
          shortcut:
            action.id in keybindings
              ? formatBinding(keybindings[action.id as KeybindingAction])
              : undefined,
          kind: "action" as const,
          // Picker commands swap palette state in place (like mode rows);
          // everything else runs the shared handler.
          run: targetPicker
            ? () => enterPicker(targetPicker)
            : () => actionHandlersRef.current[action.id](),
        };
      }),
    [keybindings, hasFocusedChat, enterPicker],
  );

  const projectItems = useMemo<PaletteItem[]>(
    () =>
      projects
        .filter((project) => project.id !== activeProjectId)
        .map((project) => ({
          id: `project:${project.id}`,
          icon: ArrowRight,
          label: `Go to ${project.name}`,
          detail: "Project",
          keywords: [project.name, "go to", "project", "switch", "open"],
          kind: "action" as const,
          run: () => onSelectProject(project.id),
        })),
    [projects, activeProjectId, onSelectProject],
  );

  const profileItems = useMemo<PaletteItem[]>(
    () =>
      profiles
        .filter((profile) => profile.id !== activeProfileId)
        .map((profile) => ({
          id: `profile:${profile.id}`,
          icon: UserRound,
          label: `Switch to ${profile.name}`,
          detail: "Profile",
          keywords: [profile.name, "switch to", "profile", "account"],
          kind: "action" as const,
          run: () => onSwitchProfile(profile),
        })),
    [profiles, activeProfileId, onSwitchProfile],
  );

  const sidebarItems = useMemo<PaletteItem[]>(() => {
    const items: PaletteItem[] = [];
    for (const workflow of workflows) {
      const label = workflow.displayName ?? workflow.name;
      items.push({
        id: `workflow:${workflow.name}`,
        icon: WorkflowIcon,
        label,
        detail: "Workflow",
        keywords: [workflow.name, "workflow", "go to", "open"],
        kind: "navigate",
        run: () => onOpenTab({ kind: "workflow", name: workflow.name, label }),
      });
    }
    for (const app of apps) {
      items.push({
        id: `app:${app.name}`,
        icon: LayoutGrid,
        label: app.name,
        detail: "App",
        keywords: [app.name, "app", "go to", "open"],
        kind: "navigate",
        run: () => onOpenTab({ kind: "app", name: app.name }),
      });
    }
    for (const session of sessions) {
      if (!session.title) continue;
      items.push({
        id: `session:${session.id}`,
        icon: MessageSquare,
        label: session.title,
        detail: "Chat",
        keywords: [session.title, "chat", "session", "conversation"],
        kind: "navigate",
        run: () => onOpenSession(session),
      });
    }
    for (const bookmark of bookmarks) {
      items.push({
        id: `bookmark:${bookmark.id}`,
        icon: Star,
        label: bookmark.label,
        detail: hostOf(bookmark.url),
        keywords: [
          bookmark.label,
          hostOf(bookmark.url),
          bareUrl(bookmark.url),
          "bookmark",
        ],
        kind: "navigate",
        run: (mode) => onOpenUrl(bookmark.url, mode),
      });
    }
    for (const section of sidebarConfig?.sections ?? []) {
      if (section.type !== "custom") continue;
      for (const item of section.items ?? []) {
        items.push({
          id: `custom:${item.label}:${item.url}`,
          icon: lucideIcon(item.icon),
          label: item.label,
          detail: hostOf(item.url),
          keywords: [item.label, hostOf(item.url), bareUrl(item.url), "link"],
          kind: "navigate",
          run: (mode) => onOpenUrl(item.url, mode),
        });
      }
    }
    items.push({
      id: "tab:settings",
      icon: SettingsIcon,
      label: "Settings",
      detail: "Open settings",
      keywords: ["settings", "preferences", "shortcuts", "theme", "keys"],
      kind: "navigate",
      run: () =>
        onOpenTab({ kind: "settings", name: "settings", label: "Settings" }),
    });
    return items;
  }, [
    workflows,
    apps,
    sessions,
    bookmarks,
    sidebarConfig,
    onOpenTab,
    onOpenSession,
    onOpenUrl,
  ]);

  const historyItems = useMemo<PaletteItem[]>(
    () =>
      history.map((entry) => ({
        id: `history:${entry.url}`,
        icon: Globe,
        label: entry.title || entry.url,
        detail: hostOf(entry.url),
        keywords: [entry.title, hostOf(entry.url), bareUrl(entry.url)],
        kind: "navigate" as const,
        run: (mode) => onOpenUrl(entry.url, mode),
      })),
    [history, onOpenUrl],
  );

  const trimmed = query.trim();
  const results = useMemo<PaletteItem[]>(() => {
    // Picker active: the list IS the question. Agent rows or effort rows,
    // narrowed by whatever is typed; picking answers and closes.
    if (picker === "model") {
      if (!targetAgent) {
        return [
          {
            id: "pick:none",
            icon: SettingsIcon,
            label: "No agents configured",
            detail: "Open Settings to add one",
            keywords: [],
            kind: "navigate",
            run: () =>
              onOpenTab({
                kind: "settings",
                name: "settings",
                label: "Settings",
              }),
          },
        ];
      }
      const agent = targetAgent;
      const current = agent.model;
      const rows: PaletteItem[] = [];
      if (agent.harness === "ai-sdk" && agent.provider === "openrouter") {
        rows.push({
          id: "pick:model:",
          icon: Cpu,
          label: "Best free model (automatic)",
          detail: `${catalog?.bestFreeModelId ?? "resolved from the catalog"}${
            current === "" ? " · current" : ""
          }`,
          keywords: ["best", "free", "auto", "default"],
          kind: "action",
          run: () => onPickModel(agent.id, ""),
        });
        const models = (catalog?.models ?? [])
          .slice()
          .sort(
            (a, b) => Number(b.free) - Number(a.free) || b.created - a.created,
          );
        // Zero state: the newest free models only — the browsable shortlist.
        // Typing searches the whole catalog.
        const matched = trimmed
          ? models
              .map((model) => ({
                model,
                score: commandScore(`${model.name} ${model.id}`, trimmed, []),
              }))
              .filter((entry) => entry.score > 0)
              .sort((a, b) => b.score - a.score)
              .map((entry) => entry.model)
          : models
              .filter((model) => model.free)
              .sort((a, b) => b.created - a.created)
              .slice(0, 20);
        for (const model of matched.slice(0, 50)) {
          rows.push({
            id: `pick:model:${model.id}`,
            icon: Cpu,
            label: model.name,
            detail: `${model.id}${model.free ? " · free" : ""}${
              model.id === current ? " · current" : ""
            }`,
            keywords: [],
            kind: "action",
            run: () => onPickModel(agent.id, model.id),
          });
        }
        return rows;
      }
      // CLIs run their own default; Anthropic/OpenAI need an explicit id.
      if (agent.harness !== "ai-sdk") {
        rows.push({
          id: "pick:model:",
          icon: Cpu,
          label: "Harness default (automatic)",
          detail: current === "" ? "current" : undefined,
          keywords: ["default", "auto"],
          kind: "action",
          run: () => onPickModel(agent.id, ""),
        });
      }
      // Supported values straight from the harness (Claude Code's own
      // catalog, `codex debug models`, or the provider's /v1/models).
      const supported =
        harnessModels?.agentId === agent.id ? harnessModels.models : [];
      const matchedSupported = trimmed
        ? supported
            .map((model) => ({
              model,
              score: commandScore(`${model.name} ${model.id}`, trimmed, []),
            }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((entry) => entry.model)
        : supported;
      for (const model of matchedSupported.slice(0, 50)) {
        rows.push({
          id: `pick:model:${model.id}`,
          icon: Cpu,
          label: model.name,
          // Aliases ("sonnet") show the versioned id they resolve to.
          detail: `${model.resolvedId ?? model.id}${model.id === current ? " · current" : ""}`,
          keywords: [],
          kind: "action",
          run: () => onPickModel(agent.id, model.id),
        });
      }
      if (current && !supported.some((model) => model.id === current)) {
        rows.push({
          id: `pick:model:${current}`,
          icon: Cpu,
          label: current,
          detail: "current",
          keywords: [],
          kind: "action",
          run: () => onPickModel(agent.id, current),
        });
      }
      if (
        trimmed &&
        trimmed !== current &&
        !supported.some((model) => model.id === trimmed)
      ) {
        rows.push({
          id: `pick:model-custom`,
          icon: Cpu,
          label: `Use "${trimmed}"`,
          detail: "Set this model id",
          keywords: [],
          kind: "action",
          run: () => onPickModel(agent.id, trimmed),
        });
      }
      return rows;
    }

    if (picker) {
      const rows: PaletteItem[] =
        picker === "effort"
          ? EFFORT_LEVELS.map((level) => {
              const referenceAgentId =
                (focusedChat ? focusedChat.agentId : null) ?? defaultAgentId;
              const agentDefault = agents.find(
                (agent) => agent.id === referenceAgentId,
              )?.effort;
              const current = focusedChat
                ? (focusedChat.effort ?? agentDefault)
                : agentDefault;
              return {
                id: `pick:effort:${level.id}`,
                icon: Gauge,
                label: level.label,
                detail:
                  level.id === current
                    ? `${level.description} · current`
                    : level.description,
                keywords: [level.id, "effort", "reasoning"],
                kind: "action" as const,
                run: () => onPickEffort(level.id),
              };
            })
          : agents.map((agent) => {
              const marker =
                picker === "default-agent"
                  ? agent.id === defaultAgentId
                    ? " · default"
                    : ""
                  : agent.id ===
                      ((focusedChat?.agentId ?? defaultAgentId) || "")
                    ? " · current"
                    : "";
              return {
                id: `pick:agent:${agent.id}`,
                icon: Bot,
                label: agent.name,
                detail: `${agentSourceLabel(agent)} · ${agentAuthLabel(agent)}${marker}`,
                keywords: [
                  agent.name,
                  agent.harness,
                  agent.provider ?? "",
                  agent.model,
                ],
                kind: "action" as const,
                run: () =>
                  picker === "default-agent"
                    ? onPickDefaultAgent(agent.id)
                    : onPickSessionAgent(agent.id),
              };
            });
      if (rows.length === 0) {
        return [
          {
            id: "pick:none",
            icon: SettingsIcon,
            label: "No agents configured",
            detail: "Open Settings to add one",
            keywords: [],
            kind: "navigate",
            run: () =>
              onOpenTab({
                kind: "settings",
                name: "settings",
                label: "Settings",
              }),
          },
        ];
      }
      if (!trimmed) return rows;
      return rows
        .map((item) => ({
          item,
          score: commandScore(item.label, trimmed, item.keywords),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.item);
    }

    // Chip mode active: the whole input belongs to that mode. One row —
    // Enter commits it — so typing never drifts into unrelated matches.
    if (mode) {
      const modeQuery = trimmed;
      if (mode.id === "agent") {
        return [
          {
            id: "mode:agent",
            icon: Bot,
            label: modeQuery ? `Ask agent: ${modeQuery}` : "Ask the agent",
            detail: modeQuery ? undefined : "Type a message",
            keywords: [],
            kind: "navigate",
            run: (commitMode) => {
              if (!modeQuery) return;
              onSendToAgent(query, commitMode === "tab" ? "tab" : "float");
            },
          },
        ];
      }
      return [
        {
          id: "mode:web",
          icon: Search,
          label: modeQuery
            ? `Search the web for "${modeQuery}"`
            : "Search the web",
          detail: modeQuery ? "Google Search" : "Type a query",
          keywords: [],
          kind: "navigate",
          run: (commitMode) => {
            if (!modeQuery) return;
            onOpenUrl(
              `https://www.google.com/search?q=${encodeURIComponent(modeQuery)}`,
              commitMode,
            );
          },
        },
      ];
    }

    // "@" zero-state: list the modes as selectable rows (Chrome's
    // @-shortcut pills). Narrows as the trigger is typed.
    if (trimmed.startsWith("@")) {
      const partial = trimmed.slice(1).toLowerCase();
      const modeRows = PALETTE_MODES.filter((candidate) =>
        modeNames(candidate).some((name) => name.startsWith(partial)),
      ).map(
        (candidate): PaletteItem => ({
          id: `mode-row:${candidate.id}`,
          icon: candidate.icon,
          label: candidate.label,
          detail: candidate.description,
          shortcut: "Tab",
          keywords: [],
          kind: "action",
          run: () => enterMode(candidate),
        }),
      );
      if (modeRows.length > 0) return modeRows;
    }

    // ">" filters to command rows only (VS Code quick-open convention).
    if (trimmed.startsWith(">")) {
      const commandQuery = trimmed.slice(1).trim();
      const commands = [...actionItems, ...projectItems, ...profileItems];
      if (!commandQuery) return commands;
      return commands
        .map((item) => ({
          item,
          score: commandScore(item.label, commandQuery, item.keywords),
        }))
        .filter((entry) => entry.score > 0)
        .sort((a, b) => b.score - a.score)
        .map((entry) => entry.item);
    }

    if (!trimmed) {
      return [
        ...actionItems,
        ...projectItems,
        ...profileItems,
        ...sidebarItems,
        ...historyItems.slice(0, 8),
      ];
    }

    const scored = [
      ...actionItems,
      ...projectItems,
      ...profileItems,
      ...sidebarItems,
      ...historyItems,
    ]
      .map((item) => ({
        item,
        score: commandScore(
          item.label,
          trimmed,
          item.keywords.filter((keyword) => keyword.trim() !== ""),
        ),
      }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);

    const multiline = query.includes("\n");
    const sendItem: PaletteItem = {
      id: "send-to-agent",
      icon: Bot,
      label: "Send to agent",
      detail: "Start a chat with this message",
      keywords: [],
      kind: "navigate",
      run: (mode) => onSendToAgent(query, mode === "tab" ? "tab" : "float"),
    };
    const urlish = URLISH.test(trimmed);
    const webItem: PaletteItem | null = multiline
      ? null
      : {
          id: "web",
          icon: urlish ? Globe : Search,
          label: urlish ? `Open ${trimmed}` : `Search the web for "${trimmed}"`,
          detail: urlish ? undefined : "Google Search",
          keywords: [],
          kind: "navigate",
          run: (mode) => onOpenUrl(resolveInput(trimmed), mode),
        };

    // A pasted/typed URL is an unambiguous intent: open it. Everything
    // else (fuzzy matches on the URL's characters) is noise below it.
    if (urlish && webItem) {
      return [webItem, ...scored, sendItem];
    }
    if (scored.length === 0 || multiline || query.length > LONG_QUERY) {
      return [sendItem, ...scored, ...(webItem ? [webItem] : [])];
    }
    return [...scored, ...(webItem ? [webItem] : []), sendItem];
  }, [
    trimmed,
    query,
    mode,
    picker,
    agents,
    defaultAgentId,
    focusedChat,
    enterMode,
    actionItems,
    projectItems,
    profileItems,
    sidebarItems,
    historyItems,
    onSendToAgent,
    onOpenUrl,
    onOpenTab,
    onPickDefaultAgent,
    onPickSessionAgent,
    onPickEffort,
    onPickModel,
    targetAgent,
    catalog,
    harnessModels,
  ]);

  // Two-part list animation, both measured in a layout effect so targets
  // land in the SAME frame the rows change (ResizeObserver + rAF was a
  // couple frames late, eating the tween):
  //
  // 1. cmdk's animated height — the scroll container's height is a CSS
  //    variable tracking content size; a height transition tweens it.
  // 2. FLIP on surviving rows — filtering doesn't remove rows from the
  //    edges, it removes them from the middle, so survivors teleport up
  //    to fill the holes and only the bottom gap animates. That reads as
  //    a snap even with the height tween working. So: record each row's
  //    top before render (keyed by item id), and on change play the
  //    old→new delta as a transform that eases to zero.
  const rowTopsRef = useRef(new Map<string, number>());
  // biome-ignore lint/correctness/useExhaustiveDependencies: row heights
  // are fixed, so results is the only thing that moves or resizes rows.
  useLayoutEffect(() => {
    const list = listRef.current;
    const sizer = sizerRef.current;
    if (!list || !sizer) return;
    // Clamp to the visible max — animating toward the unclamped content
    // height would spend most of the tween past the max-h cutoff.
    const height = Math.min(sizer.offsetHeight, LIST_MAX_HEIGHT);
    list.style.setProperty("--palette-list-height", `${height}px`);

    // Read phase, then write phase — interleaving offsetTop reads with
    // style writes forces a reflow per row (measured as a multi-hundred-ms
    // main-thread stall on large lists).
    const previousTops = rowTopsRef.current;
    // First paint of this palette: the panel's own enter animation covers
    // it; per-row enters on top would double the motion.
    const firstPass = previousTops.size === 0;
    const nextTops = new Map<string, number>();
    const rows: { row: HTMLElement; delta: number; entering: boolean }[] = [];
    for (const node of sizer.children) {
      const row = node as HTMLElement;
      const id = row.dataset.itemId;
      if (!id) continue;
      const top = row.offsetTop;
      nextTops.set(id, top);
      const before = previousTops.get(id);
      if (before === undefined) {
        // A row the previous result set didn't have (paste replaced the
        // whole list, delete-all brought the zero-state back): fade-rise
        // it in so full swaps read as motion, not a snap.
        rows.push({ row, delta: 0, entering: !firstPass });
        continue;
      }
      // A keystroke can land mid-glide; the row's true visual position is
      // its old layout spot PLUS the in-flight transform. Starting the new
      // glide from the raw layout delta would teleport it backwards.
      const matrix = new DOMMatrixReadOnly(getComputedStyle(row).transform);
      const delta = before + matrix.m42 - top;
      rows.push({ row, delta: Math.round(delta), entering: false });
    }
    rowTopsRef.current = nextTops;
    for (const { row, delta, entering } of rows) {
      if (delta) {
        // FLIP: jump to the old position without animating the jump.
        row.style.transition = "none";
        row.style.transform = `translateY(${delta}px)`;
      } else if (entering) {
        row.style.transition = "none";
        row.style.transform = "translateY(4px)";
        row.style.opacity = "0";
      } else {
        // Back to the class transition (transition-colors) untouched.
        row.style.transition = "";
        row.style.transform = "";
        row.style.opacity = "";
      }
    }
    if (rows.some(({ delta, entering }) => delta || entering)) {
      requestAnimationFrame(() => {
        for (const { row, delta, entering } of rows) {
          if (!delta && !entering) continue;
          // Colors stay in the list so the selection fade keeps working
          // while (and after) the row glides.
          row.style.transition =
            "transform 200ms cubic-bezier(0.2, 0, 0, 1), opacity 200ms cubic-bezier(0.2, 0, 0, 1), background-color 100ms, color 100ms";
          row.style.transform = "";
          row.style.opacity = "";
        }
      });
    }
  }, [results]);

  const selected = Math.min(selectedIndex, Math.max(results.length - 1, 0));

  // The surface the highlighted row would act on, reported up so the app
  // accents its border — a scoped command visibly points at its target.
  const selectedId = results[selected]?.id;
  const highlightTarget: "chat" | "close" | null =
    variant === "overlay" && !open
      ? null
      : picker === "switch-agent"
        ? "chat"
        : picker === "effort" || picker === "model"
          ? focusedChat
            ? "chat"
            : null
          : selectedId === "action:switch-agent"
            ? "chat"
            : selectedId === "action:change-effort" ||
                selectedId === "action:switch-model"
              ? focusedChat
                ? "chat"
                : null
              : selectedId === "action:close-tab"
                ? "close"
                : null;
  const onHighlightTargetRef = useRef(onHighlightTarget);
  onHighlightTargetRef.current = onHighlightTarget;
  useEffect(() => {
    onHighlightTargetRef.current?.(highlightTarget);
    return () => onHighlightTargetRef.current?.(null);
  }, [highlightTarget]);

  const commit = (item: PaletteItem, withCmd: boolean) => {
    // Entering a chip mode swaps palette state — the palette stays open.
    if (item.id.startsWith("mode-row:")) {
      item.run("replace");
      return;
    }
    // Picker-opening commands likewise swap palette state in place.
    if (
      item.id.startsWith("action:") &&
      PICKER_ACTIONS[item.id.slice("action:".length) as ActionId]
    ) {
      item.run("replace");
      return;
    }
    // Picking an answer runs it and puts the palette away.
    if (item.id.startsWith("pick:")) {
      if (variant === "overlay") onClose();
      item.run("replace");
      exitPicker();
      return;
    }
    // A chip-mode row with nothing typed has nothing to do yet.
    if (item.id.startsWith("mode:") && trimmed === "") return;
    const inTab = variant === "tab";
    const commitMode: CommitMode = inTab || withCmd ? "tab" : "replace";
    if (variant === "overlay") onClose();
    item.run(commitMode);
    // A palette tab is consumed by whatever it opened; pure actions
    // (toggle sidebar, …) leave it in place.
    if (inTab && item.kind === "navigate") onClose();
  };

  const moveSelection = (delta: number) => {
    setSelectedIndex((current) => {
      const next = Math.min(
        Math.max(Math.min(current, results.length - 1) + delta, 0),
        results.length - 1,
      );
      requestAnimationFrame(() => {
        sizerRef.current?.children[next]?.scrollIntoView({ block: "nearest" });
      });
      return next;
    });
  };

  const onInputKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    // Tab or Space commits a typed mode trigger into a chip ("@agent" →
    // [Ask agent]). Both keys, deliberately — Chrome removed Space once
    // and had to bring it back.
    if (
      !mode &&
      (event.key === "Tab" || event.key === " ") &&
      trimmed.length > 1 &&
      (trimmed.startsWith("@") || isFullModeName(trimmed))
    ) {
      const candidate = matchMode(trimmed);
      if (candidate) {
        event.preventDefault();
        enterMode(candidate);
        return;
      }
    }
    // Backspace on empty input pops the chip (cmdk convention).
    if (mode && event.key === "Backspace" && query === "") {
      event.preventDefault();
      exitMode();
      return;
    }
    if (picker && event.key === "Backspace" && query === "") {
      event.preventDefault();
      exitPicker();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      moveSelection(1);
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      moveSelection(-1);
    } else if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      const item = results[selected];
      if (item) commit(item, event.metaKey || event.ctrlKey);
    }
  };

  // Escape closes the overlay (capture-phase so the chat dock's window
  // listener defers to us — same etiquette as Modal). A palette tab
  // ignores Escape, like Chrome's New Tab page.
  useEffect(() => {
    if (variant !== "overlay" || !open) return;
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape" || event.isComposing) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKeyDown, { capture: true });
    return () =>
      window.removeEventListener("keydown", onKeyDown, { capture: true });
  }, [variant, open, onClose]);

  // The rendered chip: the live mode/picker, or the exiting one mid
  // chip-out. Pickers reuse the mode chip's exact visual vocabulary.
  const chip = mode
    ? { icon: mode.icon, label: mode.chip, live: true }
    : picker
      ? {
          icon: PICKER_CHIPS[picker].icon,
          label: PICKER_CHIPS[picker].chip,
          live: true,
        }
      : exitingMode
        ? { icon: exitingMode.icon, label: exitingMode.chip, live: false }
        : exitingPicker
          ? {
              icon: PICKER_CHIPS[exitingPicker].icon,
              label: PICKER_CHIPS[exitingPicker].chip,
              live: false,
            }
          : null;

  const panel = (
    <div
      role="dialog"
      aria-label="Command palette"
      className="pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-raised/95 drop-shadow-2xl backdrop-blur-xl"
    >
      <div className="mx-3 flex items-start gap-2 border-b border-border">
        {chip && (
          <span
            data-testid={chip.live ? "palette-mode-chip" : undefined}
            onAnimationEnd={(event) => {
              if (event.animationName === "chip-out") {
                setExitingMode(null);
                setExitingPicker(null);
              }
            }}
            className={`mt-[9px] flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap rounded-md bg-accent/15 py-1 pl-1.5 pr-2 text-[12px] font-medium text-accent ${
              chip.live ? "animate-chip-in" : "animate-chip-out"
            }`}
          >
            <chip.icon className="size-3.5 shrink-0" />
            {chip.label}
          </span>
        )}
        <textarea
          ref={inputRef}
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
            setSelectedIndex(0);
            if (listRef.current) listRef.current.scrollTop = 0;
          }}
          onKeyDown={onInputKeyDown}
          rows={1}
          spellCheck={false}
          placeholder={
            mode
              ? mode.placeholder
              : picker
                ? PICKER_CHIPS[picker].placeholder
                : "Search or ask anything…"
          }
          aria-label="Search commands, pages, and more"
          className="field-sizing-content max-h-40 w-full resize-none bg-transparent px-1 py-3 text-sm outline-none placeholder:text-fg-faint"
          style={{ outline: "none" }}
        />
      </div>
      <div
        ref={listRef}
        className="h-(--palette-list-height) max-h-[350px] overflow-y-auto overscroll-contain transition-[height] duration-250 ease-[cubic-bezier(0.2,0,0,1)]"
        role="listbox"
        aria-label="Results"
      >
        <div ref={sizerRef} className="p-2">
          {results.map((item, index) => {
            const Icon = item.icon;
            const isSelected = index === selected;
            return (
              <button
                key={item.id}
                data-item-id={item.id}
                type="button"
                role="option"
                aria-selected={isSelected}
                // mousedown so the textarea's focus never flickers away.
                onMouseDown={(event) => {
                  event.preventDefault();
                  commit(item, event.metaKey);
                }}
                onMouseEnter={() => setSelectedIndex(index)}
                className={`flex h-9 w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-100 ${
                  isSelected ? "bg-bg-overlay text-fg" : "text-fg-muted"
                }`}
              >
                <Icon className="size-4 shrink-0 text-fg-faint" />
                <span className="truncate">{item.label}</span>
                {item.detail && (
                  <span className="min-w-0 truncate text-[12px] text-fg-faint">
                    {item.detail}
                  </span>
                )}
                {item.shortcut && (
                  <kbd className="ml-auto shrink-0 rounded border border-border bg-bg-inset px-1.5 py-0.5 text-[11px] text-fg-faint">
                    {item.shortcut}
                  </kbd>
                )}
              </button>
            );
          })}
          {results.length === 0 && (
            <p className="py-6 text-center text-xs text-fg-faint">
              Nothing here yet.
            </p>
          )}
        </div>
      </div>
      {/* Footer hint bar (Raycast pattern): the modes' discoverability
          surface. Backspace hint replaces the entry hints while chipped. */}
      <footer
        data-testid="palette-footer"
        className="flex shrink-0 items-center gap-3 border-t border-border px-4 py-1.5 text-[11px] text-fg-faint"
      >
        {mode || picker ? (
          <FooterHint keycap="⌫" label="exit mode" />
        ) : (
          <>
            <FooterHint keycap="@" label="modes" />
            <FooterHint keycap=">" label="commands" />
          </>
        )}
        <span className="ml-auto" />
        <FooterHint keycap="↵" label="open" />
        <FooterHint keycap="⌘↵" label="new tab" />
      </footer>
    </div>
  );

  if (variant === "tab") {
    return (
      <div className="flex min-h-0 flex-1 justify-center overflow-y-auto px-6 pt-[12vh]">
        {panel}
      </div>
    );
  }

  // Transition-based enter/exit (not one-shot keyframes): the component
  // stays mounted while closed so Cmd+P/Escape play the same motion in
  // reverse — scale + rise + fade, the chat dock's vocabulary.
  return (
    <div
      className={`fixed inset-0 z-[100] flex flex-col items-center px-6 pt-[15vh] ${
        open ? "" : "pointer-events-none"
      }`}
      aria-hidden={!open}
      inert={!open ? true : undefined}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: backdrop click-away; Escape covers keyboard */}
      <div
        className={`absolute inset-0 bg-black/25 transition-opacity duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          open ? "opacity-100" : "opacity-0"
        }`}
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose();
        }}
      />
      <div
        className={`relative flex w-full origin-top justify-center transition-[opacity,translate,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
          open
            ? "translate-y-0 scale-100 opacity-100"
            : "-translate-y-2 scale-[0.98] opacity-0"
        }`}
      >
        {panel}
      </div>
    </div>
  );
}
