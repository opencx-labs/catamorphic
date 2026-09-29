import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { ProfileConfigManager } from "../profile-config.js";
import { ProfilesStore } from "../profiles.js";
import { desktopSettingsContext } from "./desktop-settings-context.js";
import { DESKTOP_SETTINGS_SKILL } from "./desktop-settings-skill.js";
import type { DataPaths } from "./paths.js";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "settings-context-"));
  const paths: DataPaths = {
    root,
    db: `${root}/db`,
    projects: `${root}/projects`,
    remotes: `${root}/remotes`,
    appBundles: `${root}/apps`,
    profilesFile: `${root}/profiles.json`,
    profilesDir: `${root}/profiles`,
    agentHomesDir: `${root}/agents`,
    harnessComponentsDir: `${root}/harness`,
    hostSkillsDir: `${root}/skills`,
    attachmentsDir: `${root}/attachments`,
  };
  const profiles = new ProfilesStore(paths.profilesFile);
  const one = profiles.create("One"),
    two = profiles.create("Two");
  const config = new ProfileConfigManager(paths, profiles);
  cleanups.push(() => {
    config.dispose();
    fs.rmSync(root, { recursive: true, force: true });
  });
  return { root, config, one, two };
}
it("identifies the owning profile and primary project paths, with live file errors", () => {
  const { root, config, one, two } = fixture();
  const project = { id: "project-one", rootPath: `${root}/primary-project` };
  config.forProfile(two.id); // A different foreground profile must not affect the contract.
  const input = {
    config,
    profileId: one.id,
    project,
    access: "native" as const,
  };
  const context = desktopSettingsContext(input);
  expect(context.files?.preferences).toEqual({
    profile: `${root}/profiles/${one.id}/prefs.json`,
    project: `${project.rootPath}/.work/settings.json`,
    personal: `${root}/profiles/${one.id}/settings-projects/${project.id}.json`,
  });
  expect(context.files?.theme).toEqual({
    profile: config.forProfile(one.id).theme.file,
    project: context.files?.preferences.project,
    personal: context.files?.preferences.personal,
  });
  expect(context.files?.workspace).toEqual({
    profile: `${root}/profiles/${one.id}/workspace.js`,
    personal: `${root}/profiles/${one.id}/workspace-projects/${project.id}.js`,
    project: `${project.rootPath}/.work/workspace.js`,
  });
  // A sidebar.js from before workspace.js is named, never read.
  fs.writeFileSync(
    `${root}/profiles/${one.id}/sidebar.js`,
    "module.exports={}",
  );
  expect(desktopSettingsContext(input).errors).toContainEqual(
    expect.stringContaining("sidebar.js is no longer read"),
  );
  fs.rmSync(`${root}/profiles/${one.id}/sidebar.js`);
  fs.writeFileSync(config.forProfile(one.id).theme.file, "broken");
  expect(desktopSettingsContext(input).errors?.[0]).toContain("theme.json");
  expect(JSON.stringify(context)).not.toContain(two.id);
  expect(DESKTOP_SETTINGS_SKILL).not.toContain("update_desktop_setting");
});
it("distinguishes restricted native access from an unavailable host filesystem", () => {
  const { config, one } = fixture();
  const input = {
    config,
    profileId: one.id,
    project: { id: "project", rootPath: null },
  };
  expect(desktopSettingsContext({ ...input, access: "read-only" }).access).toBe(
    "read-only",
  );
  const unavailable = desktopSettingsContext({
    ...input,
    access: "unavailable",
  });
  expect(unavailable).not.toHaveProperty("files");
  expect(unavailable.note).toContain("sandbox");
});
