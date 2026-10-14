import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { signInDebugLog } from "./sign-in-diagnostics.js";

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

it("makes an empty log only this user can read, and keeps the newest five", () => {
  const logsDir = fs.mkdtempSync(path.join(os.tmpdir(), "sign-in-logs-"));
  dirs.push(logsDir);
  const made: string[] = [];
  for (let minute = 0; minute < 7; minute += 1) {
    const file = signInDebugLog({
      logsDir,
      harness: "claude-code",
      now: new Date(Date.UTC(2026, 9, 13, 17, minute)),
    });
    if (!file) throw new Error("no log file");
    made.push(file);
  }
  const dir = path.join(logsDir, "sign-in");
  expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  const kept = fs.readdirSync(dir).sort();
  expect(kept).toEqual(made.slice(-5).map((file) => path.basename(file)));
  for (const name of kept) {
    const stat = fs.statSync(path.join(dir, name));
    expect(stat.mode & 0o777).toBe(0o600);
    expect(stat.size).toBe(0);
  }
});

it("gives nothing when the logs directory cannot be written", () => {
  expect(
    signInDebugLog({ logsDir: "/dev/null/logs", harness: "claude-code" }),
  ).toBeUndefined();
});
