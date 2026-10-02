import { createRequire } from "node:module";
import path from "node:path";

/**
 * The Codex CLI this package pins (through `@openai/codex-sdk`), as an
 * executable path: what transcripts are recorded from and what native
 * tests run.
 */
export function pinnedCodexCommand(): string {
  return path.join(
    path.dirname(
      createRequire(import.meta.resolve("@openai/codex-sdk")).resolve(
        "@openai/codex/package.json",
      ),
    ),
    "bin/codex.js",
  );
}
