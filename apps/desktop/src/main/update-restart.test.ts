import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  consumeUpdateRestart,
  markUpdateRestart,
  updateRestartMarkerPath,
} from "./update-restart.js";

describe("update restart marker", () => {
  it("is consumed exactly once by the relaunch", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "update-restart-"));
    expect(consumeUpdateRestart(dir)).toBe(false);
    markUpdateRestart(dir);
    expect(fs.existsSync(updateRestartMarkerPath(dir))).toBe(true);
    expect(consumeUpdateRestart(dir)).toBe(true);
    expect(fs.existsSync(updateRestartMarkerPath(dir))).toBe(false);
    expect(consumeUpdateRestart(dir)).toBe(false);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
