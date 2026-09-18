import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

const MAX_BYTES = 512 * 1024 * 1024;

function fingerprint(file: string): string | null {
  try {
    const stat = fs.lstatSync(file, { bigint: true });
    if (!stat.isFile())
      throw new Error("The browser database is not a regular file.");
    return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return null;
    throw error;
  }
}

/** Chrome holds exclusive locks even when idle. Copy a stable database plus
 * its journal into an owner-only temporary directory, never sharing source
 * locks/SHM. SQLite recovers the private copy before query-only reads. */
export function readBrowserDatabase<T>({
  file,
  read,
}: {
  file: string;
  read: (database: DatabaseSync) => T;
}): T {
  const sources = [file, `${file}-wal`, `${file}-journal`];
  for (let attempt = 0; attempt < 3; attempt++) {
    const directory = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-browser-import-"),
    );
    const target = path.join(directory, "database");
    let database: DatabaseSync | undefined;
    try {
      const before = sources.map(fingerprint);
      if (!before[0])
        throw new Error("The browser database is no longer available.");
      let total = 0;
      for (const [index, source] of sources.entries()) {
        if (!before[index]) continue;
        // Open without following links, including optional WAL/journal files.
        const input = fs.openSync(
          source,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW,
        );
        try {
          const size = fs.fstatSync(input).size;
          total += size;
          if (total > MAX_BYTES)
            throw new Error("The browser database is too large to import.");
          const output = fs.openSync(
            `${target}${source.slice(file.length)}`,
            "wx",
            0o600,
          );
          const buffer = Buffer.alloc(64 * 1024);
          try {
            let copied = 0;
            while (copied < size) {
              const bytes = fs.readSync(
                input,
                buffer,
                0,
                Math.min(buffer.length, size - copied),
                copied,
              );
              if (!bytes) break;
              let written = 0;
              while (written < bytes)
                written += fs.writeSync(
                  output,
                  buffer,
                  written,
                  bytes - written,
                );
              copied += bytes;
            }
          } finally {
            buffer.fill(0);
            fs.closeSync(output);
          }
        } finally {
          fs.closeSync(input);
        }
      }
      // Reject a torn copy or a replaced/deleted journal. A busy writer can
      // retry; never query a mixture of different source generations.
      if (
        sources.some((source, index) => fingerprint(source) !== before[index])
      )
        continue;
      database = new DatabaseSync(target, { allowExtension: false });
      database.exec("PRAGMA query_only = ON;");
      const check = database.prepare("PRAGMA quick_check").get();
      if (check?.quick_check !== "ok")
        throw new Error("The browser database could not be read consistently.");
      return read(database);
    } finally {
      try {
        database?.close();
      } finally {
        fs.rmSync(directory, { recursive: true, force: true });
      }
    }
  }
  throw new Error("The browser is updating its data. Try importing again.");
}
