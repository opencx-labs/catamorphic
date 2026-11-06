export type ChatSessionAction =
  /** The person names the chat; it keeps the name (ADR 0247). */
  | "rename"
  | "new-subsession"
  | "mark-read"
  | "mark-unread"
  | "archive"
  | "unarchive"
  /** A terminal in a remote chat's workspace (ADR 0209). */
  | "open-terminal"
  /** A server in a remote chat's workspace, in a browser tab (ADR 0209). */
  | "open-preview";

export interface ChatSessionMenuEntry {
  label: string;
  danger?: boolean;
  action: ChatSessionAction;
}
