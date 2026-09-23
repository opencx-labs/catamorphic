/** A background command as the chat shows it (ADR 0155). */
export interface BackgroundCommandView {
  id: string;
  projectId: string;
  sessionId: string;
  command: string;
  description: string;
  /** The terminal's workspace tab key (open it to watch). */
  key: string;
  status: "running" | "finished" | "stopped";
  exitCode: number | null;
  startedAt: number;
  endedAt: number | null;
}
