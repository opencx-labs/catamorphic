import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { PROGRAM_DIRECTORY, programCleanup } from "../services/session-exec.js";

/**
 * A workspace gets a `$WORK_PROGRAM` copy per main commit (ADR 0324);
 * placing a new one removes copies of other commits made over a day ago
 * and leftover staging, except those running executions use (ADR 0336).
 */
describe("program copy cleanup", () => {
  const roots: string[] = [];
  afterEach(() => {
    for (const root of roots.splice(0)) {
      // Kept copies have no write bits.
      execFileSync("chmod", ["-R", "u+w", root]);
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes old copies of other commits and leftover staging, keeping the current, running and recent ones", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-program-"));
    roots.push(root);
    const programs = path.join(root, PROGRAM_DIRECTORY);
    const twoDaysAgo = new Date(Date.now() - 48 * 60 * 60_000);
    const copy = (name: string, old: boolean) => {
      const folder = path.join(programs, name);
      fs.mkdirSync(path.join(folder, "workflows"), { recursive: true });
      fs.writeFileSync(path.join(folder, "workflows", "review.ts"), "x\n");
      // Copies are placed without write bits.
      fs.chmodSync(path.join(folder, "workflows", "review.ts"), 0o444);
      fs.chmodSync(path.join(folder, "workflows"), 0o555);
      fs.chmodSync(folder, 0o555);
      if (old) fs.utimesSync(folder, twoDaysAgo, twoDaysAgo);
    };
    copy("a".repeat(40), true); // An old commit nobody uses: removed.
    copy("b".repeat(40), true); // The commit this exec copied: kept.
    copy("c".repeat(40), true); // A running exec's: kept.
    copy("d".repeat(40), false); // Placed within the day: kept.
    copy(".staging-1234", true); // A start that died: removed.
    copy(".staging-5678", false); // A start under way: kept.
    execFileSync(
      "sh",
      ["-c", programCleanup({ keep: ["b".repeat(40), "c".repeat(40)] })],
      { cwd: root },
    );
    expect(fs.readdirSync(programs).sort()).toEqual([
      ".staging-5678",
      "b".repeat(40),
      "c".repeat(40),
      "d".repeat(40),
    ]);
  });

  it("does nothing in a workspace with no copies", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-program-"));
    roots.push(root);
    execFileSync("sh", ["-c", programCleanup({ keep: [] })], { cwd: root });
    expect(fs.readdirSync(root)).toEqual([]);
  });
});
