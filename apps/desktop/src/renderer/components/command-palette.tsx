import { useAgentSessions, useWorkflows } from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import * as lucide from "lucide-react";
import {
  ArrowRight,
  Bot,
  ChartColumn,
  Check,
  ChevronLeft,
  ChevronRight,
  Columns2,
  Cpu,
  FileCode,
  Gauge,
  Ghost,
  Globe,
  History,
  LayoutGrid,
  Link2,
  type LucideIcon,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  Minimize2,
  PanelLeft,
  Plug,
  Search,
  Settings2,
  Settings as SettingsIcon,
  Smartphone,
  Sparkles,
  SquareTerminal,
  Star,
  UserRound,
  Workflow as WorkflowIcon,
  X,
  Zap,
} from "lucide-react";
import {
  Fragment,
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
  type ProjectAgentInfo,
  type SidebarConfig,
} from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { useListMotion } from "../lib/list-motion.js";
import { useProjectSkills } from "../lib/skills.js";
import { useApps } from "../screens/app-screen.js";
import { resolveInput } from "../screens/browser-screen.js";
import { PILL_SURFACE } from "./context-pill.js";
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

/**
 * How a row's target opens, mirrored from the entry hints: ↵ opens in the
 * current tab, ⌘↵ in a new tab, ⌘⇧↵ tiled to the side of the current
 * view. Rows that can't tile (pure actions) treat "side" as "tab".
 */
type CommitMode = "replace" | "tab" | "side";

/**
 * Icons stay renderer-side (the shared registry is plain data usable by
 * the main process). Unknown ids — e.g. future plugin actions — fall back
 * to Zap.
 */
const ACTION_ICONS: Partial<Record<ActionId, LucideIcon>> = {
  "continue-on-mobile": Smartphone,
  "new-incognito-chat": Ghost,
  "new-floating-chat": MessageSquarePlus,
  "toggle-chat-minimized": Minimize2,
  "chat-to-tab": Maximize2,
  "prev-chat": MessageSquare,
  "next-chat": MessageSquare,
  "prev-tab": ChevronLeft,
  "next-tab": ChevronRight,
  "split-view": Columns2,
  "new-browser-tab": Globe,
  "reopen-tab": History,
  "new-terminal-tab": SquareTerminal,
  "new-editor-tab": FileCode,
  "toggle-sidebar": PanelLeft,
  "close-tab": X,
  "setup-agent": Bot,
  "default-agent": Bot,
  "switch-agent": Bot,
  "configure-agent": Settings2,
  "change-effort": Gauge,
  "switch-model": Cpu,
  "manage-connectors": Plug,
  "connect-remote-project": Link2,
};

/**
 * Pickers: palette-local flows where a command narrows the list to one
 * question ("which agent?", "which effort?"). Same chip visual as the @
 * modes; Backspace on empty input pops back out.
 */
export type PaletteInPicker =
  | "default-agent"
  | "switch-agent"
  | "configure-agent"
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
  "configure-agent": {
    chip: "Configure",
    icon: Settings2,
    placeholder: "Pick an agent to configure…",
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
  "configure-agent": "configure-agent",
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

/** Kind labels for PROJECT agents (committed definitions, ADR 0050). */
const PROJECT_KIND_LABELS: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  builtin: "Built-in",
  acp: "ACP",
  "e2e-fake": "Fake harness",
};

/** Faded detail for a project-agent row: kind + consent state (or error). */
function projectAgentDetail(agent: ProjectAgentInfo): string {
  if (agent.invalid) return agent.invalid;
  const kind = PROJECT_KIND_LABELS[agent.kind] ?? agent.kind;
  const state =
    agent.consent === "none"
      ? "needs approval"
      : agent.consent === "stale"
        ? "changed — approve again"
        : agent.credentialsSource === "secret"
          ? "project secret"
          : "approved";
  return `${kind} · ${state}`;
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
  {
    id: "xhigh",
    label: "Extra-high effort",
    description: "Extended reasoning (Codex's deepest)",
  },
  {
    id: "max",
    label: "Max effort",
    description: "Deepest reasoning (Claude; elsewhere runs as extra-high)",
  },
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
  /**
   * Picker rows: this row IS the active choice (current model/agent/
   * effort). Renders a quiet check + "current" chip on the right, and the
   * unfiltered picker list pins it first (normal ranking while searching).
   */
  current?: boolean;
  /**
   * Scope label rendered above this row when the previous row carries a
   * different group (e.g. "Project agents" in the agent pickers).
   */
  group?: string;
  /** Unusable rows (invalid project agents): visible, never committable. */
  disabled?: boolean;
  /** Navigate items load something tab-shaped and honor the commit mode. */
  kind: "action" | "navigate";
  run: (mode: CommitMode) => void;
}

