import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Browser-safe subpath ("./attachments"): the root barrel pulls node:
    // modules, the marker helpers must not.
    attachments: "src/coding-agent/text-attachments.ts",
    // Vitest conformance suite. This is intentionally not re-exported from
    // the production barrel.
    testing: "src/coding-agent/runtime-conformance.ts",
  },
  external: ["@catamorphic/sandbox", "vitest"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
});
