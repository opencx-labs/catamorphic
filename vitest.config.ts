import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { configDefaults, defineConfig } from "vitest/config";

const root = dirname(fileURLToPath(import.meta.url));
const modelCredentialVariables = [
  "ANTHROPIC_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
] as const;
const externalTestVariables = [
  "CATAMORPHIC_EXTERNAL_INTEGRATIONS",
  "CF_SANDBOX_INTEGRATION",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ARTIFACTS_NAMESPACE",
  "CLOUDFLARE_SANDBOX_API_KEY",
  "CLOUDFLARE_SANDBOX_API_URL",
  "DAYTONA_API_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_FORCE_PATH_STYLE",
  "S3_REGION",
  "S3_SECRET_ACCESS_KEY",
] as const;

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
    if (process.env.DATABASE_URL) delete env.DATABASE_URL;
    for (const variable of modelCredentialVariables) delete env[variable];
    if (process.env.CATAMORPHIC_EXTERNAL_INTEGRATIONS !== "1") {
      for (const variable of externalTestVariables) delete env[variable];
    }
    return env;
  } catch {
    return {};
  }
}

export default defineConfig({
  test: {
    passWithNoTests: true,
    exclude: [...configDefaults.exclude, "**/.claude/worktrees/**"],
    env: loadDotEnv(),
    pool: "threads",
    fileParallelism: true,
    // Whole-project ts-morph parses dominate these suites and slow an order
    // of magnitude when every package's tests run in parallel under turbo;
    // the defaults read as flakes under that contention. Hooks do the same
    // expensive repository and embedded-database setup as test bodies.
    testTimeout: 30_000,
    hookTimeout: 30_000,
  },
});
