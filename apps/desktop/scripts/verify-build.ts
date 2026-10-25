import fs from "node:fs";
import path from "node:path";

// Multi-entry bundlers can report success while dropping a side-effect entry.
// Fail the build here, before packaging or waiting for Electron's CDP handshake.
for (const entry of [
  "main/index.js",
  "main/sidebar-source-worker.js",
  "preload/index.cjs",
  "renderer/index.html",
]) {
  const file = path.join(import.meta.dirname, "../out", entry);
  if (!fs.readFileSync(file, "utf8").trim())
    throw new Error(`Desktop build produced an empty entry: ${entry}`);
}
