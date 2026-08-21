import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    // Browser-safe subpath ("./attachments"): the root barrel pulls node:
    // modules, the marker helpers must not.
    attachments: "src/coding-agent/text-attachments.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
});
