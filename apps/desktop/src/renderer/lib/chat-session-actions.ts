import type { ContextMenuEntry } from "../components/sidebar-item-row.js";

export type ChatSessionAction =
  | "mark-read"
  | "mark-unread"
  | "archive"
  | "unarchive";

export interface ChatSessionMenuEntry extends ContextMenuEntry {
  action: ChatSessionAction;
}

/** One action vocabulary shared by sidebar session rows and dock bubbles. */
export function chatSessionMenu(args: {
  unread: boolean;
  archived: boolean;
}): ChatSessionMenuEntry[] {
  return [
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
