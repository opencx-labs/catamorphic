import { defineConfig } from "vitest/config";

/**
 * Eval config: drives the REAL desktop app with a REAL model-backed agent
 * (setup wizard → chat → build_app → rendered app iframe). Opt-in and slow
 * by nature — run with `bun run test:eval` and CATAMORPHIC_EVAL=1 plus an
 * ANTHROPIC_API_KEY or OPENAI_API_KEY in the environment. Kept out of the
 * normal e2e suite (`*.eval.ts` never matches its `*.e2e.ts` glob).
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.eval.ts"],
    pool: "forks",
    fileParallelism: false,
    // A real agent turn (sandbox boot, install, build) can take minutes.
    testTimeout: 600_000,
    hookTimeout: 120_000,
  },
});
