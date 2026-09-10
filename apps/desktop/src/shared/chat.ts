import type { OpenMode, OpenModifiers } from "./open-mode.js";

export interface ChatSignals {
  working?: boolean;
  unread?: boolean;
  draft?: boolean;
  awaitingInput?: boolean;
}

export type ChatMode = "min" | "partial" | "tab";

/**
 * A workspace tab attached to this chat — the agent's working surfaces
 * (browser pages it linked, terminals for its project, files it changed) —
 * or a live activity the chat itself tracks (subagents at work, background
 * processes the agent started or left running).
 */
/**
 * A workspace tab attached to this chat — the agent's working surfaces
 * (browser pages it linked, terminals for its project, files it changed) —
 * or a live activity the chat itself tracks (subagents at work, background
 * processes the agent started or left running).
 */
export interface ChatSurface {
  /** Workspace tab key ("browser:<id>" / "terminal:<id>" / "chat:<id>"). */
  key: string;
  kind:
    | "browser"
    | "terminal"
    | "editor"
    | "chat"
    | "subagent"
    | "watcher"
    | "app"
    | "workflow"
    | "mcpapp";
  label: string;
  faviconUrl?: string | null;
  /** The agent is actively working here (spinner on the chip). */
  active?: boolean;
  /**
   * The agent opened this surface in the BACKGROUND (open_surface while
   * the user was on another tab): the chip carries an accent dot with
   * the waiting-state pulse (the question badge's sanctioned loop —
   * indeterminate until the user answers) until the user opens the
   * surface. Dismissal-by-interaction, like point_at's glow.
   */
  attention?: boolean;
  /**
   * Detail lines opened in an upward popover on click. Chips with `info`
   * aren't workspace tabs — the popover IS their surface (a subagent's
   * activity feed, a watcher's command).
   */
  info?: string[];
  /** MCP app chips: the view to open when clicked. */
  mcpApp?: McpAppRef;
  /** The chip owns a workspace resource that can be explicitly disposed. */
  removable?: boolean;
}

