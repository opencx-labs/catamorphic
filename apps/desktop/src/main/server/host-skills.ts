import fs from "node:fs";
import path from "node:path";
import { parseSkillFrontmatter } from "@catamorphic/core";
import type { AgentPluginConfig } from "@catamorphic/sandbox";

/**
 * Host-tier skills (ADR 0049), wired into every harness.
 *
 * The resolved host skill set is materialized on disk as a Claude Code
 * plugin — `.claude-plugin/plugin.json` plus `skills/<name>/SKILL.md` — so
 * the claude-code harness discovers and preloads the skills natively (the
 * `plugins` option it already takes for connectors). The app-data plugin is
 * the projection; core's `hostSkillFiles` stays the source of truth, and no
 * file is ever written into the user's project.
 *
 * Harnesses without native skill support get the same set through
 * {@link HostSkillsRuntime.note}: a system-prompt section listing every
 * host skill with instructions for loading one (the read_skill workspace
 * tool, or the materialized path for tool-less harnesses).
 */
export interface HostSkillsRuntime {
  /** The materialized plugin, for harnesses that load plugins natively. */
  plugin: AgentPluginConfig;
  /** Names + descriptions, for skill listings composed elsewhere. */
  skills: Array<{ name: string; description: string }>;
  /** System-prompt section for a harness with/without workspace tools. */
  note: (hasTools: boolean) => string;
}

const PLUGIN_NAME = "catamorphic";

/**
 * Write the host skill set under `dir` (wiping any previous materialization)
 * and describe how each harness reaches it. Returns undefined when the host
 * ships no skills.
 */
export function materializeHostSkills(
  dir: string,
  hostSkillFiles: Record<string, string>,
): HostSkillsRuntime | undefined {
  const entries = Object.entries(hostSkillFiles);
  if (entries.length === 0) return undefined;

  const skillsDir = path.join(dir, "skills");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(path.join(dir, ".claude-plugin"), { recursive: true });
  fs.writeFileSync(
    path.join(dir, ".claude-plugin", "plugin.json"),
    `${JSON.stringify(
      {
        name: PLUGIN_NAME,
        description: "Skills shipped by the app (host tier, ADR 0049)",
        version: "1.0.0",
      },
      null,
      2,
    )}\n`,
  );
  for (const [relPath, content] of entries) {
    // Keys are host-root-relative (`<name>/SKILL.md`); refuse anything that
    // would escape the skills dir.
    const target = path.join(skillsDir, relPath);
    if (!target.startsWith(`${skillsDir}${path.sep}`)) continue;
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }

  const skills = entries
    .filter(([relPath]) => relPath.endsWith("/SKILL.md"))
    .map(([relPath, content]) => {
      const frontmatter = parseSkillFrontmatter(content);
      return {
        name:
          frontmatter.name ??
          relPath.slice(0, relPath.length - "/SKILL.md".length),
        description: frontmatter.description ?? "",
      };
    });

  const listing = skills
    .map((skill) =>
      skill.description
        ? `  - ${skill.name}: ${skill.description}`
        : `  - ${skill.name}`,
    )
    .join("\n");

  const note = (hasTools: boolean) =>
    [
      "## Skills",
      "",
      "Skills are reusable playbooks invoked by name — when the user asks to \"use the X skill\" (the app's command palette and /commands send exactly that phrasing), or a task matches a skill's description, load the skill and follow it. Two tiers exist:",
      "",
      "- Project skills: files in this project under `.agents/skills/<name>/SKILL.md`.",
      `- App skills, shipped by the app the user is working in:\n${listing}`,
      "",
      hasTools
        ? "Load either tier by name with the read_skill workspace tool (or your native Skill tool when it lists the name)."
        : `App skills live at \`${skillsDir}/<name>/SKILL.md\` — read the file before following one.`,
    ].join("\n");

  return { plugin: { name: PLUGIN_NAME, path: dir }, skills, note };
}
