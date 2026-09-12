import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** Never let initialization replace an existing database whose files were lost. */
export function validateDatabaseFiles(directory: string): void {
  if (!existsSync(directory) || readdirSync(directory).length === 0) return;
  for (const file of ["PG_VERSION", "global/pg_control", "base/5/PG_VERSION"]) {
    if (!existsSync(path.join(directory, file)))
      throw new Error(
        `The local database is incomplete. Its data has been preserved at ${directory}. Restore it from a backup before reopening the app. Missing database file: ${file}`,
      );
  }
}
