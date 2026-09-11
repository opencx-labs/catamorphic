import { useAgentSessions, useWorkflows } from "@catamorphic/react";
import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import * as lucide from "lucide-react";
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  ChartColumn,
  Check,
  ChevronLeft,
  ChevronRight,
  CircleDot,
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
  RefreshCw,
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
  type ReactNode,
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
import type { FileSearchResult } from "../../shared/file-search.js";
import type { OpenMode as CommitMode } from "../../shared/open-mode.js";
import { SETTINGS_CATALOG } from "../../shared/settings-catalog.js";
import { sidebarSections } from "../../shared/sidebar.js";
import type { TerminalMacro } from "../../shared/terminal-macros.js";
import { effectiveEffort, supportedEfforts } from "../lib/agent-effort.js";
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
  projectAgentAsInfo,
  type SidebarConfig,
  type SidebarItem,
} from "../lib/desktop-api.js";
import { formatBinding, useKeybindings } from "../lib/keybindings.js";
import { useListMotion } from "../lib/list-motion.js";
import {
  createPaletteIndex,
  PALETTE_RESULT_LIMIT,
} from "../lib/palette-search.js";
import { useProjectSkills } from "../lib/skills.js";
import { NEW_WORKFLOW_PROMPT } from "../lib/workflow-authoring.js";
import { useApps } from "../screens/app-screen.js";
import { resolveInput } from "../screens/browser-screen.js";
import { PILL_SURFACE } from "./context-pill.js";
import { OpenResourceButton } from "./open-resource-button.js";
import { SiteFavicon } from "./site-favicon.js";
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

/**
 * Icons stay renderer-side (the shared registry is plain data usable by
 * the main process). Unknown ids — e.g. future plugin actions — fall back
 * to Zap.
 */
const ACTION_ICONS: Partial<Record<ActionId, LucideIcon>> = {
  "check-for-updates": RefreshCw,
  "session-status": CircleDot,
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
  "browser-back": ArrowLeft,
  "browser-forward": ArrowRight,
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
    description: "Deepest reasoning",
  },
];

