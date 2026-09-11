import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { cp, mkdir, rename, rm } from "node:fs/promises";
import path from "node:path";
import { acquireDevInstanceLock } from "./dev-runtime.js";

/** Keep manual profiles beyond temporary-file cleanup; retain the source backup. */
export async function migrateDevData({
  legacyRoot,
  destinationRoot,
}: {
  legacyRoot: string;
  destinationRoot: string;
}): Promise<void> {
  const pending = ["desktop", "server"].filter(
    (name) =>
      existsSync(path.join(legacyRoot, name)) &&
      !existsSync(path.join(destinationRoot, name)),
  );
  if (!pending.length) return;
  const lock = await acquireDevInstanceLock({
    lockPath: path.join(legacyRoot, "dev.lock"),
    pid: process.pid,
  });
  try {
    await mkdir(destinationRoot, { recursive: true, mode: 0o700 });
    for (const name of pending) {
      const staging = path.join(destinationRoot, `.${name}-${randomUUID()}`);
      try {
        await cp(path.join(legacyRoot, name), staging, { recursive: true });
        await rename(staging, path.join(destinationRoot, name));
      } finally {
        await rm(staging, { recursive: true, force: true });
      }
    }
  } finally {
    await lock.release();
  }
}
