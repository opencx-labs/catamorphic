export type ChatSessionAction =
  | "new-subsession"
  | "mark-read"
  | "mark-unread"
  | "archive"
  | "unarchive";

export interface ChatSessionMenuEntry {
  label: string;
  danger?: boolean;
  action: ChatSessionAction;
}
