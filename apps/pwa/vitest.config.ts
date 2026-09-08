import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "jsdom",
    globals: true,
    include: ["src/**/*.test.{ts,tsx}", "e2e/harness.unit.test.ts"],
    passWithNoTests: true,
    maxWorkers: 2,
  },
});
