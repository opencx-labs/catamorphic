/**
 * Work an agent left running beside its chat, as the chat shows it: a
 * background command (ADR 0155) or a command watch (ADR 0156).
 */
export interface BackgroundCommandView {
  id: string;
  kind: "command" | "watch";
  projectId: string;
  sessionId: string;
  command: string;
  description: string;
  /** The terminal's workspace tab key (open it to watch); watches have none. */
  key: string | null;
  status: "running" | "finished" | "stopped";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}
