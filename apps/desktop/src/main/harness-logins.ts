import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

// Focus, wake and login probes cluster, and a login watcher must still see
// fresh credentials within a beat, so the Keychain answer lives 3 seconds.
let keychainCache: { at: number; value: string | null } | null = null;

/**
 * Claude Code's default login on macOS lives in the Keychain. Read for this
 * machine's own sign-in checks; the value never leaves it (ADR 0199).
 */
export async function readClaudeKeychain(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  if (keychainCache && Date.now() - keychainCache.at < 3000)
    return keychainCache.value;
  let value: string | null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-w",
    ]);
    value = stdout;
  } catch {
    value = null;
  }
  keychainCache = { at: Date.now(), value };
  return value;
}
