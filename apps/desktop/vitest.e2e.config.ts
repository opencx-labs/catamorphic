import { defineConfig } from "vitest/config";

const visibleMode = process.env.CATAMORPHIC_E2E_WINDOW_MODE === "visible";
const visibleSuites = [
  "e2e/skills.e2e.ts",
  "e2e/tool-permissions.e2e.ts",
  "e2e/window-state.e2e.ts",
];

/**
 * E2E config: drives the real Electron app over CDP. One file, serial —
 * each test group boots its own app instance against a temp userData dir.
 * Run with `bun run test:e2e` (requires `bun run build` output to be fresh;
 * the script handles that).
 */
export default defineConfig({
  test: {
    include: visibleMode ? visibleSuites : ["e2e/**/*.e2e.ts"],
    exclude: visibleMode ? [] : visibleSuites,
    pool: "forks",
    fileParallelism: false,
    testTimeout: 120_000,
    hookTimeout: 120_000,
    // Motion tests sample computed styles on a 25ms cadence; a loaded
    // machine (cold build in the same run) can starve the sampler past
    // an animation. One retry absorbs that without hiding real breaks.
    retry: 1,
  },
});
