import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from "react";
import { type ActionId, BUILTIN_ACTIONS } from "../../shared/actions.js";
import type { PendingChatMessage } from "../../shared/chat.js";
import type { HistoryEntry } from "../../shared/history.js";
import type { OpenMode as CommitMode } from "../../shared/open-mode.js";
import type { TerminalMacro } from "../../shared/terminal-macros.js";
import type { WorkspaceConfig } from "../../shared/workspace-config.js";
import type { WorkspaceTab } from "../components/workspace-tabs.js";
import type {
  AgentEffort,
  AgentInfo,
  HarnessPermissions,
  Profile,
  ProjectAgentInfo,
} from "../lib/desktop-api.js";

/**
 * What a picked project agent becomes: the default, the focused chat's
 * agent.
 */
export type ProjectAgentTarget = "default" | "session";

/**
 * Everything the palette reads from the app: data, the focused context and
 * the actions rows run. Provided once around the app, so the overlay and
 * every palette tab read the same host (ADR 0186).
 */
export interface PaletteHost {
  projectId: string | undefined;
  profileId?: string;
  projects: ProjectSummary[];
  activeProjectId?: string;
  profiles: Profile[];
  activeProfileId?: string;
  workspaceConfig: WorkspaceConfig | null;
  onOpenUrl: (url: string, mode: CommitMode) => void;
  onOpenTab: (tab: WorkspaceTab, mode?: CommitMode) => void;
  onOpenSession: (session: AgentSession, mode?: CommitMode) => void;
  onSelectProject: (id: string) => void;
  onSwitchProfile: (profile: Profile) => void;
  onSendToAgent: (
    message: string | PendingChatMessage,
    mode: "float" | "tab",
    agentId?: string,
  ) => void;
  /** Project-authored, caller-resolved zero-state actions. Empty means no UI. */
  startingActions: Array<{ label: string; prompt: string; agentId?: string }>;
  /**
   * A skill was committed (ADR 0270): its invocation goes into the focused
   * chat ("chat"), else a new chat in a tab or floating. A new chat for an
   * agent's own command runs that agent.
   */
  onRunSkill: (input: {
    message: string;
    target: "chat" | "tab" | "float";
    agentId?: string;
  }) => void;
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
    /** Its checkout can carry its own harness settings. */
    sessionId: string | null;
    /** The harness its latest bound turn used; null before it starts. */
    harness: string | null;
    agentId: string | null;
    model: string | null;
    effort: AgentEffort | null;
  } | null;
  onPickDefaultAgent: (agentId: string) => void;
  onPickSessionAgent: (agentId: string) => void;
  /**
   * A project agent was picked. The app runs the consent flow first when
   * the definition isn't approved (or approval went stale), then applies
   * the same default or session pick the profile-agent handlers
   * do.
   */
  onPickProjectAgent: (
    agent: ProjectAgentInfo,
    target: ProjectAgentTarget,
  ) => void;
  /** A configure-picker row was committed: open the agent's modal. */
  onConfigureAgent: (agentId: string) => void;
  /** The agent the assistant is (ADR 0216); null is the built-in one. */
  voiceAssistant: string | null;
  /** The agent wizard, whose agent becomes the assistant. */
  onCreateAssistant: () => void;
  /** This user's per-project default override is set (ADR 0056). */
  defaultAgentOverridden?: boolean;
  /** Clear that override, falling back to the project/global layers. */
  onClearDefaultOverride?: () => void;
  onPickEffort: (effort: AgentEffort | null) => void;
  /** Change the target agent's model ("" = the automatic default). */
  onPickModel: (agentId: string, model: string) => void;
  /** Change a profile agent's harness permission mode (ADR 0182). */
  onPickHarnessPermissions: (
    agentId: string,
    patch: HarnessPermissions,
  ) => void;
  /**
   * The highlighted row targets a specific surface ("chat" = the focused
   * chat, "close" = whatever close-tab would close) — reported up so the
   * app can accent that surface's border while the row is highlighted.
   */
  onHighlightTarget?: (target: "chat" | "close" | null) => void;
  onOpenHistory: (entry: HistoryEntry, mode: CommitMode) => void;
  /** The site of the focused browser tab; its settings command leads. */
  focusedSite?: { origin: string; host: string } | null;
  onOpenSiteSettings?: (origin: string) => void;
  /** Project policy (ADR 0062): hide the incognito command when false. */
  incognitoAllowed?: boolean;
  /** Connected projects never run local source modules (ADR 0140). */
  memberShell?: boolean;
  /** A committed row failed after the palette closed (a mode's action). */
  onError?: (message: string) => void;
}

const PaletteHostContext = createContext<PaletteHost | null>(null);
const NO_PROFILES: Profile[] = [];
const NO_AGENTS: AgentInfo[] = [];

/** Same contents, same identity: plain data rebuilt on every app render. */
function useStableData<T>(value: T): T {
  const ref = useRef(value);
  if (JSON.stringify(ref.current) !== JSON.stringify(value))
    ref.current = value;
  return ref.current;
}

/**
 * The app rebuilds the host object on every render. Callbacks always run the
 * latest app state, without invalidating rows when their closures change.
 * Only changed palette data publishes a context update; a sidebar motion or
 * an unrelated chat update need not rebuild the palette's rows and indexes.
 */
