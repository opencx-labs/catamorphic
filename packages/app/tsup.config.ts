import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts", "src/ui/index.ts"],
  format: ["esm"],
  dts: false,
  splitting: false,
  clean: true,
  sourcemap: true,
});
