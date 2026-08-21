import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  optimizeDeps: {
    // Workspace packages resolve via dist/; prebundling would cache those
    // dists and keep serving stale package code while app source hot-reloads.
    exclude: [
      "@catamorphic/api-client",
      "@catamorphic/react",
      "@catamorphic/ui",
    ],
  },
  server: {
    watch: {
      // Un-ignore workspace dists so a `tsup --watch` rebuild reloads the app.
      ignored: ["!**/node_modules/@catamorphic/**"],
    },
  },
});
