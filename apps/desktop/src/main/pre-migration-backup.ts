import fs from "node:fs";
import path from "node:path";

const BACKUPS_TO_KEEP = 2;

export interface VersionBackup {
  backupPath: string | null;
  markBootSuccessful(): void;
}

function safeVersion(version: string): string {
  return version.replace(/[^0-9A-Za-z.-]/g, "-");
}

function readVersion(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function hasDatabaseFiles(dbDir: string): boolean {
  try {
    return fs.readdirSync(dbDir).length > 0;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

function writeVersion(file: string, version: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${version}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  fs.renameSync(temporary, file);
}

function pruneBackups(root: string): void {
  const backups = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith("before-"))
    .map((entry) => {
      const fullPath = path.join(root, entry.name);
      return { fullPath, modifiedAt: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.modifiedAt - left.modifiedAt);
  for (const backup of backups.slice(BACKUPS_TO_KEEP)) {
    fs.rmSync(backup.fullPath, { recursive: true, force: true });
  }
}

/**
 * Copies the closed PGlite directory before a packaged version first opens it.
 * The caller records success only after migrations and server boot complete.
 */
export function prepareVersionBackup(options: {
  appVersion: string;
  packaged: boolean;
  dataRoot: string;
  dbDir: string;
  now?: Date;
}): VersionBackup {
  const marker = path.join(options.dataRoot, "last-successful-version");
  const complete = () => writeVersion(marker, options.appVersion);
  if (!options.packaged) return { backupPath: null, markBootSuccessful() {} };
  if (
    readVersion(marker) === options.appVersion ||
    !hasDatabaseFiles(options.dbDir)
  ) {
    return { backupPath: null, markBootSuccessful: complete };
  }

  const root = path.join(options.dataRoot, "migration-backups");
  fs.mkdirSync(root, { recursive: true, mode: 0o700 });
  const timestamp = (options.now ?? new Date())
    .toISOString()
    .replace(/[:.]/g, "-");
  const backupPath = path.join(
    root,
    `before-${safeVersion(options.appVersion)}-${timestamp}`,
  );
  fs.cpSync(options.dbDir, backupPath, {
    recursive: true,
    errorOnExist: true,
    force: false,
  });
  fs.chmodSync(backupPath, 0o700);
  pruneBackups(root);
  return { backupPath, markBootSuccessful: complete };
}
