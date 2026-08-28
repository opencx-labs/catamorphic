import { describe, expect, it } from "vitest";
import {
  defaultDesktopProjectsDir,
  desktopDataDirFromEnvironment,
} from "./development-paths.js";

describe("desktopDataDirFromEnvironment", () => {
  it("uses the worktree-scoped development data directory", () => {
    expect(
      desktopDataDirFromEnvironment({
        CATAMORPHIC_DESKTOP_DATA_DIR: "/tmp/cata-a/desktop",
      }),
    ).toBe("/tmp/cata-a/desktop");
  });

  it("keeps the E2E directory isolated when both variables are present", () => {
    expect(
      desktopDataDirFromEnvironment({
        CATAMORPHIC_DESKTOP_DATA_DIR: "/tmp/cata-a/desktop",
        CATAMORPHIC_E2E_DATA_DIR: "/tmp/e2e/desktop",
      }),
    ).toBe("/tmp/e2e/desktop");
  });
});

describe("defaultDesktopProjectsDir", () => {
  it("stores projects below the worktree-scoped development data directory", () => {
    expect(
      defaultDesktopProjectsDir({
        env: {
          CATAMORPHIC_DESKTOP_DATA_DIR: "/tmp/cata-a/desktop",
        },
        homeDir: "/Users/catamorphic",
      }),
    ).toBe("/tmp/cata-a/desktop/Catamorphic");
  });

  it("keeps the home directory default outside isolated development", () => {
    expect(
      defaultDesktopProjectsDir({
        env: {},
        homeDir: "/Users/catamorphic",
      }),
    ).toBe("/Users/catamorphic/Catamorphic");
  });
});
