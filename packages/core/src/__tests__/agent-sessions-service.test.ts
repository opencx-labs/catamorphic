import { describe, expect, it } from "vitest";
import { parsePorcelain } from "../services/agent-sessions-service.js";
import { TEMPLATES } from "../templates.js";

describe("parsePorcelain", () => {
  it("parses modified, added, untracked, and deleted entries", () => {
    const output = [
      " M src/index.ts",
      "A  src/new.ts",
      "?? notes.txt",
      " D removed.ts",
    ].join("\n");

    expect(parsePorcelain(output)).toEqual([
      { path: "src/index.ts", kind: "modified" },
      { path: "src/new.ts", kind: "modified" },
      { path: "notes.txt", kind: "modified" },
      { path: "removed.ts", kind: "deleted" },
    ]);
  });

  it("expands renames into delete + modify", () => {
    expect(parsePorcelain("R  old.ts -> new.ts")).toEqual([
      { path: "old.ts", kind: "deleted" },
      { path: "new.ts", kind: "modified" },
    ]);
  });

  it("unquotes paths with special characters", () => {
    expect(parsePorcelain('?? "file with space.txt"')).toEqual([
      { path: "file with space.txt", kind: "modified" },
    ]);
  });

  it("skips untracked directory entries", () => {
    expect(parsePorcelain("?? src/\n?? src/flow.ts")).toEqual([
      { path: "src/flow.ts", kind: "modified" },
    ]);
  });

  it("returns nothing for empty output", () => {
    expect(parsePorcelain("")).toEqual([]);
    expect(parsePorcelain("\n\n")).toEqual([]);
  });
});

describe("template skill seeding", () => {
  it("every template ships the writing-workflows skill", () => {
    for (const template of TEMPLATES) {
      const skill = template.files[".agents/skills/writing-workflows/SKILL.md"];
      expect(skill, `template ${template.id}`).toBeDefined();
      expect(skill).toContain("name: writing-workflows");
      expect(skill).toContain('"use workflow"');
    }
  });
});
