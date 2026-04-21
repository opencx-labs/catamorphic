import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    passWithNoTests: true,
    pool: "threads",
    fileParallelism: true,
    include: ["src/**/*.test.ts", "src/**/*.test.tsx"],
  },
});
