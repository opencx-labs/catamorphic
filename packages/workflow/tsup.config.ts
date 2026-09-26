import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/project-layout.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
});