/**
 * Unfiltered picker lists open with the active choice on top — "what runs
 * today" must be visible before picking. Stable sort: everything else
 * keeps its order. Searching skips this (normal ranking; the check chip
 * still marks the current row wherever it lands).
 */
const pinCurrentFirst = (rows: PaletteItem[]): PaletteItem[] =>
  [...rows].sort(
    (a, b) => Number(b.current ?? false) - Number(a.current ?? false),
  );

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

/**
 * The New Tab page's quiet cheat sheet: the workhorse shortcuts that have
 * no button anywhere in the chrome (Cmd+M, Cmd+\, Ctrl+`, …). Derived from
 * the live keybindings so a rebind updates the page. Deliberately faint —
 * furniture, not content.
 */
const NEW_TAB_HINT_ACTIONS: KeybindingAction[] = [
  "toggle-chat-minimized",
  "chat-to-tab",
  "split-view",
  "new-terminal-tab",
  "reopen-tab",
  "next-tab",
];

function NewTabShortcutHints({
  keybindings,
}: {
  keybindings: Record<KeybindingAction, string>;
}) {
  return (
    <div className="mt-10 grid shrink-0 grid-cols-2 gap-x-12 gap-y-2.5">
      {NEW_TAB_HINT_ACTIONS.map((action) => {
        const definition = BUILTIN_ACTIONS.find((entry) => entry.id === action);
        if (!definition) return null;
        return (
          <div
            key={action}
            className="flex items-center justify-between gap-6 text-[11px] text-fg-faint"
          >
            <span>{definition.label}</span>
            <kbd className="rounded border border-border bg-bg-inset px-1.5 py-0.5 font-sans text-[10px]">
              {formatBinding(keybindings[action])}
            </kbd>
          </div>
        );
      })}
    </div>
  );
}

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
  onRunSkill,
  actionHandlers,
  agents,
  defaultAgentId,
  focusedChat,
  onPickDefaultAgent,
  onPickSessionAgent,
  onPickProjectAgent,
  onConfigureAgent,
  defaultAgentOverridden,
  onClearDefaultOverride,
  onPickEffort,
  onPickModel,
  onHighlightTarget,
  pickerRequest,
  incognitoAllowed = true,
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
  onOpenTab: (tab: WorkspaceTab, mode?: "side") => void;
  onOpenSession: (session: AgentSession) => void;
  onSelectProject: (id: string) => void;
  onSwitchProfile: (profile: Profile) => void;
  onSendToAgent: (message: string, mode: "float" | "tab") => void;
  /**
   * A skill row was committed: send its invocation message to an agent —
   * into the focused chat when one exists, else a new chat in `mode`.
   */
  onRunSkill: (name: string, mode: "float" | "tab") => void;
  /** One handler per registry action — the same map the shortcuts use. */
  actionHandlers: Record<ActionId, (mode?: "side") => void>;
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
  /**
   * A project agent was picked. The app runs the consent flow first when
   * the definition isn't approved (or approval went stale), then applies
   * the same default/session switch the profile-agent handlers do.
   */
  onPickProjectAgent: (
    agent: ProjectAgentInfo,
    target: "default" | "session",
  ) => void;
  /** A configure-picker row was committed: open the agent's modal. */
  onConfigureAgent: (agentId: string) => void;
  /** This user's per-project default override is set (ADR 0056). */
  defaultAgentOverridden?: boolean;
  /** Clear that override, falling back to the project/global layers. */
  onClearDefaultOverride?: () => void;
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
  /** Project policy (ADR 0062): hide the incognito command when false. */
  incognitoAllowed?: boolean;
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

  // The ACTIVE project's committed agent definitions (ADR 0050), fetched
  // fresh on every entry into an agent picker — definitions are files a
  // collaborator (or an agent) may have just written, and consent state
  // changes with approvals; a stale snapshot would show the wrong rows.
  const [projectAgents, setProjectAgents] = useState<ProjectAgentInfo[]>([]);
  useEffect(() => {
    if (
      picker !== "default-agent" &&
      picker !== "switch-agent" &&
      picker !== "configure-agent"
    ) {
      return;
    }
    let cancelled = false;
    void desktopApi
      .projectAgentsList(projectId)
      .then((data) => {
        if (!cancelled) setProjectAgents(data.agents);
      })
      .catch(() => {
        if (!cancelled) setProjectAgents([]);
      });
    return () => {
      cancelled = true;
    };
  }, [picker, projectId]);

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
  // Fresh on every open, like history below: skills are files an agent or
  // collaborator may have just written. The tab variant is always "open",
  // so a new query session (empty → typing) is its refresh moment.
  const [skillsRefresh, setSkillsRefresh] = useState(0);
  const hasQuery = query.trim() !== "";
  useEffect(() => {
    if (open) setSkillsRefresh((count) => count + 1);
  }, [open]);
  useEffect(() => {
    if (hasQuery) setSkillsRefresh((count) => count + 1);
  }, [hasQuery]);
  const skills = useProjectSkills(
    projectId,
    variant === "tab" || open,
    skillsRefresh,
  );

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

  // A palette tab is the only thing on its page, so returning to the
  // window (Cmd+Tab, a click from another app) should land the caret in
  // the input without an extra click. Guarded on "nothing else grabbed
  // focus" so a split-pane neighbor's input is never robbed.
  useEffect(() => {
    if (variant !== "tab") return;
    const onWindowFocus = () => {
      requestAnimationFrame(() => {
        const active = document.activeElement;
        if (!active || active === document.body) inputRef.current?.focus();
      });
    };
    window.addEventListener("focus", onWindowFocus);
    return () => window.removeEventListener("focus", onWindowFocus);
  }, [variant]);

  // Focus on open; reset the query after the exit transition so the list
  // doesn't visibly re-expand while the panel is still fading out (the
  // cmdk trick, minus its 500ms — ours matches the 200ms transition).
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
      listMotionRef.current.reset();
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
  const actionItems = useMemo<PaletteItem[]>(() => {
    const available = BUILTIN_ACTIONS.filter(
      (action: ActionDefinition) =>
        !action.hiddenInPalette &&
        // Session-scoped: only offered while a chat is focused.
        (action.id !== "switch-agent" || hasFocusedChat) &&
        // Project policy (ADR 0062): incognito may be disabled here.
        (action.id !== "new-incognito-chat" || incognitoAllowed),
    );
    // With a chat focused, the commands that act on THAT chat lead the
    // list — they're what "change the agent/model/effort" almost always
    // means in the moment, and ties in fuzzy scores resolve by this order.
    const chatScoped = new Set([
      "switch-agent",
      "switch-model",
      "change-effort",
    ]);
    const ordered = hasFocusedChat
      ? [
          ...available.filter((action) => chatScoped.has(action.id)),
          ...available.filter((action) => !chatScoped.has(action.id)),
        ]
      : available;
    return ordered.map((action) => {
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
          : (mode) =>
              actionHandlersRef.current[action.id](
                mode === "side" ? "side" : undefined,
              ),
      };
    });
  }, [keybindings, hasFocusedChat, enterPicker, incognitoAllowed]);

  // Skills as commands (ADR 0052): a row is just a message send — into the
  // focused chat when one exists (an action, chat highlighted like other
  // scoped commands), else a new chat that honors the commit mode.
  const skillItems = useMemo<PaletteItem[]>(
    () =>
      skills.map((skill) => ({
        id: `skill:${skill.name}`,
        icon: Sparkles,
        // The pretty title fronts the row; the slug stays a keyword so
        // technical users typing the exact name still hit it.
        label: skill.title,
        detail: skill.source === "host" ? "App skill" : "Skill",
        keywords: [
          skill.name,
          skill.title,
          "skill",
          "use",
          ...skill.description.split(/\s+/).slice(0, 12),
        ],
        kind: hasFocusedChat ? ("action" as const) : ("navigate" as const),
        run: (mode) => onRunSkill(skill.name, mode === "tab" ? "tab" : "float"),
      })),
    [skills, hasFocusedChat, onRunSkill],
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
        run: (mode) =>
          onOpenTab(
            { kind: "workflow", name: workflow.name, label },
            mode === "side" ? "side" : undefined,
          ),
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
        run: (mode) =>
          onOpenTab(
            { kind: "app", name: app.name },
            mode === "side" ? "side" : undefined,
          ),
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
    items.push({
      id: "tab:usage",
      icon: ChartColumn,
      label: "Usage",
      detail: "Tokens and cost across agents",
      keywords: ["usage", "cost", "tokens", "spend", "billing", "consumption"],
      kind: "navigate",
      run: () => onOpenTab({ kind: "usage", name: "usage", label: "Usage" }),
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
        const modelRow = (model: OpenRouterCatalog["models"][number]) =>
          ({
            id: `pick:model:${model.id}`,
            icon: Cpu,
            label: model.name,
            detail: `${model.id}${model.free ? " · free" : ""}`,
            keywords: [],
            kind: "action",
            ...(model.id === current ? { current: true } : {}),
            run: () => onPickModel(agent.id, model.id),
          }) satisfies PaletteItem;
        rows.push({
          id: "pick:model:",
          icon: Cpu,
          label: "Best free model (automatic)",
          detail: catalog?.bestFreeModelId ?? "resolved from the catalog",
          keywords: ["best", "free", "auto", "default"],
          kind: "action",
          ...(current === "" ? { current: true } : {}),
          run: () => onPickModel(agent.id, ""),
        });
        const models = (catalog?.models ?? [])
          .slice()
          .sort(
            (a, b) => Number(b.free) - Number(a.free) || b.created - a.created,
          );
        // The unfiltered list pins the CURRENT model right under the
        // automatic row — picking a model must show what runs today.
        // While searching, normal ranking applies (the check still marks
        // the current row wherever it lands).
        if (!trimmed && current) {
          const pinned = models.find((model) => model.id === current);
          rows.push(
            pinned
              ? modelRow(pinned)
              : {
                  id: `pick:model:${current}`,
                  icon: Cpu,
                  label: current,
                  keywords: [],
                  kind: "action",
                  current: true,
                  run: () => onPickModel(agent.id, current),
                },
          );
        }
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
              .filter((model) => model.free && model.id !== current)
              .sort((a, b) => b.created - a.created)
              .slice(0, 20);
        for (const model of matched.slice(0, 50)) {
          rows.push(modelRow(model));
        }
        return trimmed ? rows : pinCurrentFirst(rows);
      }
      // CLIs run their own default; Anthropic/OpenAI need an explicit id.
      if (agent.harness !== "ai-sdk") {
        rows.push({
          id: "pick:model:",
          icon: Cpu,
          label: "Harness default (automatic)",
          keywords: ["default", "auto"],
          kind: "action",
          ...(current === "" ? { current: true } : {}),
          run: () => onPickModel(agent.id, ""),
        });
      }
      // Supported values straight from the harness (Claude Code's own
      // catalog, `codex debug models`, or the provider's /v1/models).
      const supported =
        harnessModels?.agentId === agent.id ? harnessModels.models : [];
      const supportedRow = (model: HarnessModelInfo) =>
        ({
          id: `pick:model:${model.id}`,
          icon: Cpu,
          label: model.name,
          // Aliases ("sonnet") show the versioned id they resolve to.
          detail: model.resolvedId ?? model.id,
          keywords: [],
          kind: "action",
          ...(model.id === current ? { current: true } : {}),
          run: () => onPickModel(agent.id, model.id),
        }) satisfies PaletteItem;
      // A pinned model the harness didn't list still needs a visible row.
      const customCurrentRow: PaletteItem | null =
        current && !supported.some((model) => model.id === current)
          ? {
              id: `pick:model:${current}`,
              icon: Cpu,
              label: current,
              keywords: [],
              kind: "action",
              current: true,
              run: () => onPickModel(agent.id, current),
            }
          : null;
      const matchedSupported = trimmed
        ? supported
            .map((model) => ({
              model,
              score: commandScore(`${model.name} ${model.id}`, trimmed, []),
            }))
            .filter((entry) => entry.score > 0)
            .sort((a, b) => b.score - a.score)
            .map((entry) => entry.model)
        : // Unfiltered: pin the current model to the top of the list
          // (normal ranking takes over the moment the user types).
          supported
            .slice()
            .sort(
              (a, b) => Number(b.id === current) - Number(a.id === current),
            );
      if (customCurrentRow && !trimmed) rows.push(customCurrentRow);
      for (const model of matchedSupported.slice(0, 50)) {
        rows.push(supportedRow(model));
      }
      if (customCurrentRow && trimmed) rows.push(customCurrentRow);
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
      return trimmed ? rows : pinCurrentFirst(rows);
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
                detail: level.description,
                keywords: [level.id, "effort", "reasoning"],
                kind: "action" as const,
                // The three levels keep their low→high order; the check
                // alone marks the active one (no reordering).
                ...(level.id === current ? { current: true } : {}),
                run: () => onPickEffort(level.id),
              };
            })
          : [
              ...agents.map((agent) => {
                const isCurrent =
                  picker === "configure-agent"
                    ? false
                    : picker === "default-agent"
                      ? agent.id === defaultAgentId
                      : agent.id ===
                        ((focusedChat?.agentId ?? defaultAgentId) || "");
                return {
                  id: `pick:agent:${agent.id}`,
                  icon: picker === "configure-agent" ? Settings2 : Bot,
                  label: agent.name,
                  detail: `${agentSourceLabel(agent)} · ${agentAuthLabel(agent)}`,
                  keywords: [
                    agent.name,
                    agent.harness,
                    agent.provider ?? "",
                    agent.model,
                  ],
                  kind: "action" as const,
                  ...(isCurrent ? { current: true } : {}),
                  run: () =>
                    picker === "default-agent"
                      ? onPickDefaultAgent(agent.id)
                      : picker === "configure-agent"
                        ? onConfigureAgent(agent.id)
                        : onPickSessionAgent(agent.id),
                };
              }),
              // The active project's committed agents (ADR 0050), under
              // their own scope label. Invalid definitions stay visible —
              // disabled, with the error where the description goes — so
              // a typo'd file is diagnosable from the picker itself. The
              // configure picker keeps them clickable: its modal shows
              // the full error and where to fix it.
              ...projectAgents.map((agent) => {
                const isCurrent =
                  picker === "configure-agent"
                    ? false
                    : picker === "default-agent"
                      ? agent.id === defaultAgentId
                      : agent.id ===
                        ((focusedChat?.agentId ?? defaultAgentId) || "");
                return {
                  id: `pick:agent:${agent.id}`,
                  icon: picker === "configure-agent" ? Settings2 : Bot,
                  label: agent.name,
                  detail: projectAgentDetail(agent),
                  keywords: [agent.name, agent.slug, "project", agent.kind],
                  kind: "action" as const,
                  group: "Project agents",
                  ...(isCurrent ? { current: true } : {}),
                  ...(agent.invalid && picker !== "configure-agent"
                    ? { disabled: true }
                    : {}),
                  run: () => {
                    if (picker === "configure-agent") {
                      onConfigureAgent(agent.id);
                      return;
                    }
                    if (agent.invalid) return;
                    onPickProjectAgent(
                      agent,
                      picker === "default-agent" ? "default" : "session",
                    );
                  },
                };
              }),
              // Layered defaults (ADR 0056): while this user's per-project
              // override is set, offer the way back to the layers below.
              ...(picker === "default-agent" && defaultAgentOverridden
                ? [
                    {
                      id: "pick:agent-default-clear",
                      icon: Bot,
                      label: "Use the project's default",
                      detail:
                        "Clear your override for this project (falls back to the project, then your global default)",
                      keywords: ["clear", "project", "default", "reset"],
                      kind: "action" as const,
                      run: () => onClearDefaultOverride?.(),
                    },
                  ]
                : []),
            ];
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
      // Agent pickers pin the current agent first while unfiltered; the
      // effort picker keeps its low→high order (three fixed rows).
      if (!trimmed) return picker === "effort" ? rows : pinCurrentFirst(rows);
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
      const commands = [
        ...actionItems,
        ...skillItems,
        ...projectItems,
        ...profileItems,
      ];
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
        ...skillItems,
        ...projectItems,
        ...profileItems,
        ...sidebarItems,
        ...historyItems.slice(0, 8),
      ];
    }

    const scored = [
      ...actionItems,
      ...skillItems,
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
    projectAgents,
    defaultAgentId,
    focusedChat,
    enterMode,
    actionItems,
    skillItems,
    projectItems,
    profileItems,
    sidebarItems,
    historyItems,
    onSendToAgent,
    onOpenUrl,
    onOpenTab,
    onPickDefaultAgent,
    onPickSessionAgent,
    onPickProjectAgent,
    onConfigureAgent,
    defaultAgentOverridden,
    onClearDefaultOverride,
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
  // 2. FLIP on surviving rows + fade-rise on new ones — the shared
  //    search-list motion in lib/list-motion (connector search uses the
  //    same hook, so every as-you-type list in the app moves alike).
  // biome-ignore lint/correctness/useExhaustiveDependencies: results is the "rows changed" signal; the refs are stable
  useLayoutEffect(() => {
    const list = listRef.current;
    const sizer = sizerRef.current;
    if (!list || !sizer) return;
    // Clamp to the visible max — animating toward the unclamped content
    // height would spend most of the tween past the max-h cutoff.
    const height = Math.min(sizer.offsetHeight, LIST_MAX_HEIGHT);
    list.style.setProperty("--palette-list-height", `${height}px`);
  }, [results]);
  // Colors stay in the list so the selection fade keeps working while
  // (and after) a row glides. First paint of the palette skips per-row
  // enters: the panel's own enter animation covers it.
  const listMotion = useListMotion(sizerRef, results, {
    keepTransitions: "background-color 100ms, color 100ms",
  });
  const listMotionRef = useRef(listMotion);
  listMotionRef.current = listMotion;

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
                selectedId === "action:switch-model" ||
                selectedId?.startsWith("skill:")
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

  const commit = (item: PaletteItem, withCmd: boolean, withShift = false) => {
    // Disabled rows (invalid project agents) are informational only.
    if (item.disabled) return;
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
    const commitMode: CommitMode =
      withCmd && withShift ? "side" : inTab || withCmd ? "tab" : "replace";
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
    } else if (event.key === "Enter" && (!event.shiftKey || event.metaKey)) {
      // Shift+Enter alone stays a newline; ⌘⇧↵ is the side commit.
      event.preventDefault();
      const item = results[selected];
      if (item) {
        commit(item, event.metaKey || event.ctrlKey, event.shiftKey);
      }
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
            className={`mt-[9px] flex shrink-0 items-center gap-1.5 overflow-hidden whitespace-nowrap py-1 pl-1.5 pr-2 ${PILL_SURFACE} ${
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
            // Scope labels ("Project agents") render above the first row
            // of a group. Plain divs without data-item-id, so the FLIP
            // machinery ignores them.
            const groupLabel =
              item.group && item.group !== results[index - 1]?.group
                ? item.group
                : null;
            return (
              <Fragment key={item.id}>
                {groupLabel && (
                  <div className="px-2.5 pt-2 pb-1 text-[11px] font-medium text-fg-faint">
                    {groupLabel}
                  </div>
                )}
                <button
                  data-item-id={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={item.disabled || undefined}
                  // mousedown so the textarea's focus never flickers away.
                  onMouseDown={(event) => {
                    event.preventDefault();
                    commit(item, event.metaKey, event.shiftKey);
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-100 ${
                    item.disabled
                      ? "cursor-default opacity-50"
                      : "cursor-pointer"
                  } ${isSelected ? "bg-bg-overlay text-fg" : "text-fg-muted"}`}
                >
                  <Icon className="size-4 shrink-0 text-fg-faint" />
                  <span className="truncate">{item.label}</span>
                  {item.detail && (
                    <span className="min-w-0 truncate text-[12px] text-fg-faint">
                      {item.detail}
                    </span>
                  )}
                  {item.current && (
                    <span
                      className="ml-auto flex shrink-0 items-center gap-1 text-[11px] text-fg-faint"
                      data-testid="palette-current"
                    >
                      <Check className="size-3.5" />
                      current
                    </span>
                  )}
                  {item.shortcut && (
                    <kbd className="ml-auto shrink-0 rounded border border-border bg-bg-inset px-1.5 py-0.5 text-[11px] text-fg-faint">
                      {item.shortcut}
                    </kbd>
                  )}
                </button>
              </Fragment>
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
        <FooterHint keycap="⌘⇧↵" label="side" />
      </footer>
    </div>
  );

  if (variant === "tab") {
    return (
      // items-center (not stretch): stretch would pull the panel to full
      // height — footer floating mid-card above a giant empty body
      // (invisible in dark themes, glaring in light).
      //
      // The page is the palette: clicking anywhere outside the panel puts
      // the caret back in the input (mousedown + preventDefault so focus
      // never leaves in the first place) — there is nothing else on this
      // page to focus.
      // biome-ignore lint/a11y/noStaticElementInteractions: background click-to-refocus; the input itself stays keyboard-reachable
      <div
        className="flex min-h-0 flex-1 flex-col items-center overflow-y-auto px-6 pb-6 pt-[12vh]"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) {
            event.preventDefault();
            inputRef.current?.focus();
          }
        }}
      >
        {panel}
        <NewTabShortcutHints keybindings={keybindings} />
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
      {/* The wrapper spans the full width to center the panel; it must not
          eat clicks beside the panel (the panel re-enables pointer events),
          or click-away only worked above/below the panel's vertical band. */}
      <div
        className={`pointer-events-none relative flex w-full origin-top justify-center transition-[opacity,translate,scale] duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${
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
