import type { AgentTextAttachment } from "@catamorphic/react";
import type { OpenMode, OpenModifiers } from "./open-mode.js";
import type { SidebarActivity } from "./sidebar.js";
import type { SidebarSourceItem } from "./sidebar-source.js";

/**
 * A first message sent on the user's behalf. The text is what the user
 * sees; structured context for the agent travels as attachments (pills),
 * never as prose in the visible message.
 */
export interface PendingChatMessage {
  text: string;
  attachments?: AgentTextAttachment[];
}

/** What a chat left running and waits on: a watch, subagents, a command. */
export type ChatWaiting = Exclude<SidebarActivity, "working">;

export interface ChatSignals {
  /** A turn runs (an agent working or waiting within it). */
  working?: boolean;
  unread?: boolean;
  draft?: boolean;
  awaitingInput?: boolean;
  /**
   * What its icon's lower corner says: working, or what it waits on (within
   * a turn or left running beside it); null for nothing.
   */
  activity?: SidebarActivity | null;
}

/** What a chat reports of itself whenever it changes. */
export type ChatLiveSignals = Required<
  Pick<ChatSignals, "working" | "draft" | "awaitingInput" | "activity">
>;

export type ChatMode = "min" | "partial" | "tab";

/** An MCP Apps view reachable from a chat's tool call. */
export interface McpAppRef {
  toolKey: string;
  toolUseId: string;
  title: string;
  toolInput?: unknown;
  toolResult?: unknown;
}

export interface ChatDockEntry {
  /** Transient target opened by a message notification. */
  focusMessageId?: string;
  localId: string;
  sessionId?: string;
  mode: ChatMode;
  /** Local-only session (ADR 0062): never mirrored to a linked remote. */
  incognito?: boolean;
  /**
   * Chosen before the chat's first message: that message gives it its own
   * worktree (ADR 0215), recorded before anything is sent, and again before
   * a resend if recording failed. Once the session exists, its checkout is
   * what the chat shows.
   */
  worktree?: boolean;
  /**
   * The chat this one was forked from, when the parent is (or was) open
   * in this workspace: puts the fork among the parent's chips.
   */
  parentLocalId?: string;
  /** Auto-sent as the first message on mount (palette "Send to agent"). */
  pendingMessage?: PendingChatMessage;
  /**
   * Placed in the composer on mount, for the person to finish or send
   * ("Customize chips"); consumed like `pendingMessage`.
   */
  draftMessage?: PendingChatMessage;
  /**
   * Started from the surface behind the dock (a workflow change request):
   * the dock opens folded without taking focus, so that surface stays in
   * view while the agent works. Consumed on mount.
   */
  watchBackdrop?: boolean;
  /**
   * Agent picked for this chat before its session exists (palette "Switch
   * agent" on a fresh chat). Once a session is live, the session owns the
   * choice and the entry follows it.
   */
  agentId?: string;
  /**
   * The harness used by the latest bound turn, as the dock last saw it.
   */
  harness?: string;
  model?: string;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
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
  /** A workspace tab is being dragged: visible chats offer an attachment target. */
  tabDragging?: boolean;
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
  /** Mounted in the detached dock window: OS blur counts as a backdrop. */
  nativeWindow?: boolean;
  /** Profile-default agent for lazily created sessions. */
  defaultAgentId?: string;
  /**
   * A highlighted palette command targets this chat — accent the floating
   * dock's border so the command visibly points at it before Enter.
   */
  paletteTargeted?: boolean;
  /**
   * What the chat holds in this workspace, as chips (ADR 0239): its forks
   * and subagents, the tabs it opened. The dock adds what it knows itself
   * (recorded pull requests, chips its agent attached, its turns' subagents
   * and app views) to make Work's chips.
   */
  chips?: SidebarSourceItem[];
  /**
   * The project's chips module (`chips.source` in workspace.js), when it
   * has one and may run it here: the dock draws what it returns instead.
   */
  chipsModule?: string;
  /** Open a chat that helps the person customize their chips. */
  onCustomizeChips?: () => void;
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
  /** Open the agent picker for this chat (agents it may switch to). */
  onEditAgent?: () => void;
  /** Open the harness-backed picker for this session's model override. */
  onEditModel?: () => void;
  /** Open the session reasoning-effort picker. */
  onEditEffort?: () => void;
  /** Open the permission-mode picker for this chat's agent (ADR 0182). */
  onEditPermissionMode?: () => void;
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
   * The chat starts leaving: its minimize or close plays its exit, however
   * it was asked for (Escape, its own controls, its bubble, a shortcut).
   * The bubble strip folds while it leaves instead of after.
   */
  onLeaveStarted?: () => void;
  /**
   * Hands the host a way to focus this chat's first chip (the focus-chips
   * shortcut), unfolding them; it says false when there is none.
   */
  registerFocusChips?: (focus: () => boolean) => void;
  /**
   * Hands the host this chat's live sender (post-auth continuations).
   * Sends queue behind an in-flight turn like composer sends do.
   */
  registerSend?: (send: (message: string) => void) => void;
  /**
   * Hands the host this chat's skill sender (ADR 0270): it sends like
   * `registerSend`, and takes the composer's attachments along when the
   * composer holds nothing else.
   */
  registerSkill?: (apply: (message: string) => void) => void;
  /** Hands the host a way to give this chat's composer the keys. */
  registerComposerFocus?: (focus: () => void) => void;
  onSessionCreated: (localId: string, sessionId: string) => void;
  /**
   * The agent the chat's session runs on and the harness its latest turn used,
   * recorded on its entry so pickers target them. Never activates the chat
   * or changes how it shows.
   */
  onSessionAgent?: (
    localId: string,
    session: { agentId: string; harness?: string },
  ) => void;
  /**
   * The chat's live signals changed: the agent started/stopped working,
   * the composer gained/lost an unsent draft, a question is waiting, or
   * what it left running changed. Drives every indicator surface
   * (bubbles, tabs, notifications).
   */
  onSignalsChange: (localId: string, signals: ChatLiveSignals) => void;
}
