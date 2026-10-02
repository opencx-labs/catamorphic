import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { ensurePersonalFilesExcluded } from "@catamorphic/git";
import { PROJECT_PERSONAL_DIR } from "@catamorphic/workflow/project-layout";

/**
 * `.work/personal/environment.json` (ADR 0184): which project files reach
 * the member's sessions on the linked Work server. Sign-ins never do (ADR
 * 0198). Inside the git-excluded personal folder, so it never ships.
 */
export const PERSONAL_ENVIRONMENT_PATH = `${PROJECT_PERSONAL_DIR}/environment.json`;
/** Status for agents and people: no secrets, rewritten only on change. */
export const PERSONAL_ENVIRONMENT_STATUS_PATH = `${PROJECT_PERSONAL_DIR}/environment-status.json`;
export const PERSONAL_FILE_MAX_BYTES = 256 * 1024;
export const PERSONAL_FILES_MAX = 50;

export interface PersonalEnvironmentConfig {
  files: string[];
}

export type ParsedPersonalEnvironment =
  | { ok: true; config: PersonalEnvironmentConfig }
  | { ok: false; error: string };

export const DEFAULT_PERSONAL_ENVIRONMENT: PersonalEnvironmentConfig = {
  files: [],
};

/** Why a listed path is refused, or null when it is a valid project path. */
export function personalFilePathProblem(value: string): string | null {
  if (value.length === 0) return "A file path is empty";
  if (value.length > 512) return `${value.slice(0, 40)}… is too long`;
  if (value.includes("\\"))
    return `${value} uses backslashes; write paths with forward slashes`;
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value))
    return `${value} is absolute; write it relative to the project folder`;
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "."))
    return `${value} is not a plain project path`;
  if (segments.includes(".."))
    return `${value} points outside the project folder`;
  if (segments.includes(".git")) return `${value} is inside Git's own folder`;
  return null;
}

