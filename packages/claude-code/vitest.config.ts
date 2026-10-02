import { fileURLToPath } from "node:url";
import { mergeConfig } from "vitest/config";
import base from "../../vitest.config.ts";

/**
 * The agent runner's bundle registers this adapter, so this package cannot
 * depend on the runner package. Tests reach the runner's source instead, to
 * replay transcripts through a real AttemptRunner (ADR 0196).
 */
export default mergeConfig(base, {
  resolve: {
    alias: {
      "@catamorphic/agent-runner": fileURLToPath(
        new URL("../agent-runner/src/index.ts", import.meta.url),
      ),
    },
  },
});
