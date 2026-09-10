import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/node.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
});
