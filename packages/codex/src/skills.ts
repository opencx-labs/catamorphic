import { CodexAppServer } from "./app-server.js";

/** Fresh native skills, using the selected account and checkout. No model turn. */
export async function listCodexSkills({
  executable,
  env,
  workingDirectory,
  timeoutMs = 15_000,
}: {
  executable: string;
  env?: Record<string, string>;
  workingDirectory: string;
  timeoutMs?: number;
}) {
  const server = new CodexAppServer({ codexPathOverride: executable, env });
  const timeout = setTimeout(() => server.close(), timeoutMs);
  try {
    return await server.listSkills({ workingDirectory });
  } finally {
    clearTimeout(timeout);
    server.close();
  }
}
