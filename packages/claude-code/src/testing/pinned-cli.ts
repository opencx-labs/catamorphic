import { existsSync, readFileSync } from "node:fs";
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

/**
 * The Claude Code CLI version the pinned Agent SDK drives (its
 * `claudeCodeVersion`): the `@anthropic-ai/claude-code` release an image
 * installs for tests that run the CLI in a sandbox, never a newer one.
 */
export function pinnedClaudeCodeVersion(): string {
  const require = createRequire(import.meta.url);
  let directory = path.dirname(
    require.resolve("@anthropic-ai/claude-agent-sdk"),
  );
  for (;;) {
    const manifest = path.join(directory, "package.json");
    if (existsSync(manifest)) {
      const parsed: unknown = JSON.parse(readFileSync(manifest, "utf8"));
      if (
        parsed &&
        typeof parsed === "object" &&
        "name" in parsed &&
        parsed.name === "@anthropic-ai/claude-agent-sdk" &&
        "claudeCodeVersion" in parsed &&
        typeof parsed.claudeCodeVersion === "string"
      )
        return parsed.claudeCodeVersion;
    }
    const parent = path.dirname(directory);
    if (parent === directory)
      throw new Error("The pinned Agent SDK names no Claude Code version");
    directory = parent;
  }
}
