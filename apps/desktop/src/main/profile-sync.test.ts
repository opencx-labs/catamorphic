import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ safeStorage: {} }));

import {
  PROFILE_SYNC_KEYS,
  PROFILE_SYNC_PARTS,
} from "../shared/profile-sync.js";
import { SETTING_KEYS } from "../shared/settings.js";
import { ProfileConfigManager } from "./profile-config.js";
import { ProfilesStore } from "./profiles.js";
import type { DataPaths } from "./server/paths.js";

const roots: string[] = [];
const managers: ProfileConfigManager[] = [];

afterEach(() => {
  for (const manager of managers.splice(0)) manager.dispose();
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-profile-sync-"));
  roots.push(root);
  const profiles = new ProfilesStore(path.join(root, "profiles.json"));
  const config = new ProfileConfigManager(
    {
      profilesDir: path.join(root, "profiles"),
      bookmarksFile: path.join(root, "bookmarks.json"),
    } as DataPaths,
    profiles,
  );
  managers.push(config);
  const source = profiles.defaultProfile().id;
  const prefsOf = (profileId: string) =>
    JSON.parse(
      fs.readFileSync(
        path.join(config.profileDir(profileId), "prefs.json"),
        "utf8",
      ),
    );
  return { root, profiles, config, source, prefsOf };
}

describe("profile settings sync", () => {
  it("assigns every preference to exactly one part", () => {
    const assigned = PROFILE_SYNC_PARTS.flatMap(
      (part) => PROFILE_SYNC_KEYS[part],
    );
    expect([...assigned].sort()).toEqual([...SETTING_KEYS].sort());
    expect(PROFILE_SYNC_KEYS.macros).toEqual(["terminalMacros"]);
    expect(PROFILE_SYNC_KEYS.appearance).toContain("codeTheme");
  });

  it("kept in sync, both profiles read and write the same settings", () => {
    const { profiles, config, source, prefsOf } = setup();
    config.forProfile(source).prefs.save({
      codeTheme: "catppuccin",
      diffLayout: "unified",
      lastProjectId: "project-a",
    });
    config.forProfile(source).theme.save({
      selection: "system",
      overrides: { accent: "#ff5500" },
      fonts: {},
    });
    const follower = profiles.create("Personal").id;
    config.forProfile(follower).prefs.save({
      codeTheme: "github",
      lastProjectId: "project-b",
    });

    config.syncSettings({
      profileId: follower,
      from: source,
      parts: ["appearance", "macros"],
      keepInSync: true,
    });

    const stores = config.forProfile(follower);
    expect(profiles.get(follower)?.syncedFrom).toEqual({
      appearance: source,
      macros: source,
    });
    expect(stores.theme.file).toBe(config.forProfile(source).theme.file);
    expect(stores.theme.load().overrides).toEqual({ accent: "#ff5500" });
    // Synced keys come from the owner; runtime state and other parts stay.
    expect(stores.prefs.load()).toMatchObject({
      codeTheme: "catppuccin",
      lastProjectId: "project-b",
      diffLayout: "split",
    });

    // An edit from the follower is an edit to the owner, and back.
    stores.prefs.save({
      terminalMacros: [
        { id: "dev", name: "Dev", command: "bun dev", shortcut: "" },
      ],
      rightSidebarOpen: false,
    });
    expect(prefsOf(source).terminalMacros).toHaveLength(1);
    expect(prefsOf(source).rightSidebarOpen).toBeUndefined();
    expect(prefsOf(follower).rightSidebarOpen).toBe(false);
    config.saveSettings(follower, undefined, "profile", {
      codeTheme: "vitesse",
      diffWrap: true,
    });
    expect(prefsOf(source).codeTheme).toBe("vitesse");
    expect(prefsOf(follower).diffWrap).toBe(true);
    expect(prefsOf(source).diffWrap).toBeUndefined();
    expect(config.resolveSettings(source).values.codeTheme).toBe("vitesse");
    config.saveSettings(source, undefined, "profile", { codeTheme: null });
    expect(config.resolveSettings(follower).sources.codeTheme).toBe("default");
  });

  it("shares shortcuts and the workspace file, but not per-project overrides", () => {
    const { profiles, config, source } = setup();
    config.forProfile(source).keybindings.save({
      ...config.forProfile(source).keybindings.load(),
      "open-settings": "Cmd+Shift+Y",
    });
    const follower = profiles.create("Personal").id;
    config.syncSettings({
      profileId: follower,
      from: source,
      parts: ["shortcuts", "workspace"],
      keepInSync: true,
    });
    expect(
      config.forProfile(follower).keybindings.load()["open-settings"],
    ).toBe("Cmd+Shift+Y");
    const resolved = config.resolveWorkspace(follower, {
      id: "project-1",
      rootPath: null,
    });
    expect(resolved.file).toBe(config.forProfile(source).workspace.file);
    fs.mkdirSync(path.join(config.profileDir(follower), "workspace-projects"), {
      recursive: true,
    });
    const local = path.join(
      config.profileDir(follower),
      "workspace-projects",
      "project-1.js",
    );
    fs.writeFileSync(local, fs.readFileSync(resolved.file ?? "", "utf8"));
    expect(
      config.resolveWorkspace(follower, { id: "project-1", rootPath: null })
        .file,
    ).toBe(local);
  });

  it("a one-time copy stays independent afterwards", () => {
    const { profiles, config, source, prefsOf } = setup();
    config.forProfile(source).prefs.save({ notificationSounds: false });
    const follower = profiles.create("Personal").id;
    config.forProfile(follower).prefs.save({ desktopNotifications: false });
    config.syncSettings({
      profileId: follower,
      from: source,
      parts: ["notifications"],
      keepInSync: false,
    });
    expect(profiles.get(follower)?.syncedFrom).toBeUndefined();
    // The copy replaces the part: the follower's own choice is gone.
    expect(prefsOf(follower)).toEqual({ notificationSounds: false });
    config.forProfile(source).prefs.save({ notificationSounds: true });
    expect(config.forProfile(follower).prefs.load().notificationSounds).toBe(
      false,
    );
  });

  it("stopping keeps what the profile shows and ends the link", () => {
    const { profiles, config, source, prefsOf } = setup();
    config.forProfile(source).prefs.save({ codeTheme: "one" });
    config.forProfile(source).theme.save({
      selection: "system",
      overrides: { accent: "#123456" },
      fonts: {},
    });
    const follower = profiles.create("Personal").id;
    config.syncSettings({
      profileId: follower,
      from: source,
      parts: ["appearance"],
      keepInSync: true,
    });
    config.stopSyncing({ profileId: follower, parts: ["appearance"] });
    const stores = config.forProfile(follower);
    expect(profiles.get(follower)?.syncedFrom).toBeUndefined();
    expect(stores.theme.file).toBe(
      path.join(config.profileDir(follower), "theme.json"),
    );
    expect(stores.theme.load().overrides).toEqual({ accent: "#123456" });
    expect(prefsOf(follower).codeTheme).toBe("one");
    config.forProfile(source).prefs.save({ codeTheme: "github" });
    expect(stores.prefs.load().codeTheme).toBe("one");
  });

  it("joins a source's owner directly and brings its own followers along", () => {
    const { profiles, config, source } = setup();
    const middle = profiles.create("Work").id;
    const leaf = profiles.create("Personal").id;
    config.syncSettings({
      profileId: leaf,
      from: middle,
      parts: ["appearance"],
      keepInSync: true,
    });
    expect(profiles.syncOwner(leaf, "appearance")).toBe(middle);
    config.syncSettings({
      profileId: middle,
      from: source,
      parts: ["appearance"],
      keepInSync: true,
    });
    expect(profiles.syncOwner(middle, "appearance")).toBe(source);
    expect(profiles.syncOwner(leaf, "appearance")).toBe(source);
    // Syncing with a profile that already shares the files changes nothing.
    config.syncSettings({
      profileId: source,
      from: leaf,
      parts: ["appearance"],
      keepInSync: true,
    });
    expect(profiles.get(source)?.syncedFrom).toBeUndefined();
  });

  it("removing the source leaves its followers in sync with each other", () => {
    const { profiles, config, source } = setup();
    config.forProfile(source).prefs.save({ codeTheme: "solarized" });
    const first = profiles.create("Work").id;
    const second = profiles.create("Personal").id;
    for (const profileId of [first, second])
      config.syncSettings({
        profileId,
        from: source,
        parts: ["appearance"],
        keepInSync: true,
      });
    config.forProfile(second);
    profiles.setDefaultProfile(first);
    expect(profiles.remove(source)).toBe(true);

    expect(profiles.get(first)?.syncedFrom).toBeUndefined();
    expect(profiles.syncOwner(second, "appearance")).toBe(first);
    expect(config.forProfile(first).prefs.load().codeTheme).toBe("solarized");
    expect(config.forProfile(second).prefs.load().codeTheme).toBe("solarized");
    config.forProfile(second).prefs.save({ codeTheme: "rose-pine" });
    expect(config.forProfile(first).prefs.load().codeTheme).toBe("rose-pine");
  });

  it("never overwrites a profile's prefs.json with an unrepaired edit", () => {
    const { profiles, config, source } = setup();
    const follower = profiles.create("Personal").id;
    const own = path.join(config.profileDir(follower), "prefs.json");
    fs.mkdirSync(path.dirname(own), { recursive: true });
    fs.writeFileSync(own, "broken");
    expect(() =>
      config.syncSettings({
        profileId: follower,
        from: source,
        parts: ["notifications"],
        keepInSync: false,
      }),
    ).toThrow();
    expect(fs.readFileSync(own, "utf8")).toBe("broken");
  });

  it("refuses to import from itself or a missing profile", () => {
    const { config, source } = setup();
    expect(() =>
      config.syncSettings({
        profileId: source,
        from: source,
        parts: ["appearance"],
        keepInSync: true,
      }),
    ).toThrow("another profile");
    expect(() =>
      config.syncSettings({
        profileId: source,
        from: "missing",
        parts: ["appearance"],
        keepInSync: true,
      }),
    ).toThrow("another profile");
  });
});
