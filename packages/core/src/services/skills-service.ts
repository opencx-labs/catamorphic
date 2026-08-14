import type { DB } from "@catamorphic/db";
import type { ProjectManager, ProjectRepo } from "@catamorphic/git";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import { ProjectNotFoundError } from "./projects-service.js";

/**
 * Directory (relative to the project root) where per-project agent skills
 * live, following the Agent Skills spec layout:
 *
 * ```
 * .agents/skills/<name>/SKILL.md
 * .agents/skills/<name>/references/…
 * ```
 *
 * The project repo is the single source of truth for these skills — its
 * canonical storage is the project origin (e.g. Cloudflare Artifacts), so
 * skills are versioned with the workflow code and scoped per project/tenant
 * by construction. Coding agents read them from the dev sandbox checkout; no
 * separate skill store exists.
 */
export const SKILLS_DIR = ".agents/skills";

export interface ProjectSkill {
  /** Directory name == declared skill name. */
  name: string;
  description: string;
  /**
   * For project skills, the SKILL.md path relative to the project root; for
   * host skills, relative to the host-skills root (`<name>/SKILL.md`).
   */
  path: string;
  /**
   * Which tier the skill comes from: `project` = a file in the project repo,
   * `host` = shipped by the host app (ADR 0049), not present in the repo.
   */
  source: "project" | "host";
}

/**
 * Read-only view over a project's `.agents/skills/` directory, merged with
 * the host-tier skill set (ADR 0049). Writes go through the normal project
 * file APIs (project skills are just files in the repo); host skills are
 * config, resolved once at boot.
 */
export class SkillsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly opts: { hostSkills?: Record<string, string> } = {},
  ) {}

  async list(identity: Identity, projectId: string): Promise<ProjectSkill[]> {
    await this.requireProject(identity, projectId);
    const projectSkills = await this.withDev(identity, projectId, (repo) =>
      this.listProjectSkills(repo),
    );
    // A project skill shadows a host skill of the same name: the repo is the
    // more specific tier, and shadowing is how a project customizes a host
    // playbook.
    const taken = new Set(projectSkills.map((skill) => skill.name));
    const merged = [
      ...projectSkills,
      ...this.hostSkills().filter((skill) => !taken.has(skill.name)),
    ];
    return merged.sort((a, b) => a.name.localeCompare(b.name));
  }

  /**
   * A skill's SKILL.md content by declared name, from either tier (project
   * wins). `null` when no skill carries the name.
   */
  async read(
    identity: Identity,
    projectId: string,
    name: string,
  ): Promise<{ skill: ProjectSkill; content: string } | null> {
    await this.requireProject(identity, projectId);
    const fromProject = await this.withDev(
      identity,
      projectId,
      async (repo) => {
        const skills = await this.listProjectSkills(repo);
        const skill = skills.find((entry) => entry.name === name);
        if (!skill) return null;
        return { skill, content: await repo.readFile(skill.path) };
      },
    );
    if (fromProject) return fromProject;
    const host = this.hostSkills().find((skill) => skill.name === name);
    if (!host) return null;
    const content = this.opts.hostSkills?.[host.path];
    return content === undefined ? null : { skill: host, content };
  }

  private async listProjectSkills(repo: ProjectRepo): Promise<ProjectSkill[]> {
    const files = await repo.listFiles();
    const skillFiles = files.filter(
      (file) => file.startsWith(`${SKILLS_DIR}/`) && file.endsWith("/SKILL.md"),
    );

    const skills = await Promise.all(
      skillFiles.map(async (file) => {
        const source = await repo.readFile(file);
        const frontmatter = parseSkillFrontmatter(source);
        const dirName = file.slice(
          SKILLS_DIR.length + 1,
          file.length - "/SKILL.md".length,
        );
        return {
          name: frontmatter.name ?? dirName,
          description: frontmatter.description ?? "",
          path: file,
          source: "project" as const,
        };
      }),
    );

    return skills.sort((a, b) => a.name.localeCompare(b.name));
  }

  private hostSkills(): ProjectSkill[] {
    return Object.entries(this.opts.hostSkills ?? {})
      .filter(([path]) => path.endsWith("/SKILL.md"))
      .map(([path, content]) => {
        const frontmatter = parseSkillFrontmatter(content);
        const dirName = path.slice(0, path.length - "/SKILL.md".length);
        return {
          name: frontmatter.name ?? dirName,
          description: frontmatter.description ?? "",
          path,
          source: "host" as const,
        };
      });
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }

  private async withDev<T>(
    identity: Identity,
    projectId: string,
    fn: (repo: ProjectRepo) => Promise<T>,
  ): Promise<T> {
    const repo = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      return await fn(repo);
    } finally {
      await repo.dispose();
    }
  }
}

/**
 * Minimal YAML frontmatter reader for SKILL.md files — only flat
 * `key: value` string pairs are recognized, which is all the Agent Skills
 * spec requires for `name` and `description`. Exported so hosts materializing
 * skill sets (e.g. the desktop's host-skills plugin) parse identically.
 */
export function parseSkillFrontmatter(source: string): {
  name?: string;
  description?: string;
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  const result: { name?: string; description?: string } = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "name") result.name = value;
    if (key === "description") result.description = value;
  }
  return result;
}
