import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { migrateDevData } from "./dev-data.js";
import { acquireDevInstanceLock } from "./dev-runtime.js";

it("copies legacy profiles without overwriting an existing profile or deleting the backup", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-data-"));
  try {
    const legacyRoot = path.join(root, "old");
    const destinationRoot = path.join(root, "durable");
    await mkdir(path.join(legacyRoot, "desktop"), { recursive: true });
    await writeFile(
      path.join(legacyRoot, "desktop", "draft.md"),
      "keep my draft",
    );
    await migrateDevData({ legacyRoot, destinationRoot });
    expect(
      await readFile(path.join(destinationRoot, "desktop", "draft.md"), "utf8"),
    ).toBe("keep my draft");
    expect(
      await readFile(path.join(legacyRoot, "desktop", "draft.md"), "utf8"),
    ).toBe("keep my draft");
    await writeFile(
      path.join(destinationRoot, "desktop", "draft.md"),
      "new work",
    );
    await migrateDevData({ legacyRoot, destinationRoot });
    expect(
      await readFile(path.join(destinationRoot, "desktop", "draft.md"), "utf8"),
    ).toBe("new work");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it("refuses to copy a database while its legacy development instance owns the lock", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "dev-data-live-"));
  const legacyRoot = path.join(root, "old");
  await mkdir(path.join(legacyRoot, "desktop"), { recursive: true });
  const lock = await acquireDevInstanceLock({
    lockPath: path.join(legacyRoot, "dev.lock"),
    pid: process.pid,
  });
  try {
    await expect(
      migrateDevData({ legacyRoot, destinationRoot: path.join(root, "new") }),
    ).rejects.toThrow();
  } finally {
    await lock.release();
    await rm(root, { recursive: true, force: true });
  }
});