/** An MCP Apps view reachable from a chat's tool call. */
export interface McpAppRef {
  toolKey: string;
  toolUseId: string;
  title: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

export interface ChatDockEntry {
  localId: string;
  sessionId?: string;
  mode: ChatMode;
  /** Local-only session (ADR 0062): never mirrored to a linked remote. */
  incognito?: boolean;
  /**
   * The chat this one was forked from, when the parent is (or was) open
   * in this workspace — puts the fork on the parent's surfaces rail.
   */
  parentLocalId?: string;
  /** Auto-sent as the first message on mount (palette "Send to agent"). */
  pendingMessage?: string;
  /**
   * Agent picked for this chat before its session exists (palette "Switch
   * agent" on a fresh chat). Once a session is live, the session row owns
   * the choice.
   */
  agentId?: string;
  /**
   * The chat's attached tabs are folded under its tab in the strip
   * (host-managed; only meaningful while the chat is a tab).
   */
  surfacesCollapsed?: boolean;
}

export interface ChatDockProps {
  projectName?: string;
  onCloseStarted?: () => void;
  projectId: string;
  entry: ChatDockEntry;
  title: string;
  placeholder?: string;
  /** Whether this chat's workspace tab occupies a view slot (tab mode). */
  tabActive: boolean;
  /** Keep this visible chat fresh when another client writes while it is idle. */
  refreshWhileIdle?: boolean;
  /**
   * Where the tab sits in the content view: the full area, or one half
   * of a split. Floating/minimized modes ignore it.
   */
  slot?: "full" | "left" | "right";
  /** Left pane's width fraction while the view is split. */
  splitRatio?: number;
  /** True while the split divider is being dragged (disables tweens). */
  splitResizing?: boolean;
  /**
   * How the bubble UI occupies the bottom edge while this chat is a tab:
   * "strip" = expanded centered strip (reserve bottom height), "corner" =
   * single collapsed bubble at the right (side padding only), "none".
   */
  bubbleClearance: "none" | "corner" | "strip";
  /**
   * A tab is visible behind the floating dock. While the agent works,
   * the dock lurks: it shrinks vertically to a strip showing the latest
   * activity so the tab stays readable, and expands on hover/focus.
   */
  backdropTab?: boolean;
  /** Profile-default agent for lazily created sessions. */
  defaultAgentId?: string;
  /**
   * A highlighted palette command targets this chat — accent the floating
   * dock's border so the command visibly points at it before Enter.
   */
  paletteTargeted?: boolean;
  /** Tabs attached to this chat, rendered as the surfaces rail. */
  surfaces?: ChatSurface[];
  /**
   * Open an attached surface: "tab" focuses it as a full tab, "split"
   * tiles it to the right of the current view.
   */
  onOpenSurface?: (key: string, mode: OpenMode | "split") => void;
  /** Permanently dispose an attached surface from its chip. */
  onRemoveSurface?: (key: string) => void;
  /** Open an MCP Apps view (a connection tool's ui:// template) as a tab. */
  onOpenMcpApp?: (view: McpAppRef, mode: OpenMode | "split") => void;
  /** Set while this tab is the unfocused pane of a split: click focuses. */
  onFocusRequest?: () => void;
  /**
   * Bumped by the host when the user re-invokes "chat" on this already
   * front chat (Cmd+N with a fresh chat open): the dock re-pulls the
   * editor selection as if it had just come to the front.
   */
  pullSelectionNonce?: number;
  /** Set while this tab sits in a split: return it to a full-width tab. */
  onUnsplit?: () => void;
  /**
   * Agent-message links and menus follow the shared resource-opening
   * grammar (ADR 0108), retaining the current chat and its draft.
   */
  onLinkClick?: (url: string, modifiers: OpenModifiers | OpenMode) => void;
  /** An edited-file row in the turn-step log was clicked — open the file. */
  onFileClick?: (path: string, modifiers?: OpenModifiers) => void;
  /** Fork the conversation from this assistant message (hover action). */
  onFork?: (messageId: string) => void;
  /** Fork at the latest settled message from the session inspector. */
  onForkCurrent?: () => void;
  /** Archive this conversation while preserving its transcript. */
  onArchive?: () => void;
  /** Profile-local presentation state for the inspector's toggle label. */
  archived?: boolean;
  /** Changing this opens and pins the shared session inspector. */
  inspectRequestNonce?: number;
  /** Set on forked chats: reveal the parent conversation. */
  onOpenParent?: () => void;
  /** Open the harness-backed picker for this session's model override. */
  onEditModel?: () => void;
  /** Open the session reasoning-effort picker. */
  onEditEffort?: () => void;
  runtimeSettingsError?: string | null;
  onEntryChange: (entry: ChatDockEntry) => void;
  /** Records the tab → floating Escape handoff for an immediate Cmd+W. */
  onEscapeToFloating?: (localId: string) => void;
  /** Close the chat entirely (dismissing an empty chat removes it). */
  onClose: (localId: string) => void;
  /**
   * Hands the host this dock's animated close, so external closers
   * (Cmd+W's close-surface) play the same 250ms collapse as Escape
   * instead of unmounting the dock mid-frame.
   */
  registerClose?: (close: () => void) => void;
  /**
   * Hands the host the staged tab-minimize (collapse tween first, mode
   * flip after), so external minimizers (Cmd+M) read the same as the
   * dock's own dash control.
   */
  registerMinimize?: (minimize: () => void) => void;
  /**
   * Hands the host this chat's live sender (palette skill rows, post-auth
   * continuations). Sends queue behind an in-flight turn like composer
   * sends do.
   */
  registerSend?: (send: (message: string) => void) => void;
  onSessionCreated: (localId: string, sessionId: string) => void;
  /**
   * The chat's live signals changed: the agent started/stopped working,
   * the composer gained/lost an unsent draft, or a question is waiting.
   * Drives every indicator surface (bubbles, tabs, notifications).
   */
  onSignalsChange: (
    localId: string,
    signals: Required<Pick<ChatSignals, "working" | "draft" | "awaitingInput">>,
  ) => void;
}
