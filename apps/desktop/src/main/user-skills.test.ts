import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { userSkillFiles, userSkillInfos } from "./user-skills.js";

const tmpdirs: string[] = [];
function skillsDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "user-skills-"));
  tmpdirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tmpdirs.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

function writeSkill(dir: string, name: string, content: string): void {
  fs.mkdirSync(path.join(dir, name), { recursive: true });
  fs.writeFileSync(path.join(dir, name, "SKILL.md"), content);
}

describe("user skill tier (ADR 0056)", () => {
  it("reads <name>/SKILL.md files keyed like the host tier", () => {
    const dir = skillsDir();
    writeSkill(
      dir,
      "expenses",
      "---\nname: expenses\ndescription: File my expenses\n---\nBody",
    );
    // A directory without SKILL.md is not a skill; loose files are ignored.
    fs.mkdirSync(path.join(dir, "empty"));
    fs.writeFileSync(path.join(dir, "README.md"), "not a skill");

    expect(Object.keys(userSkillFiles(dir))).toEqual(["expenses/SKILL.md"]);
    expect(userSkillInfos(dir)).toEqual([
      { name: "expenses", description: "File my expenses" },
    ]);
  });

  it("a missing directory is an empty tier", () => {
    expect(userSkillFiles("/nonexistent/nowhere")).toEqual({});
    expect(userSkillInfos("/nonexistent/nowhere")).toEqual([]);
  });
});
