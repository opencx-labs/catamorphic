import type { AgentSession, ProjectSummary } from "@catamorphic/react/types";
import {
  createContext,
  type ReactNode,
  useContext,
  useMemo,
  useRef,
} from "react";
import type { ActionId } from "../../shared/actions.js";
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

/** Same contents, same identity: plain data rebuilt on every app render. */
function useStableData<T>(value: T): T {
  const ref = useRef(value);
  if (JSON.stringify(ref.current) !== JSON.stringify(value))
    ref.current = value;
  return ref.current;
}

/**
 * The app rebuilds the host object on every render. Navigation callbacks and
 * the data objects rows depend on (the focused chat, command availability,
 * macros) keep one identity while unchanged, so row indexes and the list's
 * motion do not rerun on unrelated renders.
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
  const navigation = useMemo(
    () => ({
      onOpenUrl: (...args: Parameters<PaletteHost["onOpenUrl"]>) =>
        latest.current.onOpenUrl(...args),
      onOpenTab: (...args: Parameters<PaletteHost["onOpenTab"]>) =>
        latest.current.onOpenTab(...args),
      onOpenSession: (...args: Parameters<PaletteHost["onOpenSession"]>) =>
        latest.current.onOpenSession(...args),
    }),
    [],
  );
  const focusedChat = useStableData(value.focusedChat);
  const actionAvailability = useStableData(value.actionAvailability);
  const terminalMacros = useStableData(value.terminalMacros);
  const host = useMemo(
    () => ({
      ...value,
      ...navigation,
      focusedChat,
      actionAvailability,
      terminalMacros,
    }),
    [value, navigation, focusedChat, actionAvailability, terminalMacros],
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
