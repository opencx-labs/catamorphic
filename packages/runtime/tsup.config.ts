import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/harness.ts", "src/supervisor-worker.ts"],
  format: ["esm"],
  dts: false,
  splitting: false,
  clean: true,
  sourcemap: true,
});
