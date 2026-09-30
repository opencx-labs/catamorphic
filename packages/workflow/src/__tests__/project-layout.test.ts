import { describe, expect, it } from "vitest";
import {
  appWorkspaceName,
  draftRef,
  hasProjectLockfile,
  isProjectPathWithin,
  isProjectSourcePath,
  PROJECT_APPS_DIR,
  PROJECT_MANIFEST_PATH,
  projectPath,
  publishedRef,
} from "../project-layout.js";

describe("project layout", () => {
  it("derives every path from the workspace folder", () => {
    expect(projectPath("skills", "notes")).toBe(".work/skills/notes");
    expect(PROJECT_MANIFEST_PATH).toBe(".work/project.json");
    expect(publishedRef()).toBe("refs/work/published/main");
    expect(publishedRef("draft")).toBe("refs/work/published/draft");
  });

  it("matches whole path segments only", () => {
    expect(isProjectPathWithin(".work/apps/x/a.ts", PROJECT_APPS_DIR)).toBe(
      true,
    );
    expect(isProjectPathWithin("/.work/apps", PROJECT_APPS_DIR)).toBe(true);
    expect(isProjectPathWithin(".work/apps-old/a.ts", PROJECT_APPS_DIR)).toBe(
      false,
    );
  });

  it("separates program sources from mutable app data", () => {
    expect(isProjectSourcePath(".work/workflows/src/a.ts")).toBe(true);
    expect(isProjectSourcePath(".work/app-data/store/a.md")).toBe(false);
    expect(isProjectSourcePath("docs/readme.md")).toBe(false);
  });

  it("names app workspaces from their manifests", () => {
    expect(appWorkspaceName(".work/apps/review/package.json")).toBe("review");
    expect(appWorkspaceName(".work/apps/review/src/package.json")).toBe(
      undefined,
    );
    expect(appWorkspaceName(".work/workflows/package.json")).toBe(undefined);
  });

  it("names one valid draft ref per member", () => {
    expect(draftRef("alice")).toBe("refs/work/drafts/alice");
    expect(draftRef("user-1")).toBe("refs/work/drafts/user-1");
    expect(draftRef("bob@example.com")).toBe(
      "refs/work/drafts/bob_40example_2ecom",
    );
    expect(draftRef("a_b")).not.toBe(draftRef("a/b"));
    // Ids that differ only by case never share a ref on a case-insensitive disk.
    expect(draftRef("Alice")).toBe("refs/work/drafts/_41lice");
    expect(draftRef("Alice").toLowerCase()).not.toBe(
      draftRef("alice").toLowerCase(),
    );
    expect(draftRef("../../heads/main")).toMatch(
      /^refs\/work\/drafts\/[A-Za-z0-9_-]+$/,
    );
    expect(() => draftRef("")).toThrow();
  });

  it("detects either capability lockfile", () => {
    expect(hasProjectLockfile({ ".work/bun.lockb": "" })).toBe(true);
    expect(hasProjectLockfile({ "bun.lock": "" })).toBe(false);
  });
});
