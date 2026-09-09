import type { GitDiffMode } from "../../shared/git.js";
import type { SettingsDestination } from "../../shared/settings-catalog.js";

/**
 * Live activity signals mirrored onto a tab's icon — the same vocabulary
 * as the chat bubbles (chat-signals.tsx): spinner while working, dot for
 * unread, pencil for a draft (chat composer text, editor unsaved changes),
 * pulsing "?" for a waiting agent question.
 */
interface TabIndicators {
  /** Agent working → the icon cross-fades to a spinner. */
  working?: boolean;
  /** Response landed while the tab was hidden → dot on the icon. */
  unread?: boolean;
  /** A workflow requested user attention → pulsing dot on the icon. */
  attention?: boolean;
  /** Unsent draft (chat composer, editor changes) → pencil badge. */
  draft?: boolean;
  /** The agent asked and is waiting → pulsing "?" badge. */
  awaitingInput?: boolean;
  /** Chat group this tab belongs to (parent chat or attached surface). */
  groupId?: string;
  /** Secondary hover-card line: URL, file path, agent name … */
  detail?: string;
  bookmarkUrl?: string;
}

/** What a diff tab shows: a local working-tree diff, or a PR file patch. */
export type DiffSource =
  | {
      type: "local";
      worktreePath: string;
      filePath: string;
      mode: GitDiffMode;
      previousPath?: string;
      baseRef?: string;
    }
  | {
      type: "pr";
      prNumber: number;
      filePath: string;
      /** Unified-diff hunk text; null for binary or oversized files. */
      patch: string | null;
      status: string;
    };

export interface WorkflowDraft {
  filePath: string;
  code: string;
  baseline: string;
}

export type WorkspaceTab = (
  | {
      kind: "workflow";
      name: string;
      label?: string;
      workflowDraft?: WorkflowDraft;
    }
  | { kind: "app"; name: string; label?: string }
  | {
      kind: "chat";
      name: string;
      label?: string;
      /** Agent-chosen conversation icon ("<name>:<color>"). */
      chatIcon?: string | null;
      /** The chat is a fork of another conversation. */
      fork?: boolean;
    }
  | {
      kind: "browser";
      name: string;
      label?: string;
      faviconUrl?: string | null;
    }
  | {
      kind: "settings";
      name: string;
      label?: string;
      destination?: SettingsDestination;
    }
  | { kind: "profile-settings"; name: string; label?: string }
  | { kind: "usage"; name: string; label?: string }
  | { kind: "palette"; name: string; label?: string }
  | { kind: "agent-setup"; name: string; label?: string }
  | { kind: "terminal"; name: string; label?: string }
  | { kind: "editor"; name: string; label?: string }
  | {
      /** A read-only file diff (sidebar Changes / Pull Requests rows). */
      kind: "diff";
      name: string;
      label?: string;
      projectId: string;
      source: DiffSource;
    }
  | {
      /** An MCP Apps view (a connection tool's ui:// template). */
      kind: "mcpapp";
      name: string;
      label?: string;
      toolKey: string;
      toolInput?: unknown;
      toolResult?: unknown;
    }
) &
  TabIndicators & { chatLocalId?: string };

export const tabKey = (tab: WorkspaceTab) => `${tab.kind}:${tab.name}`;

export type ChatMode = "min" | "partial" | "tab";
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