export function PaletteHostProvider({
  value,
  children,
}: {
  value: PaletteHost;
  children: ReactNode;
}) {
  const latest = useRef(value);
  latest.current = value;
  const callbacks = useMemo(() => {
    const actionHandlers = { ...latest.current.actionHandlers };
    for (const action of BUILTIN_ACTIONS)
      actionHandlers[action.id] = (mode) =>
        latest.current.actionHandlers[action.id](mode);
    return {
      actionHandlers,
      onOpenUrl: (...args: Parameters<PaletteHost["onOpenUrl"]>) =>
        latest.current.onOpenUrl(...args),
      onOpenTab: (...args: Parameters<PaletteHost["onOpenTab"]>) =>
        latest.current.onOpenTab(...args),
      onOpenSession: (...args: Parameters<PaletteHost["onOpenSession"]>) =>
        latest.current.onOpenSession(...args),
      onSelectProject: (...args: Parameters<PaletteHost["onSelectProject"]>) =>
        latest.current.onSelectProject(...args),
      onSwitchProfile: (...args: Parameters<PaletteHost["onSwitchProfile"]>) =>
        latest.current.onSwitchProfile(...args),
      onSendToAgent: (...args: Parameters<PaletteHost["onSendToAgent"]>) =>
        latest.current.onSendToAgent(...args),
      onRunSkill: (...args: Parameters<PaletteHost["onRunSkill"]>) =>
        latest.current.onRunSkill(...args),
      onRunTerminalMacro: (
        ...args: Parameters<PaletteHost["onRunTerminalMacro"]>
      ) => latest.current.onRunTerminalMacro(...args),
      onPickDefaultAgent: (
        ...args: Parameters<PaletteHost["onPickDefaultAgent"]>
      ) => latest.current.onPickDefaultAgent(...args),
      onPickSessionAgent: (
        ...args: Parameters<PaletteHost["onPickSessionAgent"]>
      ) => latest.current.onPickSessionAgent(...args),
      onPickProjectAgent: (
        ...args: Parameters<PaletteHost["onPickProjectAgent"]>
      ) => latest.current.onPickProjectAgent(...args),
      onConfigureAgent: (
        ...args: Parameters<PaletteHost["onConfigureAgent"]>
      ) => latest.current.onConfigureAgent(...args),
      onCreateAssistant: () => latest.current.onCreateAssistant(),
      onClearDefaultOverride: () => latest.current.onClearDefaultOverride?.(),
      onPickEffort: (...args: Parameters<PaletteHost["onPickEffort"]>) =>
        latest.current.onPickEffort(...args),
      onPickModel: (...args: Parameters<PaletteHost["onPickModel"]>) =>
        latest.current.onPickModel(...args),
      onPickHarnessPermissions: (
        ...args: Parameters<PaletteHost["onPickHarnessPermissions"]>
      ) => latest.current.onPickHarnessPermissions(...args),
      onHighlightTarget: (target: "chat" | "close" | null) =>
        latest.current.onHighlightTarget?.(target),
      onOpenHistory: (...args: Parameters<PaletteHost["onOpenHistory"]>) =>
        latest.current.onOpenHistory(...args),
      onOpenSiteSettings: (origin: string) =>
        latest.current.onOpenSiteSettings?.(origin),
      onError: (message: string) => latest.current.onError?.(message),
    };
  }, []);
  const focusedChat = useStableData(value.focusedChat);
  const focusedSite = useStableData(value.focusedSite);
  const actionAvailability = useStableData(value.actionAvailability);
  const terminalMacros = useStableData(value.terminalMacros);
  const profiles = value.profiles.length ? value.profiles : NO_PROFILES;
  const agents = value.agents.length ? value.agents : NO_AGENTS;
  const {
    projectId,
    profileId,
    projects,
    activeProjectId,
    activeProfileId,
    workspaceConfig,
    startingActions,
    defaultAgentId,
    voiceAssistant,
    defaultAgentOverridden,
    incognitoAllowed,
    memberShell,
  } = value;
  const canClearDefault = Boolean(value.onClearDefaultOverride);
  const canHighlight = Boolean(value.onHighlightTarget);
  const canOpenSiteSettings = Boolean(value.onOpenSiteSettings);
  const canReportError = Boolean(value.onError);
  const host = useMemo<PaletteHost>(
    () => ({
      ...callbacks,
      projectId,
      profileId,
      projects,
      activeProjectId,
      profiles,
      activeProfileId,
      workspaceConfig,
      startingActions,
      agents,
      defaultAgentId,
      voiceAssistant,
      defaultAgentOverridden,
      incognitoAllowed,
      memberShell,
      focusedChat,
      focusedSite,
      actionAvailability,
      terminalMacros,
      onClearDefaultOverride: canClearDefault
        ? callbacks.onClearDefaultOverride
        : undefined,
      onHighlightTarget: canHighlight ? callbacks.onHighlightTarget : undefined,
      onOpenSiteSettings: canOpenSiteSettings
        ? callbacks.onOpenSiteSettings
        : undefined,
      onError: canReportError ? callbacks.onError : undefined,
    }),
    [
      callbacks,
      projectId,
      profileId,
      projects,
      activeProjectId,
      profiles,
      activeProfileId,
      workspaceConfig,
      startingActions,
      agents,
      defaultAgentId,
      voiceAssistant,
      defaultAgentOverridden,
      incognitoAllowed,
      memberShell,
      focusedChat,
      focusedSite,
      actionAvailability,
      terminalMacros,
      canClearDefault,
      canHighlight,
      canOpenSiteSettings,
      canReportError,
    ],
  );
  return (
    <PaletteHostContext.Provider value={host}>
      {children}
    </PaletteHostContext.Provider>
  );
}

export function usePaletteHost(): PaletteHost {
  const host = useContext(PaletteHostContext);
  if (!host) throw new Error("The palette needs a PaletteHostProvider.");
  return host;
}
