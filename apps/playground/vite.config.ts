import path from "node:path";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const serverPort = Number(process.env.PLAYGROUND_SERVER_PORT ?? 8500);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { "@": path.resolve(import.meta.dirname, "src") },
  },
  server: {
    port: 5173,
    // `.data` holds the playground server's project working copies. New
    // projects write tsconfig.json files there, which Vite would otherwise
    // treat as config changes and force a full page reload mid-session.
    watch: { ignored: ["**/.data/**"] },
    proxy: {
      "/api": `http://localhost:${serverPort}`,
    },
  },
});
