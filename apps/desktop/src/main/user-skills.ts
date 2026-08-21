import fs from "node:fs";
import path from "node:path";
import { parseSkillFrontmatter } from "@catamorphic/core";

/**
 * The user's personal skill tier (ADR 0056): `profiles/<id>/skills/`, laid
 * out like every other tier — `<name>/SKILL.md`. Purely local: never in any
 * repo, never on the shared surface, edited directly by the user (or an
 * agent they ask). Read live on every call so an edit applies to the next
 * listing without a restart; a missing directory is simply an empty tier.
 */
export function userSkillFiles(skillsDir: string): Record<string, string> {
  const files: Record<string, string> = {};
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      files[`${entry.name}/SKILL.md`] = fs.readFileSync(
        path.join(skillsDir, entry.name, "SKILL.md"),
        "utf-8",
      );
    } catch {
      // A skill directory without a readable SKILL.md is not a skill.
    }
  }
  return files;
}

/** Name + description per user skill, for prompt listings. */
export function userSkillInfos(
  skillsDir: string,
): Array<{ name: string; description: string }> {
  return Object.entries(userSkillFiles(skillsDir)).map(([relPath, content]) => {
    const frontmatter = parseSkillFrontmatter(content);
    return {
      name:
        frontmatter.name ??
        relPath.slice(0, relPath.length - "/SKILL.md".length),
      description: frontmatter.description ?? "",
    };
  });
}
