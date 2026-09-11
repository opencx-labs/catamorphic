import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { validateDatabaseFiles } from "./database-files.js";

it("permits new databases but preserves and rejects an incomplete existing database", () => {
  const root = mkdtempSync(path.join(tmpdir(), "database-files-"));
  try {
    expect(() => validateDatabaseFiles(path.join(root, "new"))).not.toThrow();
    expect(() => validateDatabaseFiles(root)).not.toThrow();
    writeFileSync(path.join(root, "user-table"), "precious data");
    expect(() => validateDatabaseFiles(root)).toThrow("database is incomplete");
    expect(readFileSync(path.join(root, "user-table"), "utf8")).toBe(
      "precious data",
    );
    for (const file of [
      "PG_VERSION",
      "global/pg_control",
      "base/5/PG_VERSION",
    ]) {
      mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
      writeFileSync(path.join(root, file), "present");
    }
    expect(() => validateDatabaseFiles(root)).not.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
