import fs from "node:fs";
import path from "node:path";

/** Debug logs kept from sign-in retries, newest first. */
const KEPT_LOGS = 5;

/**
 * A new file for the CLI's debug log of a sign-in retry (ADR 0228): in
 * `sign-in/` under Work's logs, readable by this user alone, with only the
 * newest few kept. What the CLI says about its token refresh stays on this
 * machine for whoever diagnoses the next failure; Work never reads or
 * sends it. Undefined when the file cannot be made.
 */
export function signInDebugLog(input: {
  logsDir: string;
  harness: string;
  now?: Date;
}): string | undefined {
  try {
    const dir = path.join(input.logsDir, "sign-in");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    // An existing directory keeps its mode: narrow it too.
    fs.chmodSync(dir, 0o700);
    const stale = fs
      .readdirSync(dir)
      .filter((name) => name.endsWith(".log"))
      .sort()
      .reverse()
      .slice(KEPT_LOGS - 1);
    for (const name of stale) fs.rmSync(path.join(dir, name), { force: true });
    const stamp = (input.now ?? new Date()).toISOString().replace(/[:.]/g, "-");
    const file = path.join(dir, `${stamp}-${input.harness}.log`);
    fs.writeFileSync(file, "", { mode: 0o600, flag: "wx" });
    return file;
  } catch {
    return undefined;
  }
}