export interface PaletteItem {
  id: string;
  icon: LucideIcon;
  iconNode?: ReactNode;
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
  /** Web rows saved as bookmarks carry a star at the right edge. */
  bookmarked?: boolean;
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
export type PaletteSearchRequest = { nonce: string } & (
  | { mode: "files" | "content" }
  | { mode: "section"; label: string; load: () => Promise<PaletteItem[]> }
);

export interface PaletteMode {
  id: "agent" | "web" | "settings" | "files" | "content" | "section";
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
    id: "files",
    trigger: "files",
    aliases: ["file"],
    chip: "Files",
    icon: FileCode,
    label: "Find files",
    description: "Find a filename in this project",
    placeholder: "Search filenames…",
  },
  {
    id: "content",
    trigger: "content",
    aliases: ["grep"],
    chip: "File content",
    icon: Search,
    label: "Search file content",
    description: "Find text and open its matching line",
    placeholder: "Search inside files…",
  },
  {
    id: "settings",
    trigger: "settings",
    aliases: ["preferences"],
    chip: "Settings",
    icon: SettingsIcon,
    label: "Search settings",
    description: "Find a setting and open its control",
    placeholder: "Search settings…",
  },
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
  actionAvailability,
}: {
  keybindings: Record<KeybindingAction, string>;
  actionAvailability?: Partial<Record<ActionId, boolean>>;
}) {
  const visibleActions = NEW_TAB_HINT_ACTIONS.filter(
    (action) => actionAvailability?.[action] !== false,
  );
  if (visibleActions.length === 0) return null;
  return (
    <div className="mt-10 grid shrink-0 grid-cols-2 gap-x-12 gap-y-2.5">
      {visibleActions.map((action) => {
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
  onOpenUrl: suppliedOnOpenUrl,
  onOpenTab: suppliedOnOpenTab,
  onOpenSession: suppliedOnOpenSession,
  onSelectProject,
  onSwitchProfile,
  onSendToAgent,
  startingActions,
  canCreateWorkflows = false,
  onRunSkill,
  actionHandlers,
  terminalMacros,
  onRunTerminalMacro,
  actionAvailability,
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
  searchRequest,
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
  projectId: string | undefined;
  profileId?: string;
  projects: ProjectSummary[];
  activeProjectId?: string;
  profiles: Profile[];
  activeProfileId?: string;
  sidebarConfig: SidebarConfig | null;
  onOpenUrl: (url: string, mode: CommitMode) => void;
  onOpenTab: (tab: WorkspaceTab, mode?: CommitMode) => void;
  onOpenSession: (session: AgentSession, mode?: CommitMode) => void;
  onSelectProject: (id: string) => void;
  onSwitchProfile: (profile: Profile) => void;
  onSendToAgent: (
    message: string,
    mode: "float" | "tab",
    agentId?: string,
  ) => void;
  /** Project-authored, caller-resolved zero-state actions. Empty means no UI. */
  startingActions: Array<{ label: string; prompt: string; agentId?: string }>;
  canCreateWorkflows?: boolean;
  /**
   * A skill row was committed: send its invocation message to an agent —
   * into the focused chat when one exists, else a new chat in `mode`.
   */
  onRunSkill: (name: string, mode: "float" | "tab") => void;
  /** One handler per registry action — the same map the shortcuts use. */
  actionHandlers: Record<ActionId, (mode?: CommitMode) => void>;
  terminalMacros: TerminalMacro[];
  onRunTerminalMacro: (macro: TerminalMacro, mode?: CommitMode) => void;
  /** False means the command cannot change the current workspace state. */
  actionAvailability?: Partial<Record<ActionId, boolean>>;
  /** The profile's configured agents (for the agent/effort pickers). */
  agents: AgentInfo[];
  defaultAgentId: string | null;
  /** The chat the session-scoped commands act on; null = none focused. */
  focusedChat: {
    agentId: string | null;
    model: string | null;
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
  onPickEffort: (effort: AgentEffort | null) => void;
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
  searchRequest?: PaletteSearchRequest | null;
  /** Project policy (ADR 0062): hide the incognito command when false. */
  incognitoAllowed?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [selectedIndex, setSelectedIndex] = useState(0);
  const navigation = useRef({
    onOpenUrl: suppliedOnOpenUrl,
    onOpenTab: suppliedOnOpenTab,
    onOpenSession: suppliedOnOpenSession,
  });
  navigation.current = {
    onOpenUrl: suppliedOnOpenUrl,
    onOpenTab: suppliedOnOpenTab,
    onOpenSession: suppliedOnOpenSession,
  };
  const onOpenUrl = useCallback(
    (...args: Parameters<typeof suppliedOnOpenUrl>) =>
      navigation.current.onOpenUrl(...args),
    [],
  );
  const onOpenTab = useCallback(
    (...args: Parameters<typeof suppliedOnOpenTab>) =>
      navigation.current.onOpenTab(...args),
    [],
  );
  const onOpenSession = useCallback(
    (...args: Parameters<typeof suppliedOnOpenSession>) =>
      navigation.current.onOpenSession(...args),
    [],
  );
  const [mode, setMode] = useState<PaletteMode | null>(null);
  const [sectionItems, setSectionItems] = useState<PaletteItem[]>([]);
  const [sectionError, setSectionError] = useState<string | null>(null);
  const [sectionLoading, setSectionLoading] = useState(false);
  const [sectionRetry, setSectionRetry] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry explicitly reloads the same scoped source
  useEffect(() => {
    if (!open || searchRequest?.mode !== "section") return;
    let active = true;
    setSectionItems([]);
    setSectionError(null);
    setSectionLoading(true);
    void searchRequest
      .load()
      .then((items) => {
        if (active) setSectionItems(items);
      })
      .catch((error: unknown) => {
        if (active)
          setSectionError(
            error instanceof Error
              ? error.message
              : "Could not load this section.",
          );
      })
      .finally(() => {
        if (active) setSectionLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, searchRequest, sectionRetry]);
  const [fileSearch, setFileSearch] = useState<FileSearchResult | null>(null);
  const [fileSearchError, setFileSearchError] = useState<string | null>(null);
  useEffect(() => {
    setFileSearch(null);
    setFileSearchError(null);
    if (
      !open ||
      !projectId ||
      (mode?.id !== "files" && mode?.id !== "content") ||
      !query.trim()
    )
      return;
    let cancelled = false;
    const searchMode = mode.id;
    const timer = window.setTimeout(() => {
      void desktopApi
        .fileSearch({ projectId, query, mode: searchMode })
        .then((result) => {
          if (!cancelled) setFileSearch(result);
        })
        .catch((error: unknown) => {
          if (!cancelled)
            setFileSearchError(
              error instanceof Error
                ? error.message
                : "Search failed. Try again.",
            );
        });
    }, 150);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      void desktopApi.cancelFileSearch().catch(() => {});
    };
  }, [open, projectId, mode?.id, query]);
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
    error?: string;
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
    if (!projectId) return;
    if (
      picker !== "default-agent" &&
      picker !== "switch-agent" &&
      picker !== "configure-agent" &&
      picker !== "model" &&
      picker !== "effort"
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
  const targetAgent = useMemo(
    () =>
      [...agents, ...projectAgents.map(projectAgentAsInfo)].find(
        (candidate) =>
          candidate.id === ((focusedChat?.agentId ?? defaultAgentId) || ""),
      ),
    [agents, projectAgents, focusedChat?.agentId, defaultAgentId],
  );

  useEffect(() => {
    if ((picker !== "model" && picker !== "effort") || !targetAgent) return;
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
      void desktopApi
        .agentModels(targetAgent.id)
        .then((data) => {
          if (!cancelled) {
            setHarnessModels({
              agentId: targetAgent.id,
              models: data.models,
              error: data.error,
            });
          }
        })
        .catch(() => {
          if (!cancelled)
            setHarnessModels({
              agentId: targetAgent.id,
              models: [],
              error: "Could not load models. Try again.",
            });
        });
    }
    return () => {
      cancelled = true;
    };
  }, [picker, catalog, harnessModels, targetAgent]);

  const effortModel =
    harnessModels?.agentId === targetAgent?.id
      ? harnessModels?.models.find(
          (model) =>
            model.id === (focusedChat?.model || targetAgent?.model) ||
            model.resolvedId === (focusedChat?.model || targetAgent?.model),
        )
      : undefined;

  // Keep the exiting list intact, but always start a fresh opening even if
  // the user reopens before its exit animation has finished. This precedes
  // pickerRequest so an explicit picker can initialize the fresh palette.
  useEffect(() => {
    const reset = () => {
      setQuery("");
      setSelectedIndex(0);
      setMode(null);
      setExitingMode(null);
      setPicker(null);
      setExitingPicker(null);
      listMotionRef.current.reset();
    };
    if (open) {
      reset();
      return;
    }
    const timer = setTimeout(reset, 250);
    return () => clearTimeout(timer);
  }, [open]);

  useLayoutEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => inputRef.current?.focus());
    const cancel = () => cancelAnimationFrame(frame);
    // The tab can finish mounting behind a newly opened chat. Once another
    // interaction owns focus, this delayed frame must not take it back.
    // Overlays intentionally claim focus as soon as they open.
    if (variant === "tab") {
      window.addEventListener("focusin", cancel);
      window.addEventListener("keydown", cancel, true);
      window.addEventListener("pointerdown", cancel, true);
    }
    return () => {
      cancel();
      window.removeEventListener("focusin", cancel);
      window.removeEventListener("keydown", cancel, true);
      window.removeEventListener("pointerdown", cancel, true);
    };
  }, [open, variant]);

  // Cmd+P agent commands open the overlay already inside a picker.
  useEffect(() => {
    if (variant !== "overlay" || !pickerRequest) return;
    enterPicker(pickerRequest.kind);
  }, [variant, pickerRequest, enterPicker]);
  useEffect(() => {
    if (variant !== "overlay" || !searchRequest) return;
    const next: PaletteMode | undefined =
      searchRequest.mode === "section"
        ? {
            id: "section",
            trigger: "",
            chip: searchRequest.label,
            label: searchRequest.label,
            icon: Search,
            description: "",
            placeholder: `Search ${searchRequest.label.toLowerCase()}…`,
          }
        : PALETTE_MODES.find((mode) => mode.id === searchRequest.mode);
    if (next) enterMode(next);
  }, [variant, searchRequest, enterMode]);

  const keybindings = useKeybindings();

  const workflows = useWorkflows(projectId).data ?? [];
  const apps = useApps(projectId).data ?? [];
  const sessions =
    useAgentSessions(projectId, { limit: 100 }).data?.items ?? [];
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
    if (!profileId || !projectId) return;
    let cancelled = false;
    void desktopApi.bookmarksGet({ projectId, profileId }).then((data) => {
      if (!cancelled) {
        setBookmarks([...data.pinned.bookmarks, ...data.project.bookmarks]);
      }
    });
    const unsubscribe = desktopApi.onBookmarksChanged((change) => {
      if (change.profileId !== profileId) return;
      // Profile-wide changes (projectId null, e.g. a browser import) have
      // no project scope attached — refetch the combined view.
      if (change.projectId === null) {
        void desktopApi.bookmarksGet({ projectId, profileId }).then((data) => {
          setBookmarks([...data.pinned.bookmarks, ...data.project.bookmarks]);
        });
        return;
      }
      if (change.projectId === projectId && change.project) {
        setBookmarks([...change.pinned.bookmarks, ...change.project.bookmarks]);
      }
    });
    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [projectId, profileId]);

  // Refetched on every open — the overlay stays mounted while closed, so
  // a mount-only fetch would serve stale history forever.
  const [history, setHistory] = useState<
    { url: string; title: string; faviconUrl?: string }[]
  >([]);
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

  // Action rows come straight from the shared registry — one entry there
  // yields the shortcut, the Settings row, the agent doc, and this row.
  // Handlers are read through a ref: the map is rebuilt every app render
  // (closures over fresh state), and letting it invalidate this memo
  // would cascade into the results memo and the FLIP pass per render.
  const actionHandlersRef = useRef(actionHandlers);
  actionHandlersRef.current = actionHandlers;
  const macroHandlerRef = useRef(onRunTerminalMacro);
  macroHandlerRef.current = onRunTerminalMacro;
  const hasFocusedChat = focusedChat !== null;
  const actionItems = useMemo<PaletteItem[]>(() => {
    const available = BUILTIN_ACTIONS.filter(
      (action: ActionDefinition) =>
        !action.hiddenInPalette &&
        actionAvailability?.[action.id as ActionId] !== false &&
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
    const commands = ordered.map((action): PaletteItem => {
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
          : (mode) => actionHandlersRef.current[action.id](mode),
      };
    });
    return [
      ...commands,
      ...terminalMacros.map(
        (macro): PaletteItem => ({
          id: `macro:${macro.id}`,
          icon: SquareTerminal,
          label: macro.name,
          detail: "Macro",
          keywords: ["macro", "terminal", macro.command],
          shortcut: formatBinding(macro.shortcut),
          kind: "action",
          run: (mode) => macroHandlerRef.current(macro, mode),
        }),
      ),
    ];
  }, [
    keybindings,
    hasFocusedChat,
    enterPicker,
    incognitoAllowed,
    terminalMacros,
    actionAvailability,
  ]);

  const startingActionItems = useMemo<PaletteItem[]>(
    () =>
      startingActions.map(
        (action, index): PaletteItem => ({
          id: `starter:${index}:${action.label}`,
          icon: Sparkles,
          label: action.label,
          detail: "Start with your project agent",
          keywords: [action.label, "start", "project", "agent"],
          kind: "navigate",
          run: (mode) =>
            onSendToAgent(
              action.prompt,
              mode === "tab" ? "tab" : "float",
              action.agentId,
            ),
        }),
      ),
    [startingActions, onSendToAgent],
  );

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
    if (canCreateWorkflows)
      items.push({
        id: "create-workflow",
        icon: WorkflowIcon,
        label: "Create workflow",
        detail: "Describe it to your agent",
        keywords: ["new", "workflow", "automation", "build"],
        kind: "action",
        run: (mode) =>
          onSendToAgent(NEW_WORKFLOW_PROMPT, mode === "tab" ? "tab" : "float"),
      });
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
          onOpenTab({ kind: "workflow", name: workflow.name, label }, mode),
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
        run: (mode) => onOpenTab({ kind: "app", name: app.name }, mode),
      });
    }
    for (const session of sessions) {
      if (session.visibility === "latent") continue;
      const created = new Date(session.createdAt);
      const label =
        session.title ??
        `Chat ${created.toLocaleDateString()} ${created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
      items.push({
        id: `session:${session.id}`,
        icon: MessageSquare,
        label,
        detail: session.visibility === "archived" ? "Archived chat" : "Chat",
        keywords: [
          label,
          "chat",
          "session",
          "conversation",
          ...(session.visibility === "archived" ? ["archived"] : []),
        ],
        kind: "navigate",
        run: (mode) => onOpenSession(session, mode),
      });
    }
    for (const bookmark of bookmarks) {
      items.push({
        id: `bookmark:${bookmark.id}`,
        icon: Globe,
        iconNode: (
          <SiteFavicon
            url={bookmark.url}
            faviconUrl={bookmark.faviconUrl}
            className="size-4"
          />
        ),
        label: bookmark.label,
        detail: hostOf(bookmark.url),
        keywords: [
          bookmark.label,
          hostOf(bookmark.url),
          bareUrl(bookmark.url),
          "bookmark",
        ],
        kind: "navigate",
        bookmarked: true,
        run: (mode) => onOpenUrl(bookmark.url, mode),
      });
    }
    const addCustomItems = (customItems: SidebarItem[] | undefined) => {
      for (const item of customItems ?? []) {
        if (item.url) {
          const url = item.url;
          items.push({
            id: `custom:${item.label}:${url}`,
            icon: lucideIcon(item.icon),
            iconNode: item.icon ? undefined : (
              <SiteFavicon url={url} className="size-4" />
            ),
            label: item.label,
            detail: hostOf(url),
            keywords: [item.label, hostOf(url), bareUrl(url), "link"],
            kind: "navigate",
            run: (mode) => onOpenUrl(url, mode),
          });
        }
        addCustomItems(item.items);
      }
    };
    for (const section of sidebarSections(sidebarConfig)) {
      if (section.type !== "custom") continue;
      addCustomItems(section.items);
    }
    items.push({
      id: "tab:settings",
      icon: SettingsIcon,
      label: "Settings",
      detail: "Open settings",
      keywords: ["settings", "preferences", "shortcuts", "theme", "keys"],
      kind: "navigate",
      run: (mode) =>
        onOpenTab(
          { kind: "settings", name: "settings", label: "Settings" },
          mode,
        ),
    });
    items.push({
      id: "tab:usage",
      icon: ChartColumn,
      label: "Usage",
      detail: "Tokens and cost across agents",
      keywords: ["usage", "cost", "tokens", "spend", "billing", "consumption"],
      kind: "navigate",
      run: (mode) =>
        onOpenTab({ kind: "usage", name: "usage", label: "Usage" }, mode),
    });
    return items;
  }, [
    canCreateWorkflows,
    onSendToAgent,
    workflows,
    apps,
    sessions,
    bookmarks,
    sidebarConfig,
    onOpenTab,
    onOpenSession,
    onOpenUrl,
  ]);

  const historyItems = useMemo<PaletteItem[]>(() => {
    const bookmarkedUrls = new Set(
      bookmarks.map((bookmark) => bookmark.url.replace(/\/$/, "")),
    );
    return history.map((entry) => ({
      id: `history:${entry.url}`,
      icon: Globe,
      iconNode: (
        <SiteFavicon
          url={entry.url}
          faviconUrl={entry.faviconUrl}
          className="size-4"
        />
      ),
      label: entry.title || entry.url,
      detail: hostOf(entry.url),
      keywords: [entry.title, hostOf(entry.url), bareUrl(entry.url)],
      kind: "navigate" as const,
      bookmarked: bookmarkedUrls.has(entry.url.replace(/\/$/, "")),
      run: (mode) => onOpenUrl(entry.url, mode),
    }));
  }, [history, bookmarks, onOpenUrl]);

  const settingItems = useMemo<PaletteItem[]>(
    () =>
      SETTINGS_CATALOG.map((setting) => ({
        id: `setting:${setting.id}`,
        label: setting.label,
        detail: `Settings · ${setting.category}`,
        icon: SettingsIcon,
        keywords: [
          "settings",
          "preferences",
          setting.category,
          ...setting.keywords,
        ],
        kind: "navigate",
        run: (mode) =>
          onOpenTab(
            {
              kind: "settings",
              name: "settings",
              label: "Settings",
              destination: { id: setting.id, requestId: crypto.randomUUID() },
            },
            mode,
          ),
      })),
    [onOpenTab],
  );
  const searchSettings = useMemo(
    () => createPaletteIndex(settingItems),
    [settingItems],
  );
  const searchEverything = useMemo(
    () =>
      createPaletteIndex([
        ...startingActionItems,
        ...actionItems,
        ...skillItems,
        ...projectItems,
        ...profileItems,
        ...sidebarItems,
        ...historyItems,
        ...settingItems,
      ]),
    [
      startingActionItems,
      actionItems,
      skillItems,
      projectItems,
      profileItems,
      sidebarItems,
      historyItems,
      settingItems,
    ],
  );
  const trimmed = query.trim();
  const allResults = useMemo<PaletteItem[]>(() => {
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
      // A focused session selects only its override. Empty means "inherit the
      // agent", even when that agent itself pins a concrete model.
      const current = focusedChat ? (focusedChat.model ?? "") : agent.model;
      const rows: PaletteItem[] = [];
      if (agent.harness === "ai-sdk" && agent.provider === "openrouter") {
        const modelRow = (model: OpenRouterCatalog["models"][number]) =>
          ({
            id: `pick:model:${model.id}`,
            icon: Cpu,
            label: model.name,
            detail: model.id,
            keywords: [],
            kind: "action",
            ...(model.id === current ? { current: true } : {}),
            run: () => onPickModel(agent.id, model.id),
          }) satisfies PaletteItem;
        rows.push({
          id: "pick:model:",
          icon: Cpu,
          label: focusedChat ? "Agent default" : "Automatic model",
          detail:
            focusedChat && agent.model
              ? agent.model
              : (catalog?.bestFreeModelId ?? "resolved from the catalog"),
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
      if (focusedChat || agent.harness !== "ai-sdk") {
        rows.push({
          id: "pick:model:",
          icon: Cpu,
          label: focusedChat ? "Agent default" : "Harness default (automatic)",
          detail: focusedChat && agent.model ? agent.model : undefined,
          keywords: ["default", "auto"],
          kind: "action",
          ...(current === "" ? { current: true } : {}),
          run: () => onPickModel(agent.id, ""),
        });
      }
      // Supported values straight from the harness (Claude Code's own
      // catalog, Codex app-server `model/list`, or the provider's /v1/models).
      const supported =
        harnessModels?.agentId === agent.id ? harnessModels.models : [];
      if (
        harnessModels?.agentId !== agent.id ||
        harnessModels.error ||
        supported.length === 0
      ) {
        rows.push({
          id: "pick:model:catalog-status",
          icon: Cpu,
          label:
            harnessModels?.agentId !== agent.id
              ? "Loading models…"
              : harnessModels.error
                ? "Could not load models"
                : "No models returned",
          detail: harnessModels?.error ?? "Refresh the model list",
          keywords: [],
          kind: "action",
          run: () => {
            setHarnessModels(null);
          },
        });
      }
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
          ? [
              ...(focusedChat
                ? [
                    {
                      id: "pick:effort:default",
                      icon: Gauge,
                      label: "Agent default",
                      detail:
                        effectiveEffort(
                          targetAgent,
                          targetAgent?.effort,
                          effortModel,
                        ) ?? "Unavailable",
                      keywords: ["default", "inherit", "effort"],
                      kind: "action" as const,
                      ...(focusedChat.effort === null ? { current: true } : {}),
                      run: () => onPickEffort(null),
                    },
                  ]
                : []),
              ...EFFORT_LEVELS.filter((level) =>
                supportedEfforts(targetAgent, effortModel).includes(level.id),
              ).map((level) => {
                const current = effectiveEffort(
                  targetAgent,
                  focusedChat ? focusedChat.effort : targetAgent?.effort,
                  effortModel,
                );
                return {
                  id: `pick:effort:${level.id}`,
                  icon: Gauge,
                  label: level.label,
                  detail: level.description,
                  keywords: [level.id, "effort", "reasoning"],
                  kind: "action" as const,
                  // Supported levels keep their low-to-high order; the check
                  // alone marks the active one (no reordering).
                  ...(level.id === current ? { current: true } : {}),
                  run: () => onPickEffort(level.id),
                };
              }),
            ]
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
      if (mode.id === "section" && searchRequest?.mode === "section") {
        if (sectionLoading || sectionError)
          return [
            {
              id: "section:status",
              icon: Search,
              label: sectionError ?? "Loading…",
              detail: sectionError ? "Press Enter to retry" : undefined,
              keywords: [],
              kind: "action",
              disabled: !sectionError,
              run: () => setSectionRetry((value) => value + 1),
            },
          ];
        return sectionItems
          .map((item) => ({
            item,
            score: trimmed
              ? commandScore(item.label, trimmed, [
                  item.detail ?? "",
                  ...item.keywords,
                ])
              : 1,
          }))
          .filter(({ score }) => score > 0)
          .sort((a, b) => b.score - a.score)
          .map(({ item }) => item);
      }
      if (mode.id === "settings") return searchSettings(trimmed);
      if (mode.id === "files" || mode.id === "content") {
        if (!fileSearch?.matches.length)
          return [
            {
              id: "files:status",
              disabled: true,
              icon: Search,
              label:
                fileSearchError ??
                (!trimmed
                  ? "Type to search this project"
                  : fileSearch
                    ? "No matches"
                    : "Searching…"),
              detail: fileSearch?.truncated
                ? "Search limit reached. Refine your query."
                : undefined,
              keywords: [],
              kind: "action",
              run: () => {},
            },
          ];
        return fileSearch.matches.map((match) => ({
          id: `file:${match.path}:${match.line ?? 0}`,
          icon: FileCode,
          label: match.line ? `${match.path}:${match.line}` : match.path,
          detail: match.text ?? "File",
          keywords: [],
          kind: "navigate",
          run: (commitMode) =>
            onOpenUrl(
              `file:${match.path}${match.line ? `:${match.line}` : ""}`,
              commitMode,
            ),
        }));
      }
      const modeQuery = trimmed;
      if (mode.id === "agent") {
        return [
          {
            id: "mode:agent",
            icon: Bot,
            label: "Ask agent",
            detail:
              [...agents, ...projectAgents.map(projectAgentAsInfo)].find(
                (agent) => agent.id === defaultAgentId,
              )?.name ?? (modeQuery ? undefined : "Type a message"),
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
      const modeRows = PALETTE_MODES.filter(
        (candidate) =>
          (projectId || candidate.id !== "agent") &&
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
        ...startingActionItems,
        ...actionItems,
        ...skillItems,
        ...projectItems,
        ...profileItems,
        ...sidebarItems,
        ...historyItems.slice(0, 8),
      ];
    }

    const scored = searchEverything(trimmed);

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
    const sendItems = projectId ? [sendItem] : [];
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
      return [webItem, ...scored, ...sendItems];
    }
    if (scored.length === 0 || multiline || query.length > LONG_QUERY) {
      return [...sendItems, ...scored, ...(webItem ? [webItem] : [])];
    }
    return [...scored, ...(webItem ? [webItem] : []), ...sendItems];
  }, [
    trimmed,
    searchRequest,
    sectionItems,
    sectionError,
    sectionLoading,
    fileSearch,
    fileSearchError,
    searchSettings,
    searchEverything,
    projectId,
    query,
    mode,
    picker,
    agents,
    projectAgents,
    defaultAgentId,
    focusedChat,
    enterMode,
    actionItems,
    startingActionItems,
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
    effortModel,
  ]);

  const results = useMemo(
    () => allResults.slice(0, PALETTE_RESULT_LIMIT),
    [allResults],
  );

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

  const commit = (
    item: PaletteItem,
    withCmd: boolean,
    withShift = false,
    floating = false,
  ) => {
    // Disabled rows (invalid project agents) are informational only.
    if (item.disabled) return;
    if (
      item.id === "pick:model:catalog-status" ||
      item.id === "section:status"
    ) {
      item.run("replace");
      return;
    }
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
    const commitMode: CommitMode = floating
      ? "floating"
      : withCmd && withShift
        ? "side"
        : inTab || withCmd
          ? "tab"
          : "replace";
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
      if (candidate && (projectId || candidate.id !== "agent")) {
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
    } else if (
      event.key === "Enter" &&
      (!event.shiftKey ||
        (/Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey))
    ) {
      // Shift+Enter alone stays a newline; ⌘⇧↵ is the side commit.
      event.preventDefault();
      const item = results[selected];
      if (item) {
        commit(
          item,
          /Mac/.test(navigator.platform) ? event.metaKey : event.ctrlKey,
          event.shiftKey,
          event.altKey && !event.metaKey && !event.ctrlKey,
        );
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
      className="pointer-events-auto flex w-full max-w-2xl flex-col overflow-hidden rounded-2xl border border-border bg-bg-raised shadow-2xl"
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
          {(mode?.id === "files" || mode?.id === "content") &&
            fileSearch &&
            (fileSearch.truncated ||
              fileSearch.matches.length > PALETTE_RESULT_LIMIT) && (
              <p role="status" className="px-4 py-2 text-xs text-fg-muted">
                Showing the first{" "}
                {Math.min(fileSearch.matches.length, PALETTE_RESULT_LIMIT)}{" "}
                matches. Refine your query to see more.
              </p>
            )}
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
                <OpenResourceButton
                  isResource={item.kind === "navigate"}
                  openOnMouseDown
                  data-item-id={item.id}
                  type="button"
                  role="option"
                  aria-selected={isSelected}
                  aria-disabled={item.disabled || undefined}
                  data-disabled-reason={item.disabled ? item.detail : undefined}
                  onOpen={(mode) =>
                    commit(
                      item,
                      mode === "tab" || mode === "side",
                      mode === "side",
                      mode === "floating",
                    )
                  }
                  // mousedown so the textarea's focus never flickers away.
                  onMouseDown={(event) => {
                    if (event.button !== 0) return;
                    event.preventDefault();
                  }}
                  onMouseEnter={() => setSelectedIndex(index)}
                  className={`flex h-9 w-full items-center gap-2.5 rounded-lg px-2.5 text-left text-[13px] transition-colors duration-100 ${
                    item.disabled
                      ? "cursor-default opacity-50"
                      : "cursor-pointer"
                  } ${isSelected ? "bg-bg-overlay text-fg" : "text-fg-muted"}`}
                >
                  {item.iconNode ?? (
                    <Icon className="size-4 shrink-0 text-fg-faint" />
                  )}
                  <span className="truncate">{item.label}</span>
                  {item.detail && (
                    <span className="min-w-0 truncate text-[12px] text-fg-faint">
                      {item.detail}
                    </span>
                  )}
                  {(item.bookmarked || item.current || item.shortcut) && (
                    <span className="ml-auto flex shrink-0 items-center gap-2 text-[11px] text-fg-faint">
                      {item.bookmarked && (
                        <Star
                          className="size-3.5 fill-current"
                          aria-label="Bookmarked"
                        />
                      )}
                      {item.current && (
                        <span
                          className="flex items-center gap-1"
                          data-testid="palette-current"
                        >
                          <Check className="size-3.5" />
                          current
                        </span>
                      )}
                      {item.shortcut && (
                        <kbd className="rounded border border-border bg-bg-inset px-1.5 py-0.5 text-[11px] text-fg-faint">
                          {item.shortcut}
                        </kbd>
                      )}
                    </span>
                  )}
                </OpenResourceButton>
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
        <FooterHint keycap="⌥↵" label="floating" />
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
        <NewTabShortcutHints
          keybindings={keybindings}
          actionAvailability={actionAvailability}
        />
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
