import { defineConfig } from "vitest/config";

const visibleMode = process.env.CATAMORPHIC_E2E_WINDOW_MODE === "visible";
const visibleSuites = [
  "e2e/chat-state.e2e.ts",
  "e2e/scrolling.e2e.ts",
  "e2e/settings-motion.e2e.ts",
  "e2e/sidebars.e2e.ts",
  "e2e/motion.e2e.ts",
  // Floating surfaces exercise native keyboard focus and entrance/exit motion.
  "e2e/floating-surfaces.e2e.ts",
  "e2e/runtime-idle.e2e.ts",
  "e2e/session-runtime.e2e.ts",
  // Live preview polling and animation require a visible renderer.
  "e2e/workflows.e2e.ts",
  "e2e/skills.e2e.ts",
  "e2e/tool-permissions.e2e.ts",
  "e2e/window-state.e2e.ts",
  // Query retries pause while the native window is hidden. Exercise the
  // user-facing failure/retry flow with the same focus state as the app.
  "e2e/project-reopen.e2e.ts",
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
    // A shared Electron launch failure otherwise consumes one hook timeout
    // per file and obscures the first useful startup diagnostic in CI.
    bail: process.env.CI === "true" ? 1 : 0,
    // Visible motion tests sample computed styles on a 25ms cadence; a loaded
    // machine can starve the sampler past an animation. Hidden suites are
    // stateful within each file, so retrying one test without recreating the
    // app produces misleading results instead of an independent attempt.
    retry: visibleMode ? 1 : 0,
  },
});
