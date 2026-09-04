import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_PREFS, normalizePrefs, PrefsStore } from "./prefs.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function store(): { file: string; value: PrefsStore } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "desktop-prefs-"));
  directories.push(directory);
  const file = path.join(directory, "prefs.json");
  return { file, value: new PrefsStore(file) };
}

describe("PrefsStore", () => {
  it("defaults session presentation state to empty lists", () => {
    expect(normalizePrefs({})).toEqual(DEFAULT_PREFS);
  });

  it("normalizes and deduplicates persisted session ids", () => {
    expect(
      normalizePrefs({
        unreadSessionIds: ["unread", null, "unread"],
      }),
    ).toMatchObject({
      unreadSessionIds: ["unread"],
    });
  });

  it("persists session state while preserving unknown preferences", () => {
    const { file, value } = store();
    fs.writeFileSync(file, '{"futureSetting":true}\n');

    value.save({
      unreadSessionIds: ["session-b"],
    });

    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toMatchObject({
      futureSetting: true,
      unreadSessionIds: ["session-b"],
    });
  });
});
