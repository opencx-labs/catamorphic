import fs from "node:fs";
import path from "node:path";
import {
  BACKGROUND_RUNTIME_ARGUMENT,
  handOffBackgroundRuntime,
  launchBackgroundRuntime,
  serveBackgroundRuntime,
} from "../background-runtime.js";

const root = process.argv[2];
if (!root) throw new Error("The fixture needs its own data directory.");
const helper = process.argv.includes(BACKGROUND_RUNTIME_ARGUMENT);
const lock = path.join(root, "engine.lock");
// Like PGlite, this engine must have exactly one live owner. A concurrent
// helper fails instead of opening another database or deleting the old one.
const fd = fs.openSync(lock, "wx");
fs.writeFileSync(fd, String(process.pid));
if (helper) {
  const heartbeat = path.join(root, "heartbeat");
  let ticks = 0;
  const tick = setInterval(
    () => fs.writeFileSync(heartbeat, String(++ticks)),
    20,
  );
  const control = await serveBackgroundRuntime({
    userData: root,
    inspect: async () => ({ pid: process.pid, ticks, windows: 0 }),
    shutdown: () => {
      void close();
    },
  });
  async function close() {
    clearInterval(tick);
    await control.close();
    fs.closeSync(fd);
    fs.unlinkSync(lock);
    process.exit(0);
  }
  process.once("SIGTERM", () => {
    void close();
  });
} else {
  fs.writeFileSync(path.join(root, "foreground.pid"), String(process.pid));
  await handOffBackgroundRuntime({
    enabled: true,
    allowed: true,
    shutdown: async () => {
      fs.closeSync(fd);
      fs.unlinkSync(lock);
    },
    releaseLock: () => {},
    launch: () =>
      launchBackgroundRuntime({
        executable: process.execPath,
        args: [import.meta.filename, root],
        userData: root,
      }),
  });
  process.exit(0);
}
