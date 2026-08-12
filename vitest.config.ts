import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));

function loadDotEnv(): Record<string, string> {
  try {
    const content = readFileSync(join(root, ".env"), "utf-8");
    const env: Record<string, string> = {};
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      env[trimmed.slice(0, eqIdx)] = trimmed
        .slice(eqIdx + 1)
        .replace(/^["']|["']$/g, "");
    }
    return env;
  } catch {
    return {};
  }
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    env: loadDotEnv(),
    pool: "threads",
    fileParallelism: true,
    // Whole-project ts-morph parses dominate these suites and slow an order
    // of magnitude when every package's tests run in parallel under turbo;
    // the 5s default reads as flakes under that contention.
    testTimeout: 30_000,
  },
});
