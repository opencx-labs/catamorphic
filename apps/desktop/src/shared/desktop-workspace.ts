import type { ResolvedTheme } from "../main/theme.js";
import type {
  ChatDockEntry,
  ChatDockProps,
  ChatSignals,
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
  | "surfaces"
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
  | {
      kind: "signals";
      signals: Required<
        Pick<ChatSignals, "working" | "draft" | "awaitingInput">
      >;
    }
  | { kind: "surface"; key: string; mode: OpenMode | "split" }
  | { kind: "removeSurface"; key: string }
  | { kind: "mcpApp"; view: McpAppRef; mode: OpenMode | "split" }
  | {
      kind: "link";
      url: string;
      modifiers: OpenModifiers | OpenMode;
    }
  | { kind: "file"; path: string; modifiers?: OpenModifiers }
  | { kind: "fork"; messageId: string }
  | { kind: "menu"; entry: ChatSessionMenuEntry }
  | { kind: "forkCurrent" | "archive" | "editModel" | "editEffort" }
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
}
export type WorkspaceEvent =
  | { kind: "navigate"; projectId: string }
  | { kind: "chat"; command: DockCommand }
  | { kind: "newChat"; projectId: string }
  | {
      kind: "dockAction";
      localId: string;
      action: "close" | "minimize" | "send";
      message?: string;
    };

export interface ChatDraft {
  message: string;
  attachments: import("@catamorphic/react").AgentChatAttachment[];
}
export interface ChatDraftUpdate {
  localId: string;
  draft: ChatDraft;
}
