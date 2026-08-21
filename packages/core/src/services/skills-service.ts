import type { DB } from "@catamorphic/db";
import type { ProjectManager, ProjectRepo } from "@catamorphic/git";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import { readProgramFiles, withProgram } from "./program-reader.js";
import { requireTenantProject } from "./projects-service.js";

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
  /**
   * Human-facing name: the frontmatter `title` when declared, else the
   * kebab name humanized ("team-notes" → "Team notes"). What non-technical
   * surfaces (palette rows, menus) should show instead of the slug.
   */
  title: string;
  description: string;
  /**
   * For project skills, the SKILL.md path relative to the project root; for
   * host skills, relative to the host-skills root (`<name>/SKILL.md`).
   */
  path: string;
  /**
   * Which tier the skill comes from: `project` = a file in the project repo,
   * `user` = the calling user's personal tier (ADR 0056 — never in any
   * repo, never shared), `host` = shipped by the host app (ADR 0049).
   */
  source: "project" | "user" | "host";
}

/**
 * Read-only view over a project's `.agents/skills/` directory, merged with
 * the calling user's personal tier (ADR 0056) and the host-tier skill set
 * (ADR 0049). Writes go through the normal project file APIs (project
 * skills are just files in the repo); host skills are config, resolved once
 * at boot; user skills are read live through the `userSkills` hook — the
 * host resolves the caller's personal skill files (`<name>/SKILL.md` keys,
 * like `hostSkills`) so an edit applies on the next list.
 */
