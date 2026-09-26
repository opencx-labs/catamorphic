/**
 * The layout of a user project (ADR 0142): the project-owned workspace folder
 * and every path, Git ref, branch, commit author, and execution name derived
 * from it. Code that constructs one of these names imports it from here;
 * prose (skills, prompts, docs, tests) may spell the literal out.
 *
 * Paths are project-relative and slash-separated (Git paths), never OS paths.
 * Join them onto a folder with `path.join(root, PROJECT_SKILLS_DIR)`.
 *
 * Dependency-free, so any package, the desktop renderer, and the PWA can
 * import it through `@catamorphic/workflow/project-layout`.
 */

/** The project-owned workspace folder at a project's root. */
export const PROJECT_WORKSPACE_ROOT = ".work";

/** `.work/<segments...>`, slash-joined. */
export function projectPath(...segments: string[]): string {
  return [PROJECT_WORKSPACE_ROOT, ...segments].join("/");
}

/**
 * Whether a project-relative path is `directory` itself or lies inside it.
 * Leading slashes are ignored, so `/.work/apps/x` matches `.work/apps`.
 */
export function isProjectPathWithin(
  filePath: string,
  directory: string,
): boolean {
  const normalized = filePath.replace(/^\/+/, "");
  return normalized === directory || normalized.startsWith(`${directory}/`);
}

/** Committed project manifest: name, environments, team policy. */
export const PROJECT_MANIFEST_PATH = projectPath("project.json");
/** Root of the capability Bun workspace. */
export const PROJECT_PACKAGE_PATH = projectPath("package.json");
export const PROJECT_TSCONFIG_PATH = projectPath("tsconfig.json");
/** Scoped ignore file; seeded once and never overwritten. */
export const PROJECT_GITIGNORE_PATH = projectPath(".gitignore");
/** Either lockfile freezes the capability workspace install. */
export const PROJECT_LOCKFILE_PATHS: readonly string[] = [
  projectPath("bun.lock"),
  projectPath("bun.lockb"),
];
export const PROJECT_NODE_MODULES_DIR = projectPath("node_modules");

/** Whether a project file set carries a capability workspace lockfile. */
export function hasProjectLockfile(files: Record<string, unknown>): boolean {
  return PROJECT_LOCKFILE_PATHS.some((file) => file in files);
}

/** Backend workflows package. */
export const PROJECT_WORKFLOWS_DIR = projectPath("workflows");
export const PROJECT_WORKFLOWS_PACKAGE_PATH = `${PROJECT_WORKFLOWS_DIR}/package.json`;
/** Types-only package shared by workflows and apps. */
export const PROJECT_CONTRACTS_DIR = projectPath("contracts");
/** One package per user-built app: `.work/apps/<name>`. */
export const PROJECT_APPS_DIR = projectPath("apps");

/** `name` when `filePath` is an app package manifest, `.work/apps/<name>/package.json`. */
export function appWorkspaceName(filePath: string): string | undefined {
  const prefix = `${PROJECT_APPS_DIR}/`;
  const suffix = "/package.json";
  if (!filePath.startsWith(prefix) || !filePath.endsWith(suffix))
    return undefined;
  const name = filePath.slice(prefix.length, -suffix.length);
  return name && !name.includes("/") ? name : undefined;
}

export const PROJECT_SCRIPTS_DIR = projectPath("scripts");
export const PROJECT_CHECK_SCRIPT_PATH = `${PROJECT_SCRIPTS_DIR}/check.ts`;

/** Project skills: `.work/skills/<name>/SKILL.md`. */
export const PROJECT_SKILLS_DIR = projectPath("skills");
/** Committed roles: `.work/roles/<slug>.json` (ADR 0055). */
export const PROJECT_ROLES_DIR = projectPath("roles");
/** Committed agent definitions: `.work/agents/<slug>.json` (ADR 0050). */
export const PROJECT_AGENTS_DIR = projectPath("agents");

/** Project-owned mutable data, ignored by the scoped `.gitignore`. */
export const PROJECT_APP_DATA_DIR = projectPath("app-data");
/** Local home of logical `store/...` document addresses. */
export const PROJECT_STORE_DIR = `${PROJECT_APP_DATA_DIR}/store`;
/** Local-only per-profile tree (ADR 0068), never part of a program. */
export const PROJECT_PERSONAL_DIR = projectPath("personal");

/**
 * A capability-workspace file that belongs to the program: under `.work/`
 * and outside mutable app data.
 */
export function isProjectSourcePath(filePath: string): boolean {
  return (
    isProjectPathWithin(filePath, PROJECT_WORKSPACE_ROOT) &&
    !isProjectPathWithin(filePath, PROJECT_APP_DATA_DIR)
  );
}

/** Shared project sidebar layer. */
export const PROJECT_SIDEBAR_PATH = projectPath("sidebar.js");
/** Shared project theme. */
export const PROJECT_THEME_PATH = projectPath("theme.json");
/** Shared project preferences. */
export const PROJECT_SETTINGS_PATH = projectPath("settings.json");

/** Tracking refs for the last-published program: `refs/work/published/<branch>`. */
export const PUBLISHED_REF_PREFIX = "refs/work/published";

/** The published tracking ref for `branch`. */
export function publishedRef(branch = "main"): string {
  return `${PUBLISHED_REF_PREFIX}/${branch}`;
}

/** Prefix of every branch the framework creates on the user's behalf. */
export const MANAGED_BRANCH_PREFIX = "work/";

/** Author of per-turn agent checkpoint commits. */
export const AGENT_COMMIT_AUTHOR: {
  readonly name: string;
  readonly email: string;
} = { name: "Work Agent", email: "agent@work.software" };

/** Author of commits the host makes itself (sync merges, configuration, artifacts). */
export const SYSTEM_COMMIT_AUTHOR: {
  readonly name: string;
  readonly email: string;
} = { name: "Work", email: "system@work.software" };

/** Environment variable naming the durable app-data folder for workflows. */
export const APP_DATA_ENV = "WORK_APP_DATA_DIR";
/** Where sandboxes mount that folder. */
export const APP_DATA_MOUNT = "/work-app-data";
