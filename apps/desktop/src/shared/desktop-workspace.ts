import type { ResolvedTheme } from "../main/theme.js";
import type {
  ChatDockEntry,
  ChatDockProps,
  ChatLiveSignals,
  McpAppRef,
} from "./chat.js";
import type { ChatSessionMenuEntry } from "./chat-session-actions.js";
import type { OpenMode, OpenModifiers } from "./open-mode.js";

export type DockData = Pick<
  ChatDockProps,
  | "projectId"
  | "entry"
  | "title"
  | "placeholder"
  | "tabActive"
  | "refreshWhileIdle"
  | "slot"
  | "splitRatio"
  | "splitResizing"
  | "bubbleClearance"
  | "backdropTab"
  | "defaultAgentId"
  | "paletteTargeted"
  | "chips"
  | "chipsModule"
  | "pullSelectionNonce"
  | "archived"
  | "inspectRequestNonce"
  | "runtimeSettingsError"
> & {
  selected?: boolean;
  local?: boolean;
  projectName: string;
  theme: ResolvedTheme | null;
  icon: string | null;
  fork: boolean;
  unread: boolean;
  attention: boolean;
  menu: ChatSessionMenuEntry[];
  visible: boolean;
};
export type ChatEvent =
  | { kind: "entry"; entry: ChatDockEntry }
  | { kind: "close" | "closing" }
  | { kind: "session"; sessionId: string }
  | { kind: "sessionAgent"; agentId: string; harness?: string }
  | { kind: "signals"; signals: ChatLiveSignals }
  | { kind: "surface"; key: string; mode: OpenMode | "split" }
  | { kind: "removeSurface"; key: string }
  | { kind: "customizeChips" }
  | { kind: "mcpApp"; view: McpAppRef; mode: OpenMode | "split" }
  | {
      kind: "link";
      url: string;
      modifiers: OpenModifiers | OpenMode;
    }
  | { kind: "file"; path: string; modifiers?: OpenModifiers }
  | { kind: "fork"; messageId: string }
  | { kind: "menu"; entry: ChatSessionMenuEntry }
  | {
      kind:
        | "forkCurrent"
        | "archive"
        | "editAgent"
        | "editModel"
        | "editEffort"
        | "editPermissionMode";
    }
  | { kind: "parent" | "focus" | "unsplit" | "escape" | "reveal" };
export interface DockCommand {
  projectId: string;
  localId: string;
  event: ChatEvent;
}
export interface DockSnapshot {
  chats: DockData[];
  activeProjectId?: string;
  activeChatId?: string;
  detached: boolean;
  multiProject: boolean;
  side: "left" | "right";
  placement: "left" | "center" | "right";
  /** The person's folded strip (prefs `dockCollapsed`). */
  collapsed: boolean;
}
/** Projects reserved for this workspace window before its renderer mounts. */
export interface WorkspaceInitial {
  projectIds: string[];
  activeProjectId?: string;
}

export interface WorkspaceNavigation {
  projectId: string;
  newWindow?: boolean;
  surface?: {
    url: string;
    title: string;
    mode: OpenMode;
    nonce: string;
    /**
     * How the url opens: a linked surface (default), an app page named by
     * the url ("downloads", "history", or "new-assistant": the agent
     * wizard, whose agent becomes the assistant), or a plain browser tab
     * at the url.
     */
    open?: "page" | "browser";
  };
}
export type WorkspaceEvent =
  | { kind: "flush"; requestId: string }
  | { kind: "forget"; projectId: string }
  | ({ kind: "navigate" } & WorkspaceNavigation)
  /**
   * A project this window keeps in the background is moving to a window
   * of its own: the window lets it go (`workspaceRelease`), unless it is
   * the one showing.
   */
  | { kind: "release"; projectId: string }
  | { kind: "chat"; command: DockCommand }
  /**
   * The dock asked for a chat: from its + (or the detached dock), which
   * keeps it in the dock, or Cmd+N in a workspace window (`shortcut`), which
   * a New Tab in front takes.
   */
  | { kind: "newChat"; projectId: string; shortcut?: boolean }
  | {
      kind: "dockAction";
      localId: string;
      action: DockAction;
      message?: string;
    };

/**
 * What a workspace asks of a chat it shows in a dock: close or minimize it,
 * send into it, focus its chips or its composer, or apply a palette skill
 * with its composer's pills (ADR 0270).
 */
export type DockAction =
  | "close"
  | "minimize"
  | "send"
  | "focusChips"
  | "focusComposer"
  | "previousMessage"
  | "nextMessage"
  | "skill";

export interface ChatDraft {
  message: string;
  attachments: import("@catamorphic/react").AgentChatAttachment[];
}
export interface ChatDraftUpdate {
  localId: string;
  draft: ChatDraft;
}
