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
 * by construction. Coding agents discover them from the dev sandbox checkout
 * (Flue does this natively); no separate skill store exists.
 */
export const SKILLS_DIR = ".agents/skills";

export interface ProjectSkill {
  /** Directory name == declared skill name. */
  name: string;
  description: string;
  /** Path of the SKILL.md relative to the project root. */
  path: string;
}

/**
 * Read-only view over a project's `.agents/skills/` directory. Writes go
 * through the normal project file APIs (skills are just files in the repo).
 */
export class SkillsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
  ) {}

  async list(identity: Identity, projectId: string): Promise<ProjectSkill[]> {
    await this.requireProject(identity, projectId);
    return this.withDev(identity, projectId, async (repo) => {
      const files = await repo.listFiles();
      const skillFiles = files.filter(
        (file) =>
          file.startsWith(`${SKILLS_DIR}/`) && file.endsWith("/SKILL.md"),
      );

      const skills = await Promise.all(
        skillFiles.map(async (file) => {
          const source = await repo.readFile(file);
          const frontmatter = parseFrontmatter(source);
          const dirName = file.slice(
            SKILLS_DIR.length + 1,
            file.length - "/SKILL.md".length,
          );
          return {
            name: frontmatter.name ?? dirName,
            description: frontmatter.description ?? "",
            path: file,
          };
        }),
      );

      return skills.sort((a, b) => a.name.localeCompare(b.name));
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
 * spec requires for `name` and `description`.
 */
function parseFrontmatter(source: string): {
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
