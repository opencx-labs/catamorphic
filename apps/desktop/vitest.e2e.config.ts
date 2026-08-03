import { defineConfig } from "vitest/config";

/**
 * E2E config: drives the real Electron app over CDP. One file, serial —
 * each test group boots its own app instance against a temp userData dir.
 * Run with `bun run test:e2e` (requires `bun run build` output to be fresh;
 * the script handles that).
 */
export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
  },
});
