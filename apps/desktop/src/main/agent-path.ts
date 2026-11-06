import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * The PATH an ACP agent runs with (ADR 0241): Work's own, then where
 * installers such as Hermes' put agents, should PATH not say.
 */
export function agentSearchPath(): string {
  return [process.env.PATH, path.join(os.homedir(), ".local", "bin")]
    .filter(Boolean)
    .join(path.delimiter);
}

/** Where an executable on the agent's PATH is, if it is there. */
export function findOnAgentPath(name: string): string | null {
  for (const dir of agentSearchPath().split(path.delimiter)) {
    if (!dir) continue;
    const file = path.join(dir, name);
    try {
      fs.accessSync(file, fs.constants.X_OK);
      return file;
    } catch {
      // Not here.
    }
  }
  return null;
}
