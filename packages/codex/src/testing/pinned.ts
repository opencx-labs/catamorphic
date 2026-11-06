import { createRequire } from "node:module";
import path from "node:path";

/**
 * The native Codex executable pinned through `@openai/codex-sdk`. Spawn it
 * directly so closing and joining a test transport owns the app-server,
 * rather than its JavaScript launcher.
 */
export function pinnedCodexCommand(): string {
  const platform = process.platform === "android" ? "linux" : process.platform;
  const targets: Record<string, string> = {
    "linux-x64": "x86_64-unknown-linux-musl",
    "linux-arm64": "aarch64-unknown-linux-musl",
    "darwin-x64": "x86_64-apple-darwin",
    "darwin-arm64": "aarch64-apple-darwin",
    "win32-x64": "x86_64-pc-windows-msvc",
    "win32-arm64": "aarch64-pc-windows-msvc",
  };
  const target = targets[`${platform}-${process.arch}`];
  if (!target)
    throw new Error(`Unsupported Codex platform: ${platform}-${process.arch}`);
  const codexRequire = createRequire(
    createRequire(import.meta.resolve("@openai/codex-sdk")).resolve(
      "@openai/codex/package.json",
    ),
  );
  return path.join(
    path.dirname(
      codexRequire.resolve(
        `@openai/codex-${platform}-${process.arch}/package.json`,
      ),
    ),
    "vendor",
    target,
    "bin",
    platform === "win32" ? "codex.exe" : "codex",
  );
}
