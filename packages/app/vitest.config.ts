import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    // Globals are required for @testing-library/react's auto-cleanup
    // between tests (it registers on the global afterEach).
    globals: true,
    setupFiles: ["./src/__tests__/setup.ts"],
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
    pool: "threads",
    fileParallelism: true,
    maxWorkers: 2,
  },
});
