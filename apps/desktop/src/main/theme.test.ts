import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ProfileConfigManager } from "./profile-config.js";
import { ProfilesStore } from "./profiles.js";
import type { DataPaths } from "./server/paths.js";
import {
  DEFAULT_THEME,
  normalizeTheme,
  resolveTheme,
  ThemeStore,
} from "./theme.js";

const temporaryDirectories: string[] = [];
const profileConfigManagers: ProfileConfigManager[] = [];

afterEach(() => {
  for (const manager of profileConfigManagers.splice(0)) manager.dispose();
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("desktop theme", () => {
  it("uses the system selection when no profile preference exists", () => {
    expect(DEFAULT_THEME).toEqual({ selection: "system", overrides: {} });

    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-theme-"));
    temporaryDirectories.push(directory);
    const store = new ThemeStore(
      path.join(directory, "theme.json"),
      () => "light",
    );

    expect(store.load()).toEqual(DEFAULT_THEME);
    expect(store.resolved()).toMatchObject({
      selection: "system",
      preset: "light",
      appearance: "light",
    });
  });

  it("re-resolves a system selection when the operating system changes", () => {
    let appearance: "dark" | "light" = "dark";
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-theme-"));
    temporaryDirectories.push(directory);
    const store = new ThemeStore(
      path.join(directory, "theme.json"),
      () => appearance,
    );
    store.save({ selection: "system", overrides: {} });

    expect(store.resolved()).toMatchObject({
      preset: "dark",
      appearance: "dark",
    });
    appearance = "light";
    expect(store.resolved()).toMatchObject({
      preset: "light",
      appearance: "light",
    });
  });

  it("keeps an explicit preset fixed when the system appearance differs", () => {
    expect(
      resolveTheme({ selection: "dark", overrides: {} }, "light"),
    ).toMatchObject({
      selection: "dark",
      preset: "dark",
      appearance: "dark",
    });
  });

  it("preserves pre-system theme files as explicit selections", () => {
    expect(normalizeTheme({ preset: "paper", overrides: {} })).toEqual({
      selection: "paper",
      overrides: {},
    });
  });

  it("broadcasts a newly resolved system theme but leaves fixed themes alone", () => {
    let appearance: "dark" | "light" = "dark";
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "cat-theme-"));
    temporaryDirectories.push(root);
    const dataRoot = path.join(root, "data");
    const paths: DataPaths = {
      root: dataRoot,
      db: path.join(dataRoot, "db"),
      projects: path.join(dataRoot, "projects"),
      remotes: path.join(dataRoot, "remotes"),
      appBundles: path.join(dataRoot, "app-bundles"),
      githubFile: path.join(root, "github.json"),
      profilesFile: path.join(root, "profiles.json"),
      profilesDir: path.join(root, "profiles"),
      agentHomesDir: path.join(root, "agent-homes"),
      hostSkillsDir: path.join(root, "host-skills"),
    };
    const manager = new ProfileConfigManager(
      paths,
      new ProfilesStore(paths.profilesFile),
      () => appearance,
    );
    profileConfigManagers.push(manager);
    manager
      .forProfile("system-profile")
      .theme.save({ selection: "system", overrides: {} });
    manager
      .forProfile("fixed-profile")
      .theme.save({ selection: "dark", overrides: {} });
    const changes: Array<{ profileId: string; appearance: string }> = [];
    manager.onThemeChanged((profileId, theme) => {
      changes.push({ profileId, appearance: theme.appearance });
    });

    appearance = "light";
    manager.systemAppearanceChanged();

    expect(changes).toEqual([
      { profileId: "system-profile", appearance: "light" },
    ]);
  });
});
