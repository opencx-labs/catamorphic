import type { ChatSessionMenuEntry } from "../../shared/chat-session-actions.js";
import type { SidebarActionInput } from "../../shared/sidebar.js";

export type {
  ChatSessionAction,
  ChatSessionMenuEntry,
} from "../../shared/chat-session-actions.js";

/** One action vocabulary shared by sidebar session rows and dock bubbles. */
export function chatSessionMenu(args: {
  unread: boolean;
  archived: boolean;
  /**
   * The chat lives on its project's server, so a person can work in its
   * workspace beside the agent (ADR 0209).
   */
  remote?: boolean;
}): ChatSessionMenuEntry[] {
  return [
    { label: "Rename…", action: "rename" },
    ...(args.archived
      ? []
      : [
          {
            label: "New subsession",
            action: "new-subsession" as const,
          },
        ]),
    ...(args.remote && !args.archived
      ? [
          { label: "Open terminal", action: "open-terminal" as const },
          { label: "Open preview…", action: "open-preview" as const },
        ]
      : []),
    {
      label: args.unread ? "Mark as read" : "Mark as unread",
      action: args.unread ? "mark-read" : "mark-unread",
    },
    {
      label: args.archived ? "Unarchive" : "Archive",
      action: args.archived ? "unarchive" : "archive",
    },
  ];
}

/** What renaming a chat asks for: its name, the current one filled in. */
export function renameChatInput(title: string): SidebarActionInput {
  return {
    title: "Rename chat",
    submit: "Rename",
    fields: [{ name: "title", label: "Name", value: title }],
  };
}

/** The name typed for a chat, or why it cannot be one. */
export function chatName(values: Record<string, string> | undefined): string {
  const title = values?.title?.replace(/\s+/g, " ").trim() ?? "";
  if (!title) throw new Error("Name the chat.");
  return title;
}
