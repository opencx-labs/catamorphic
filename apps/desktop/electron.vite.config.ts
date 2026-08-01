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
  preload: {
    build: {
      rollupOptions: {
        // `electron` must stay external — bundling the npm shim into the
        // preload chunk breaks contextBridge at runtime.
        external: ["electron"],
        input: {
          index: path.resolve(import.meta.dirname, "src/preload/index.ts"),
          // Guest preload for browser-tab webviews. CJS so sandboxed,
          // untrusted guests can load it (ESM preloads require an
          // unsandboxed renderer).
          webview: path.resolve(import.meta.dirname, "src/preload/webview.ts"),
        },
        output: { format: "cjs", entryFileNames: "[name].cjs" },
      },
    },
  },
  renderer: {
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: { "@": path.resolve(import.meta.dirname, "src/renderer") },
    },
  },
});
