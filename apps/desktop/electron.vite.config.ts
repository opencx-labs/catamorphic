import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "electron-vite";

// Entry points follow electron-vite's defaults (src/{main,preload}/index.ts,
// src/renderer/index.html). Dependencies are auto-externalized in main and
// preload (build.externalizeDeps defaults to true), which native/asset-bearing
// packages (pglite wasm, microsandbox NAPI, migrations sql) rely on.
export default defineConfig({
  main: {},
  preload: {},
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": path.resolve(import.meta.dirname, "src/renderer") },
    },
  },
});
