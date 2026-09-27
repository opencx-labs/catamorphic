import { parseProject } from "@catamorphic/parser";
import { describe, expect, it } from "vitest";
import { appScaffold, SEED_SKILLS, workspaceFiles } from "../seeds.js";

/**
 * There are no project templates (ADR 0051): agents build everything from
 * blank projects guided by the seed skills, copying the skills' support
 * files instead of reconstructing scaffolding from memory. These tests pin
 * the guarantees that replace templates: the canonical scaffold stays
 * parseable, and every file a skill tells the agent to copy actually ships.
 */
describe("workspace scaffold", () => {
  it("parses clean with an app scaffold on top", () => {
    const files = {
      ...workspaceFiles({ name: "any-project" }),
      ...appScaffold({ name: "dashboard" }),
    };
    const parsed = parseProject(files);
    expect(parsed.errors).toEqual([]);

    const root = JSON.parse(files[".work/package.json"] ?? "{}");
    expect(root.workspaces).toEqual(["contracts", "workflows", "apps/*"]);
    expect(files[".work/apps/dashboard/vite.config.ts"]).toContain("iife");
    // Apps must never depend on the workflows package.
    expect(files[".work/apps/dashboard/package.json"]).not.toContain(
      "@project/workflows",
    );
  });
});

describe("seed skill support files", () => {
  const supportFiles = (skill: string) =>
    Object.keys(SEED_SKILLS).filter((path) =>
      path.startsWith(`.work/skills/${skill}/files/`),
    );

  it("ships every file the work-projects skill says to copy", () => {
    const skill = SEED_SKILLS[".work/skills/work-projects/SKILL.md"];
    expect(skill).toBeDefined();
    for (const path of supportFiles("work-projects")) {
      const name = path.split("/").at(-1);
      expect(skill).toContain(`files/${name}`);
    }
    // The copyable workspace scaffold matches the canonical one.
    expect(
      SEED_SKILLS[".work/skills/work-projects/files/check.ts"],
    ).toBe(workspaceFiles({ name: "my-project" })[".work/scripts/check.ts"]);
  });

  it("ships every file the building-apps skill says to copy", () => {
    const skill = SEED_SKILLS[".work/skills/building-apps/SKILL.md"];
    expect(skill).toBeDefined();
    const files = supportFiles("building-apps");
    expect(files.length).toBeGreaterThan(0);
    for (const path of files) {
      const name = path.split("/").at(-1);
      expect(skill).toContain(`files/${name}`);
    }
    // The copyable app scaffold matches the canonical one.
    expect(SEED_SKILLS[".work/skills/building-apps/files/vite.config.ts"]).toBe(
      appScaffold({ name: "my-app" })[".work/apps/my-app/vite.config.ts"],
    );
  });
});
