import { defineConfig } from "tsup";

export default defineConfig({
  entry: {
    index: "src/index.ts",
    layout: "src/layout-entry.ts",
  },
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
});
