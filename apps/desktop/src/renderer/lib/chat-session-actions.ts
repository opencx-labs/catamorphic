import type { ChatSessionMenuEntry } from "../../shared/chat-session-actions.js";

export type {
  ChatSessionAction,
  ChatSessionMenuEntry,
} from "../../shared/chat-session-actions.js";

/** One action vocabulary shared by sidebar session rows and dock bubbles. */
export function chatSessionMenu(args: {
  unread: boolean;
  archived: boolean;
}): ChatSessionMenuEntry[] {
  return [
    ...(args.archived
      ? []
      : [
          {
            label: "New subsession",
            action: "new-subsession" as const,
          },
        ]),
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
