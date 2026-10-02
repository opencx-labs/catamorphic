import fs from "node:fs";
import path from "node:path";
import { format } from "node:util";

/** What electron-updater and the update controller log through. */
export type UpdaterLogger = Pick<Console, "debug" | "info" | "warn" | "error">;

/**
 * Update activity in `<logs>/updates.log` beside the console: an app opened
 * from the Dock has no visible stdout, and "did it check?" needs an answer.
 * The file keeps one previous generation once it passes `maxBytes`.
 */
export function createUpdaterLog(
  file: string,
  { maxBytes = 512 * 1024 }: { maxBytes?: number } = {},
): UpdaterLogger {
  const write = (level: string, args: unknown[]) => {
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      if ((fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0) > maxBytes)
        fs.renameSync(file, `${file}.1`);
      fs.appendFileSync(
        file,
        `${new Date().toISOString()} ${level} ${format(...args)}\n`,
      );
    } catch {
      // Logging must never break updating.
    }
  };
  return {
    debug: (...args: unknown[]) => write("debug", args),
    info: (...args: unknown[]) => {
      console.info(...args);
      write("info", args);
    },
    warn: (...args: unknown[]) => {
      console.warn(...args);
      write("warn", args);
    },
    error: (...args: unknown[]) => {
      console.error(...args);
      write("error", args);
    },
  };
}
