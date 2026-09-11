import { defineConfig } from "vitest/config";

/** Each runner owns a desktop. Shard whole files; never race apps for focus. */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // A broken shared Electron launch should fail a shard promptly. Other
    // CI shards still finish and upload diagnostics (matrix fail-fast is off).
    bail: process.env.CI === "true" ? 1 : 0,
    // Suites share an app across ordered tests. Retrying individual tests
    // would reuse mutated state and can hide failures.
    retry: 0,
  },
});
