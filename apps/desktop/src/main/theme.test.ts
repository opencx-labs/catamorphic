import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DEFAULT_THEME_FONTS } from "../shared/theme-fonts.js";
import { ProfileConfigManager } from "./profile-config.js";
import { ProfilesStore } from "./profiles.js";
import type { DataPaths } from "./server/paths.js";
import {
  DEFAULT_THEME,
  normalizeTheme,
  resolveTheme,
  ThemeStore,
  validateThemeConfig,
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
  it("persists font choices and restores omitted fonts to their defaults", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-theme-"));
    temporaryDirectories.push(directory);
    const store = new ThemeStore(path.join(directory, "theme.json"));
    store.save({
      selection: "paper",
      overrides: { accent: "#123456" },
      fonts: { sans: "  Arial, sans-serif  ", mono: "Menlo, monospace" },
    });
    expect(store.resolved()).toMatchObject({
      colors: { accent: "#123456" },
      fonts: { sans: "Arial, sans-serif", mono: "Menlo, monospace" },
    });
    store.save({ ...store.load(), fonts: { mono: "Menlo, monospace" } });
    expect(store.resolved().fonts).toEqual({
      sans: DEFAULT_THEME_FONTS.sans,
      mono: "Menlo, monospace",
    });
    store.save({ selection: "system", overrides: {} });
    expect(store.resolved().fonts).toEqual(DEFAULT_THEME_FONTS);
  });

  it.each([
    "",
    "  ",
    42,
    null,
    "Arial; color:red",
    "</style>",
    "url(font.woff2)",
    "var(--font)",
    "Arial,",
    "x".repeat(201),
  ])(
    "drops invalid font values without losing valid colors or the other font: %s",
    (sans) => {
      expect(
        normalizeTheme({
          selection: "light",
          overrides: { accent: "#123456" },
          fonts: { sans, mono: '"SF Mono", monospace', unknown: "Arial" },
        }),
      ).toEqual({
        selection: "light",
        overrides: { accent: "#123456" },
        fonts: { mono: '"SF Mono", monospace' },
      });
    },
  );

  it.each(["light", "dark"] as const)(
    "uses the system %s appearance when no profile preference exists",
    (appearance) => {
      expect(DEFAULT_THEME).toEqual({ selection: "system", overrides: {} });

      const directory = fs.mkdtempSync(path.join(os.tmpdir(), "cat-theme-"));
      temporaryDirectories.push(directory);
      const store = new ThemeStore(
        path.join(directory, "theme.json"),
        () => appearance,
      );

      expect(store.load()).toEqual(DEFAULT_THEME);
      expect(store.resolved()).toMatchObject({
        selection: "system",
        preset: appearance,
        appearance,
      });
    },
  );

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

  it("keeps https backgrounds per surface, fills defaults and drops the rest", () => {
    expect(
      normalizeTheme({
        backgrounds: {
          left: { image: "https://example.com/a.png", pixelate: 4, blur: 99 },
          right: { image: "file:///etc/passwd" },
          chat: { image: "https://example.com/b.png", position: "center" },
          footer: { image: "https://example.com/c.png" },
        },
      }).backgrounds,
    ).toEqual({
      left: {
        image: "https://example.com/a.png",
        position: "bottom",
        opacity: 0.35,
        blur: 0,
        pixelate: 4,
      },
      chat: {
        image: "https://example.com/b.png",
        position: "center",
        opacity: 0.35,
        blur: 0,
        pixelate: 1,
      },
    });
    expect(() =>
      validateThemeConfig({
        backgrounds: { left: { image: "http://x.test/a.png" } },
      }),
    ).toThrow("needs an https image");
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
      profilesFile: path.join(root, "profiles.json"),
      profilesDir: path.join(root, "profiles"),
      agentHomesDir: path.join(root, "agent-homes"),
      harnessComponentsDir: path.join(root, "harness-components"),
      hostSkillsDir: path.join(root, "host-skills"),
      bookmarksFile: path.join(root, "bookmarks.json"),
      attachmentsDir: path.join(root, "attachments"),
    };
    const profiles = new ProfilesStore(paths.profilesFile);
    const systemProfile = profiles.create("System");
    const fixedProfile = profiles.create("Fixed");
    const manager = new ProfileConfigManager(paths, profiles, () => appearance);
    profileConfigManagers.push(manager);
    manager
      .forProfile(systemProfile.id)
      .theme.save({ selection: "system", overrides: {} });
    manager
      .forProfile(fixedProfile.id)
      .theme.save({ selection: "dark", overrides: {} });
    const changes: Array<{ profileId: string; appearance: string }> = [];
    manager.onThemeChanged((profileId, theme) => {
      changes.push({ profileId, appearance: theme.appearance });
    });

    appearance = "light";
    manager.systemAppearanceChanged();

    expect(changes).toEqual([
      { profileId: systemProfile.id, appearance: "light" },
    ]);
  });
});
