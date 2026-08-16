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
      alias: {
        "@": path.resolve(import.meta.dirname, "src/renderer"),
        // @tiptap/extension-drag-handle statically imports its collaboration
        // support, which would pull the whole yjs graph into the renderer
        // bundle for a feature we don't use. The stub satisfies the imports;
        // every stubbed call is guarded (see the stub's header) — re-verify
        // if tiptap is upgraded past the pinned 3.30.1.
        "@tiptap/y-tiptap": path.resolve(
          import.meta.dirname,
          "src/renderer/lib/tiptap-collab-stub.ts",
        ),
        "@tiptap/extension-collaboration": path.resolve(
          import.meta.dirname,
          "src/renderer/lib/tiptap-collab-stub.ts",
        ),
      },
    },
    // Workspace packages resolve from their dist/ builds. Left to vite's
    // dependency optimizer they get PREBUNDLED AND CACHED — a running dev
    // app keeps serving the stale prebundle after a package rebuild,
    // while apps/desktop source hot-reloads live: the mismatch breaks the
    // renderer in ways a "fresh" dev launch wouldn't. Exclude them from
    // optimization (their dists are plain ESM) and un-ignore them in the
    // watcher, so a package rebuild reloads the running app with current
    // code instead.
    optimizeDeps: {
      exclude: [
        "@catamorphic/api-client",
        "@catamorphic/react",
        "@catamorphic/ui",
        "@catamorphic/workflow",
      ],
    },
    server: {
      watch: { ignored: ["!**/node_modules/@catamorphic/**"] },
    },
  },
});
