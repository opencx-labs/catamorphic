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
  if (!ID.test(projectId)) throw new Error("Invalid project");
  if (!ID.test(sessionId)) throw new Error("Invalid session");
  return path.join(agentStateDir, projectId, sessionId);
}

/** Drops what a removed project's chats kept. */
export async function removeAgentState({
  agentStateDir,
  projectId,
}: {
  agentStateDir: string;
  projectId: string;
}): Promise<void> {
  if (!ID.test(projectId)) throw new Error("Invalid project");
  await rm(path.join(agentStateDir, projectId), {
    recursive: true,
    force: true,
  });
}
