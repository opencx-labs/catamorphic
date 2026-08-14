import { defineConfig } from "tsup";

export default defineConfig({
  // Two public entries: the host/runtime surface (".") and the UI kit
  // ("./ui" — React stays external via peerDependencies).
  entry: ["src/index.ts", "src/ui/index.ts"],
  format: ["esm"],
  dts: false,
  clean: true,
  sourcemap: true,
});
