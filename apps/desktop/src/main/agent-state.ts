import { rm } from "node:fs/promises";
import path from "node:path";

const ID = /^[A-Za-z0-9_-]+$/;

/**
 * Where the runner of one chat keeps its harness's state (pasted media,
 * Codex's home): `<agentStateDir>/<projectId>/<sessionId>`. Host storage,
 * so none of it lands in the chat's checkout, its Git status, turn
 * checkpoints or remote sync.
 */
export function agentStateDirectory({
  agentStateDir,
  projectId,
  sessionId,
}: {
  agentStateDir: string;
  projectId: string;
  sessionId: string;
}): string {
  if (!ID.test(sessionId)) throw new Error("Invalid session");
  return path.join(
    projectStateDirectory({ agentStateDir, projectId }),
    sessionId,
  );
}

/**
 * Drops what one chat kept once it rests (archived or closed), or, without
 * a session, what every chat of a removed project kept. A chat's next turn
 * starts afresh: its harness's thread comes back from the session's stored
 * native state.
 */
export async function removeAgentState({
  agentStateDir,
  projectId,
  sessionId,
}: {
  agentStateDir: string;
  projectId: string;
  sessionId?: string;
}): Promise<void> {
  const directory =
    sessionId === undefined
      ? projectStateDirectory({ agentStateDir, projectId })
      : agentStateDirectory({ agentStateDir, projectId, sessionId });
  await rm(directory, { recursive: true, force: true });
}

function projectStateDirectory({
  agentStateDir,
  projectId,
}: {
  agentStateDir: string;
  projectId: string;
}): string {
  if (!ID.test(projectId)) throw new Error("Invalid project");
  return path.join(agentStateDir, projectId);
}
