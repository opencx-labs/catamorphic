import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["e2e/**/*.e2e.ts"],
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Tests share one app and backend in order. A retry runs against what
    // the failed attempt left behind, and hid three flakes for weeks.
    retry: 0,
  },
});
