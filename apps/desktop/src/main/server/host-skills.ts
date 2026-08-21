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
  /** Where the skills were materialized (path hint for tool-less harnesses). */
  skillsDir: string;
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

  return { plugin: { name: PLUGIN_NAME, path: dir }, skills, skillsDir };
}

const SKILLS_PREAMBLE =
  "Skills are reusable playbooks invoked by name — when the user asks to \"use the X skill\" (the app's command palette and /commands send exactly that phrasing), or a task matches a skill's description, load the skill and follow it.";

function listing(skills: Array<{ name: string; description: string }>): string {
  return skills
    .map((skill) =>
      skill.description
        ? `  - ${skill.name}: ${skill.description}`
        : `  - ${skill.name}`,
    )
    .join("\n");
}

export interface SkillsNoteOpts {
  /** App-tier skills (the materialized host set). */
  appSkills: Array<{ name: string; description: string }>;
  /** Materialized app-skills root, the path hint for tool-less harnesses. */
  appSkillsDir?: string;
  /** The user's personal tier (ADR 0056). */
  userSkills?: Array<{ name: string; description: string }>;
  /**
   * A picked-skills agent's offer (ADR 0056): only these names appear.
   * Undefined = every skill; an empty pick = no skills section at all.
   */
  picked?: string[];
  /** Whether this harness carries the read_skill workspace tool. */
  hasTools: boolean;
}

/**
 * The system-prompt Skills section for one agent: the tier listings —
 * project (generic; the repo's contents aren't known here), user, app —
 * narrowed to the agent's picked set when it has one.
 */
export function composeSkillsNote(opts: SkillsNoteOpts): string | undefined {
  const load = opts.hasTools
    ? "Load a skill by name with the read_skill workspace tool (or your native Skill tool when it lists the name)."
    : opts.appSkillsDir
      ? `App skills live at \`${opts.appSkillsDir}/<name>/SKILL.md\` — read the file before following one.`
      : undefined;

  if (opts.picked) {
    if (opts.picked.length === 0) return undefined;
    const known = new Map(
      [...opts.appSkills, ...(opts.userSkills ?? [])].map((skill) => [
        skill.name,
        skill,
      ]),
    );
    const rows = opts.picked.map((name) => {
      const skill = known.get(name);
      return skill?.description ? `  - ${name}: ${skill.description}` : `  - ${name}`;
    });
    return [
      "## Skills",
      "",
      SKILLS_PREAMBLE,
      "",
      `This agent is offered ONLY these skills:\n${rows.join("\n")}`,
      ...(load ? ["", load] : []),
    ].join("\n");
  }

  const userSkills = opts.userSkills ?? [];
  const tiers = [
    "- Project skills: files in this project under `.agents/skills/<name>/SKILL.md`.",
    ...(userSkills.length > 0
      ? [`- The user's personal skills (theirs alone):\n${listing(userSkills)}`]
      : []),
    ...(opts.appSkills.length > 0
      ? [
          `- App skills, shipped by the app the user is working in:\n${listing(opts.appSkills)}`,
        ]
      : []),
  ];
  return [
    "## Skills",
    "",
    `${SKILLS_PREAMBLE} The tiers:`,
    "",
    ...tiers,
    ...(load ? ["", load] : []),
  ].join("\n");
}
