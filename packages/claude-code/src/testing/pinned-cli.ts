import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";

/**
 * The Claude Code CLI the pinned Agent SDK ships for this platform: what
 * fixtures are recorded with and live tests run, never whatever `claude`
 * happens to be on the PATH. Undefined where the SDK ships none.
 */
export function pinnedClaudeExecutable(): string | undefined {
  const require = createRequire(import.meta.url);
  let sdk: string;
  try {
    sdk = require.resolve("@anthropic-ai/claude-agent-sdk");
  } catch {
    return undefined;
  }
  const fromSdk = createRequire(sdk);
  const base = `@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}`;
  for (const name of [base, `${base}-musl`]) {
    try {
      const manifest = fromSdk.resolve(`${name}/package.json`);
      const binary = path.join(
        path.dirname(manifest),
        process.platform === "win32" ? "claude.exe" : "claude",
      );
      if (existsSync(binary)) return binary;
    } catch {
      // Not this variant.
    }
  }
  return undefined;
}
