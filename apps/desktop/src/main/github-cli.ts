import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export type GithubCliCommandRunner = (
  file: string,
  args: string[],
) => Promise<{ stdout: string }>;

/**
 * Read the github.com credential already held by `gh`. The CLI is only a
 * credential source: repository checks, cloning, sync, and pull requests all
 * continue through GithubService and the shared git engine.
 */
export async function githubCliToken(
  options: { run?: GithubCliCommandRunner } = {},
): Promise<string | null> {
  const run = options.run ?? runCommand;
  try {
    const result = await run("gh", [
      "auth",
      "token",
      "--hostname",
      "github.com",
    ]);
    return result.stdout.trim() || null;
  } catch {
    return null;
  }
}

async function runCommand(
  file: string,
  args: string[],
): Promise<{ stdout: string }> {
  const result = await execFileAsync(file, args, {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 64 * 1024,
    windowsHide: true,
  });
  return { stdout: String(result.stdout) };
}
