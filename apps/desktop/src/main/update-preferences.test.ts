import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  defaultDesktopUpdateChannel,
  UpdatePreferencesStore,
} from "./update-preferences.js";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function store(): { file: string; value: UpdatePreferencesStore } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "update-prefs-"));
  directories.push(directory);
  const file = path.join(directory, "updates.json");
  return { file, value: new UpdatePreferencesStore(file) };
}

describe("UpdatePreferencesStore", () => {
  it("defaults stable builds to Stable and prereleases to Preview", () => {
    expect(defaultDesktopUpdateChannel("1.0.0")).toBe("stable");
    expect(defaultDesktopUpdateChannel("1.1.0-alpha.3")).toBe("preview");
  });

  it("persists a valid channel atomically", () => {
    const { file, value } = store();
    value.save("preview");

    expect(value.load("stable")).toBe("preview");
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({
      channel: "preview",
    });
  });

  it("ignores malformed and unknown preferences", () => {
    const { file, value } = store();
    fs.writeFileSync(file, '{"channel":"nightly"}\n');
    expect(value.load("stable")).toBe("stable");
    fs.writeFileSync(file, "not json");
    expect(value.load("preview")).toBe("preview");
  });
});
