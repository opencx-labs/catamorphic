export type ChatSessionAction =
  | "new-subsession"
  | "mark-read"
  | "mark-unread"
  | "archive"
  | "unarchive"
  /** A terminal in a remote chat's workspace (ADR 0208). */
  | "open-terminal"
  /** A server in a remote chat's workspace, in a browser tab (ADR 0208). */
  | "open-preview";

export interface ChatSessionMenuEntry {
  label: string;
  danger?: boolean;
  action: ChatSessionAction;
}
