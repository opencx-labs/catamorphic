import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { PrefsStore } from "./prefs.js";
import {
  loadSettings,
  type SettingsFiles,
  SettingsStore,
  saveSettings,
} from "./settings-store.js";

const directories: string[] = [];

it("keeps the last valid project theme and refuses unrelated saves over an invalid edit", () => {
  const paths = files();
  const store = new SettingsStore();
  const project = paths.project!;
  fs.writeFileSync(
    project,
    JSON.stringify({ theme: { overrides: { accent: "#123456" } } }),
  );
  expect(store.read(project, "project").value.theme).toEqual({
    overrides: { accent: "#123456" },
  });
  const invalid = JSON.stringify({
    theme: { overrides: { accent: "red;display:none" } },
  });
  fs.writeFileSync(project, invalid);
  expect(store.load(paths).errors).toHaveLength(1);
  expect(store.read(project, "project").value.theme).toEqual({
    overrides: { accent: "#123456" },
  });
  expect(() =>
    saveSettings({ files: paths, scope: "project", patch: { tabFrame: true } }),
  ).toThrow("Invalid theme");
  expect(fs.readFileSync(project, "utf8")).toBe(invalid);
  fs.unlinkSync(project);
  expect(store.read(project, "project")).toEqual({
    value: {},
    error: undefined,
  });
});
afterEach(() => {
  for (const dir of directories.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function files(): SettingsFiles {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "settings-layers-"));
  directories.push(dir);
  return {
    profile: path.join(dir, "prefs.json"),
    project: path.join(dir, "project.json"),
    personal: path.join(dir, "personal.json"),
  };
}
it("inherits per key and resetting restores live inheritance, including explicit false", () => {
  const paths = files();
  saveSettings({
    files: paths,
    scope: "profile",
    patch: { tabFrame: true, tabPlacement: "sidebar" },
  });
  saveSettings({ files: paths, scope: "project", patch: { tabFrame: false } });
  saveSettings({
    files: paths,
    scope: "personal",
    patch: { tabPlacement: "top" },
  });
  expect(loadSettings(paths)).toMatchObject({
    values: { tabFrame: false, tabPlacement: "top" },
    sources: { tabFrame: "project", tabPlacement: "personal" },
  });
  saveSettings({
    files: paths,
    scope: "personal",
    patch: { tabPlacement: null },
  });
  expect(loadSettings(paths)).toMatchObject({
    values: { tabPlacement: "sidebar" },
    sources: { tabPlacement: "profile" },
  });
  saveSettings({
    files: paths,
    scope: "profile",
    patch: { tabPlacement: "top" },
  });
  expect(loadSettings(paths).values.tabPlacement).toBe("top");
  saveSettings({ files: paths, scope: "project", patch: { tabFrame: null } });
  expect(loadSettings(paths).values.tabFrame).toBe(true);
});
it("ordinary state saves never turn inherited defaults into explicit choices", () => {
  const paths = files();
  const store = new PrefsStore(paths.profile);
  store.save({ rightSidebarOpen: false });
  expect(store.read()).toEqual({ rightSidebarOpen: false });
  expect(loadSettings(paths).sources.tabFrame).toBe("default");
});
it("rejects wrong scope and malformed writes without damaging the file", () => {
  const paths = files();
  expect(() =>
    saveSettings({
      files: paths,
      scope: "project",
      patch: { notificationSounds: false },
    }),
  ).toThrow("profile setting");
  fs.writeFileSync(paths.profile, "broken");
  expect(loadSettings(paths).errors).toHaveLength(1);
  expect(() =>
    saveSettings({ files: paths, scope: "profile", patch: { tabFrame: true } }),
  ).toThrow();
  expect(fs.readFileSync(paths.profile, "utf8")).toBe("broken");
});
it("invalid initial project values report errors and use defaults; unknown keys survive writes", () => {
  const paths = files();
  fs.writeFileSync(
    paths.project!,
    JSON.stringify({
      tabFrame: "false",
      rightSidebarOpen: false,
      notificationSounds: false,
    }),
  );
  expect(loadSettings(paths)).toMatchObject({
    values: {
      tabFrame: false,
      rightSidebarOpen: true,
      notificationSounds: true,
    },
    sources: { tabFrame: "default" },
  });
  expect(loadSettings(paths).errors).toHaveLength(1);
  fs.writeFileSync(paths.profile, '{"future":42}');
  saveSettings({ files: paths, scope: "profile", patch: { tabFrame: true } });
  saveSettings({ files: paths, scope: "profile", patch: { tabFrame: null } });
  expect(JSON.parse(fs.readFileSync(paths.profile, "utf8"))).toEqual({
    future: 42,
  });
});

it("profile state writes preserve future keys and refuse corrupt files", () => {
  const paths = files();
  const store = new PrefsStore(paths.profile);
  fs.writeFileSync(paths.profile, '{"future":42}');
  store.save({ rightSidebarOpen: false });
  expect(store.read()).toEqual({ future: 42, rightSidebarOpen: false });
  fs.writeFileSync(paths.profile, "broken");
  expect(() => store.save({ rightSidebarOpen: true })).toThrow();
  expect(fs.readFileSync(paths.profile, "utf8")).toBe("broken");
});
