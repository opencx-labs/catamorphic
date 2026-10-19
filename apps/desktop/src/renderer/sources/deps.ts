import type { useCatamorphic } from "@catamorphic/react";
import type { QueryClient } from "@tanstack/react-query";
import type { ChatSessionAction } from "../../shared/chat-session-actions.js";
import type { OpenMode } from "../../shared/open-mode.js";
import type { WorkspaceTab } from "../lib/workspace-types.js";

export type ApiClient = ReturnType<typeof useCatamorphic>["apiClient"];

/**
 * What a window lends Work's own lists (ADR 0234): its live state and the
 * few things only it can do (close a tab, archive a chat). Read when a
 * source loads or acts, since the window changes between renders.
 */
export interface WorkSourceHost {
  /**
   * The chat beside the sidebar: what Work's chat-scoped lists show when
   * read without a section of their own (an app widget's grant, a module's
   * `work.read`).
   */
  sessionId?: string;
  tabs: readonly WorkspaceTab[];
  /** A chat tab and the tabs it opened, which nest under it. */
  tabGroups: readonly { parentKey: string; memberKeys: readonly string[] }[];
  activeTabKey?: string;
  unreadSessionIds: ReadonlySet<string>;
  agentName: (agentId: string | null | undefined) => string | undefined;
  closeTab: (key: string) => void;
  /** Move a tab before another in the strip (null: to the end). */
  reorderTab: (key: string, beforeKey: string | null) => void;
  sessionAction: (sessionId: string, action: ChatSessionAction) => void;
  openTab: (tab: WorkspaceTab, mode?: OpenMode) => void;
  /**
   * The tab in this window a page's or terminal's processes belong to
   * (ADR 0266); undefined when it is another window's, or no tab's.
   */
  resourceTab: (
    owner:
      | { kind: "page"; webContentsId: number }
      | { kind: "terminal"; terminalId: string },
  ) => string | undefined;
}

export interface WorkSourceDeps {
  projectId: string;
  profileId?: string;
  apiClient: ApiClient;
  queryClient: QueryClient;
  /** The viewer edits the project's program (`program:write`). */
  writesProgram: boolean;
  /** The project lives on a Work server (ADR 0055). */
  remote: boolean;
  host: () => WorkSourceHost;
  /** The window's own state changed: its tabs, or which chats were read. */
  onWindowChange: (
    topic: "tabs" | "unread",
    listener: () => void,
  ) => () => void;
}
