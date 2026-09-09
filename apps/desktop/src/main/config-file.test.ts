import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { KeybindingsStore } from "./keybindings.js";
import { PrefsStore } from "./prefs.js";
import { SettingsStore } from "./settings-store.js";
import { ThemeStore } from "./theme.js";

const directories: string[] = [];
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function directory() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "config-file-"));
  directories.push(dir);
  return dir;
}

it("keeps the last valid scoped override through malformed or invalid external edits, and deletion resets", () => {
  const dir = directory();
  const files = {
    profile: `${dir}/prefs.json`,
    project: `${dir}/project.json`,
    personal: `${dir}/personal.json`,
  };
  const store = new SettingsStore();
  fs.writeFileSync(
    files.profile,
    '{"tabPlacement":"sidebar","tabFrame":false}',
  );
  fs.writeFileSync(files.personal, '{"tabFrame":true}');
  expect(store.load(files).values.tabFrame).toBe(true);
  fs.writeFileSync(files.personal, '{"tabFrame":');
  expect(store.load(files)).toMatchObject({
    values: { tabFrame: true },
    sources: { tabFrame: "personal" },
  });
  expect(store.load(files).errors[0]).toContain(files.personal);
  fs.writeFileSync(files.profile, '{"tabPlacement":"top","tabFrame":false}');
  expect(store.load(files).values.tabPlacement).toBe("top");
  fs.writeFileSync(files.personal, '{"tabFrame":"false"}');
  expect(store.load(files).values.tabFrame).toBe(true);
  fs.writeFileSync(files.personal, "{}");
  expect(store.load(files)).toMatchObject({
    values: { tabFrame: false },
    sources: { tabFrame: "profile" },
    errors: [],
  });
  fs.writeFileSync(files.personal, '{"tabFrame":true}');
  expect(store.load(files).values.tabFrame).toBe(true);
  fs.unlinkSync(files.personal);
  expect(store.load(files).values.tabFrame).toBe(false);
});

it("theme and shortcut files retain valid values, reject invalid saves, recover and reset", () => {
  const dir = directory();
  const theme = new ThemeStore(`${dir}/theme.json`);
  const bindings = new KeybindingsStore(`${dir}/keybindings.json`);
  fs.writeFileSync(
    theme.file,
    '{"selection":"light","overrides":{"accent":"#123456"}}',
  );
  fs.writeFileSync(bindings.file, '{"new-tab":"Cmd+Shift+J"}');
  expect(theme.load().selection).toBe("light");
  expect(bindings.load()["new-tab"]).toBe("Cmd+Shift+J");
  fs.writeFileSync(theme.file, '{"overrides":{"accent":"url(x)"}}');
  fs.writeFileSync(bindings.file, '{"new-tab":null}');
  expect(theme.load().overrides.accent).toBe("#123456");
  expect(bindings.load()["new-tab"]).toBe("Cmd+Shift+J");
  expect(theme.error).toContain("accent");
  expect(bindings.error).toContain("new-tab");
  expect(() => theme.save({ selection: "system", overrides: {} })).toThrow();
  fs.writeFileSync(bindings.file, '{"new-tab":"Cmd+W"}');
  expect(bindings.load()["new-tab"]).toBe("Cmd+Shift+J");
  expect(bindings.error).toContain("conflict");
  fs.unlinkSync(theme.file);
  fs.writeFileSync(bindings.file, "{}");
  expect(theme.load().selection).toBe("system");
  expect(theme.error).toBeUndefined();
  expect(bindings.load()["new-tab"]).toBe("Cmd+T");
  expect(bindings.error).toBeUndefined();
});

it("profile runtime reads do not jump to defaults during invalid edits", () => {
  const dir = directory();
  const prefs = new PrefsStore(`${dir}/prefs.json`);
  prefs.save({ sidebarOpen: false, tabPlacement: "sidebar" });
  fs.writeFileSync(prefs.file, "broken");
  expect(prefs.load()).toMatchObject({
    sidebarOpen: false,
    tabPlacement: "sidebar",
  });
  expect(prefs.error).toContain(prefs.file);
  fs.unlinkSync(prefs.file);
  expect(prefs.load().tabPlacement).toBe("top");
});