export class SkillsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    private readonly opts: {
      hostSkills?: Record<string, string>;
      userSkills?: (
        identity: Identity,
        projectId: string,
      ) => Record<string, string>;
    } = {},
  ) {}

  async list(identity: Identity, projectId: string): Promise<ProjectSkill[]> {
    await this.requireProject(identity, projectId);
    const projectSkills = await this.withDev(identity, projectId, (repo) =>
      this.listProjectSkills(repo),
    );
    // Shadowing by name, most specific first: project > user > host. The
    // repo outranks personal customization (committed team doctrine stays
    // consistent for everyone); personal outranks shipped defaults.
    const taken = new Set(projectSkills.map((skill) => skill.name));
    const userSkills = this.userSkills(identity, projectId).filter(
      (skill) => !taken.has(skill.name),
    );
    for (const skill of userSkills) taken.add(skill.name);
    const merged = [
      ...projectSkills,
      ...userSkills,
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
    const userFiles = this.opts.userSkills?.(identity, projectId) ?? {};
    const user = skillsFromTier(userFiles, "user").find(
      (skill) => skill.name === name,
    );
    if (user) {
      const content = userFiles[user.path];
      if (content !== undefined) return { skill: user, content };
    }
    const host = this.hostSkills().find((skill) => skill.name === name);
    if (!host) return null;
    const content = this.opts.hostSkills?.[host.path];
    return content === undefined ? null : { skill: host, content };
  }

  /**
   * The skills as shared (ADR 0055): the program at origin main plus the
   * host tier, read without a caller working copy — what the project MCP
   * endpoint serves to members whose only relationship to the project is
   * using it. Callers gate access (builder or agent ref) before calling.
   */
  async listShared(
    identity: Identity,
    projectId: string,
  ): Promise<ProjectSkill[]> {
    await this.requireProject(identity, projectId);
    const files = await withProgram(
      this.projectManager,
      identity.tenantId,
      projectId,
      (repo, ref) => readProgramFiles(repo, ref, `${SKILLS_DIR}/`),
    );
    const projectSkills = skillsFromFiles(files);
    const names = new Set(projectSkills.map((skill) => skill.name));
    return [
      ...projectSkills,
      ...this.hostSkills().filter((skill) => !names.has(skill.name)),
    ].sort((a, b) => a.name.localeCompare(b.name));
  }

  /** One skill's content, as shared (see {@link listShared}). */
  async readShared(
    identity: Identity,
    projectId: string,
    name: string,
  ): Promise<{ skill: ProjectSkill; content: string } | null> {
    await this.requireProject(identity, projectId);
    const files = await withProgram(
      this.projectManager,
      identity.tenantId,
      projectId,
      (repo, ref) => readProgramFiles(repo, ref, `${SKILLS_DIR}/`),
    );
    const skill = skillsFromFiles(files).find((entry) => entry.name === name);
    if (skill) {
      const content = files[skill.path];
      if (content !== undefined) return { skill, content };
    }
    const host = this.hostSkills().find((entry) => entry.name === name);
    if (!host) return null;
    const content = this.opts.hostSkills?.[host.path];
    return content === undefined ? null : { skill: host, content };
  }

  private async listProjectSkills(repo: ProjectRepo): Promise<ProjectSkill[]> {
    const files = await repo.listFiles();
    const skillFiles = files.filter(
      (file) => file.startsWith(`${SKILLS_DIR}/`) && file.endsWith("/SKILL.md"),
    );
    const contents = await Promise.all(
      skillFiles.map(
        async (file) => [file, await repo.readFile(file)] as const,
      ),
    );
    return skillsFromFiles(Object.fromEntries(contents));
  }

  private hostSkills(): ProjectSkill[] {
    return skillsFromTier(this.opts.hostSkills ?? {}, "host");
  }

  /**
   * The caller's personal skills (ADR 0056). Deliberately absent from the
   * shared surface (listShared/readShared) — they are personal.
   */
  private userSkills(identity: Identity, projectId: string): ProjectSkill[] {
    return skillsFromTier(
      this.opts.userSkills?.(identity, projectId) ?? {},
      "user",
    );
  }

  private requireProject(identity: Identity, projectId: string) {
    return requireTenantProject(this.db, identity.tenantId, projectId);
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
 * Tier-root-relative `<name>/SKILL.md` files → skills (the host and user
 * tiers share this key convention).
 */
function skillsFromTier(
  files: Record<string, string>,
  source: "user" | "host",
): ProjectSkill[] {
  return Object.entries(files)
    .filter(([path]) => path.endsWith("/SKILL.md"))
    .map(([path, content]) => {
      const frontmatter = parseSkillFrontmatter(content);
      const dirName = path.slice(0, path.length - "/SKILL.md".length);
      const name = frontmatter.name ?? dirName;
      return {
        name,
        title: frontmatter.title ?? humanizeSkillName(name),
        description: frontmatter.description ?? "",
        path,
        source,
      };
    });
}

/** `.agents/skills/<name>/SKILL.md` files → skills, sorted by name. */
function skillsFromFiles(files: Record<string, string>): ProjectSkill[] {
  return Object.entries(files)
    .filter(
      ([file]) =>
        file.startsWith(`${SKILLS_DIR}/`) && file.endsWith("/SKILL.md"),
    )
    .map(([file, source]) => {
      const frontmatter = parseSkillFrontmatter(source);
      const dirName = file.slice(
        SKILLS_DIR.length + 1,
        file.length - "/SKILL.md".length,
      );
      const name = frontmatter.name ?? dirName;
      return {
        name,
        title: frontmatter.title ?? humanizeSkillName(name),
        description: frontmatter.description ?? "",
        path: file,
        source: "project" as const,
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Minimal YAML frontmatter reader for SKILL.md files — only flat
 * `key: value` string pairs are recognized, which is all the Agent Skills
 * spec requires for `name` and `description`. Exported so hosts materializing
 * skill sets (e.g. the desktop's host-skills plugin) parse identically.
 */
export function parseSkillFrontmatter(source: string): {
  name?: string;
  title?: string;
  description?: string;
} {
  const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!match?.[1]) return {};
  const result: { name?: string; title?: string; description?: string } = {};
  for (const line of match[1].split("\n")) {
    const colon = line.indexOf(":");
    if (colon === -1) continue;
    const key = line.slice(0, colon).trim();
    const value = line
      .slice(colon + 1)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key === "name") result.name = value;
    if (key === "title") result.title = value;
    if (key === "description") result.description = value;
  }
  return result;
}

/**
 * Fallback human-facing name for a skill with no `title` frontmatter:
 * "team-notes" → "Team notes". Sentence case, not title case — the slug
 * carries no capitalization knowledge ("github") worth faking.
 */
export function humanizeSkillName(name: string): string {
  const words = name.replace(/[-_]+/g, " ").trim();
  return words ? words[0]?.toUpperCase() + words.slice(1) : name;
}