/** Parses and validates the config text. Unknown keys are errors. */
export function parsePersonalEnvironmentConfig(
  text: string,
): ParsedPersonalEnvironment {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch (cause) {
    return {
      ok: false,
      error: `${PERSONAL_ENVIRONMENT_PATH} is not valid JSON: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    };
  }
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return {
      ok: false,
      error: `${PERSONAL_ENVIRONMENT_PATH} must be a JSON object`,
    };
  if ("logins" in value)
    return {
      ok: false,
      error: `Remove "logins": sign-ins stay on the machine they were made on and are never sent to the server`,
    };
  const unknown = Object.keys(value).filter((key) => key !== "files");
  if (unknown.length > 0)
    return {
      ok: false,
      error: `Unknown ${unknown.length === 1 ? "key" : "keys"} ${unknown
        .map((key) => `"${key}"`)
        .join(", ")}; use "files"`,
    };
  const files: string[] = [];
  if ("files" in value) {
    const raw = value.files;
    if (!Array.isArray(raw))
      return {
        ok: false,
        error: `"files" must be a list of project paths, like [".env"]`,
      };
    for (const entry of raw) {
      if (typeof entry !== "string")
        return { ok: false, error: `"files" entries must be text paths` };
      const problem = personalFilePathProblem(entry);
      if (problem) return { ok: false, error: problem };
      if (!files.includes(entry)) files.push(entry);
    }
    if (files.length > PERSONAL_FILES_MAX)
      return {
        ok: false,
        error: `List at most ${PERSONAL_FILES_MAX} files`,
      };
  }
  return { ok: true, config: { files } };
}

export function serializePersonalEnvironmentConfig(
  config: PersonalEnvironmentConfig,
): string {
  return `${JSON.stringify({ files: config.files }, null, 2)}\n`;
}

export interface PersonalEnvironmentFile {
  exists: boolean;
  parsed: ParsedPersonalEnvironment;
  /** Content hash of the raw file, for change detection. */
  fingerprint: string;
}

export async function readPersonalEnvironmentConfig(args: {
  root: string;
}): Promise<PersonalEnvironmentFile> {
  const text = await fs
    .readFile(path.join(args.root, PERSONAL_ENVIRONMENT_PATH), "utf8")
    .catch((cause: unknown) => {
      if (isMissing(cause)) return null;
      throw cause;
    });
  if (text === null)
    return {
      exists: false,
      parsed: { ok: true, config: DEFAULT_PERSONAL_ENVIRONMENT },
      fingerprint: "absent",
    };
  return {
    exists: true,
    parsed: parsePersonalEnvironmentConfig(text),
    fingerprint: sha256(text),
  };
}

/** Atomic write into the git-excluded personal folder. */
export async function writePersonalEnvironmentConfig(args: {
  root: string;
  config: PersonalEnvironmentConfig;
}): Promise<void> {
  await ensurePersonalFilesExcluded({ repoPath: args.root });
  const target = path.join(args.root, PERSONAL_ENVIRONMENT_PATH);
  await fs.mkdir(path.dirname(target), { recursive: true });
  const temporary = `${target}.${randomUUID()}.tmp`;
  await fs.writeFile(
    temporary,
    serializePersonalEnvironmentConfig(args.config),
    { mode: 0o600 },
  );
  await fs.rename(temporary, target);
}

/**
 * Read, change and write the config. A broken file is never overwritten:
 * the person (or their agent) fixes it by hand first.
 */
export async function updatePersonalEnvironmentConfig(args: {
  root: string;
  update: (config: PersonalEnvironmentConfig) => PersonalEnvironmentConfig;
}): Promise<PersonalEnvironmentConfig> {
  const current = await readPersonalEnvironmentConfig({ root: args.root });
  if (!current.parsed.ok)
    throw new Error(
      `Fix ${PERSONAL_ENVIRONMENT_PATH} first. ${current.parsed.error}`,
    );
  const next = args.update(current.parsed.config);
  const parsed = parsePersonalEnvironmentConfig(
    serializePersonalEnvironmentConfig(next),
  );
  if (!parsed.ok) throw new Error(parsed.error);
  await writePersonalEnvironmentConfig({
    root: args.root,
    config: parsed.config,
  });
  return parsed.config;
}

/** Creates the file with its defaults so it can be opened and edited. */
export async function ensurePersonalEnvironmentConfig(args: {
  root: string;
}): Promise<void> {
  const current = await readPersonalEnvironmentConfig({ root: args.root });
  if (current.exists) return;
  await writePersonalEnvironmentConfig({
    root: args.root,
    config: DEFAULT_PERSONAL_ENVIRONMENT,
  });
}

/** A picked absolute path as a project path, refusing anything outside. */
export async function projectRelativePath(args: {
  root: string;
  absolute: string;
}): Promise<string> {
  const root = await fs.realpath(args.root);
  const real = await fs.realpath(args.absolute);
  const relative = path.relative(root, real);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative))
    throw new Error("Choose a file inside this project's folder");
  const normalized = relative.split(path.sep).join("/");
  const problem = personalFilePathProblem(normalized);
  if (problem) throw new Error(problem);
  if (!(await fs.stat(real)).isFile())
    throw new Error(`${normalized} is not a file`);
  return normalized;
}

export interface ListedFile {
  path: string;
  content: Buffer | null;
  bytes: number | null;
  problem: string | null;
  /** Content hash, when readable. */
  fingerprint: string | null;
}

/** Current contents of the listed files, each checked on its own. */
export async function readListedFiles(args: {
  root: string;
  files: readonly string[];
}): Promise<ListedFile[]> {
  const root = await fs.realpath(args.root);
  return Promise.all(
    args.files.map(async (relative): Promise<ListedFile> => {
      const failed = (problem: string, bytes: number | null = null) => ({
        path: relative,
        content: null,
        bytes,
        problem,
        fingerprint: null,
      });
      const problem = personalFilePathProblem(relative);
      if (problem) return failed(problem);
      let real: string;
      try {
        real = await fs.realpath(path.join(root, relative));
      } catch (cause) {
        if (isMissing(cause)) return failed("Not found in the project folder");
        throw cause;
      }
      const inside = path.relative(root, real);
      if (inside.startsWith("..") || path.isAbsolute(inside))
        return failed("Links outside the project folder");
      const stat = await fs.stat(real);
      if (!stat.isFile()) return failed("Not a file");
      if (stat.size > PERSONAL_FILE_MAX_BYTES)
        return failed("Larger than 256 KB", stat.size);
      const content = await fs.readFile(real);
      if (content.length > PERSONAL_FILE_MAX_BYTES)
        return failed("Larger than 256 KB", content.length);
      return {
        path: relative,
        content,
        bytes: content.length,
        problem: null,
        fingerprint: sha256(content),
      };
    }),
  );
}

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isMissing(cause: unknown): boolean {
  return (
    cause instanceof Error &&
    "code" in cause &&
    (cause.code === "ENOENT" || cause.code === "ENOTDIR")
  );
}
