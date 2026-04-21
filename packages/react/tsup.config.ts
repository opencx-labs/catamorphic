import { defineConfig } from "tsup";

export default defineConfig([
  {
    entry: { index: "src/index.ts" },
    format: ["esm"],
    dts: false,
    clean: true,
    sourcemap: true,
    external: ["react", "react-dom", "@tanstack/react-query"],
    banner: { js: '"use client";' },
  },
  {
    entry: { "workflow-helpers": "src/workflow-helpers.ts" },
    format: ["esm"],
    dts: false,
    clean: false,
    sourcemap: true,
    external: ["react", "react-dom", "@tanstack/react-query"],
  },
]);
