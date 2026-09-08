import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { prepareVersionBackup } from "./pre-migration-backup.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function fixture() {
  const root = fs.mkdtempSync(
    path.join(os.tmpdir(), "catamorphic-backup-test-"),
  );
  temporaryDirectories.push(root);
  const dataRoot = path.join(root, "data");
  const dbDir = path.join(dataRoot, "db");
  fs.mkdirSync(dbDir, { recursive: true });
  fs.writeFileSync(path.join(dbDir, "database.bin"), "before migration");
  return { dataRoot, dbDir };
}

describe("prepareVersionBackup", () => {
  it("copies a closed database before a packaged version first boots", () => {
    const { dataRoot, dbDir } = fixture();
    const backup = prepareVersionBackup({
      appVersion: "0.1.0-alpha.2",
      packaged: true,
      dataRoot,
      dbDir,
      now: new Date("2026-09-02T08:00:00.000Z"),
    });

    expect(backup.backupPath).not.toBeNull();
    expect(
      fs.readFileSync(
        path.join(backup.backupPath ?? "", "database.bin"),
        "utf8",
      ),
    ).toBe("before migration");
    expect(fs.existsSync(path.join(dataRoot, "last-successful-version"))).toBe(
      false,
    );

    backup.markBootSuccessful();
    expect(
      fs.readFileSync(path.join(dataRoot, "last-successful-version"), "utf8"),
    ).toBe("0.1.0-alpha.2\n");
  });

  it("does not copy again after the same version booted successfully", () => {
    const { dataRoot, dbDir } = fixture();
    fs.writeFileSync(
      path.join(dataRoot, "last-successful-version"),
      "0.1.0-alpha.2\n",
    );

    const backup = prepareVersionBackup({
      appVersion: "0.1.0-alpha.2",
      packaged: true,
      dataRoot,
      dbDir,
    });

    expect(backup.backupPath).toBeNull();
    expect(fs.existsSync(path.join(dataRoot, "migration-backups"))).toBe(false);
  });

  it("retains only the two newest pre-migration copies", () => {
    const { dataRoot, dbDir } = fixture();
    for (const [version, date] of [
      ["0.1.0-alpha.1", "2026-09-01T08:00:00.000Z"],
      ["0.1.0-alpha.2", "2026-09-02T08:00:00.000Z"],
      ["0.1.0-alpha.3", "2026-09-03T08:00:00.000Z"],
    ] as const) {
      const backup = prepareVersionBackup({
        appVersion: version,
        packaged: true,
        dataRoot,
        dbDir,
        now: new Date(date),
      });
      backup.markBootSuccessful();
    }

    expect(
      fs.readdirSync(path.join(dataRoot, "migration-backups")),
    ).toHaveLength(2);
  });
});
