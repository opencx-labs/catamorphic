import {
  CODE_PERMISSIONS,
  type CodeAccess,
  privateWorkflowAddress,
} from "@catamorphic/work-customization";

export {
  CODE_PERMISSIONS,
  type CodeAccess,
} from "@catamorphic/work-customization";

const PERMISSION_WORDS: Readonly<Record<string, string>> = {
  state: "Read and change this package's private state",
  notifications: "Send you notifications",
  processes: "Start and control confined processes for this package",
  background: "Keep this package's services running after Work quits",
};
const KEYS = [
  "lists",
  "workflows",
  "hosts",
  "reads",
  "writes",
  "permissions",
] as const;
type AccessKey = (typeof KEYS)[number];

const LIST = /^[a-z][a-z0-9-]{0,39}$/;
const WORKFLOW = /^[a-zA-Z_$][a-zA-Z0-9_$-]{0,99}$/;
const DOMAIN =
  /^(?:\*\.)?(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const IPV4 =
  /^(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}$/;
const MAX_ENTRIES = 64;

/** `host[:port]` as written, its host lowercased, or null if it is not one. */
export function parseHost(
  entry: string,
): { host: string; port?: number } | null {
  const match = /^([^:]+)(?::(\d{1,5}))?$/.exec(entry.trim().toLowerCase());
  if (!match?.[1]) return null;
  const host = match[1];
  const port = match[2] === undefined ? undefined : Number(match[2]);
  if (port !== undefined && (port < 1 || port > 65_535)) return null;
  if (host !== "localhost" && !IPV4.test(host) && !DOMAIN.test(host))
    return null;
  return port === undefined ? { host } : { host, port };
}

function validEntry(key: AccessKey, entry: string): boolean {
  if (key === "permissions")
    return CODE_PERMISSIONS.some((permission) => permission === entry);
  if (key === "lists") return LIST.test(entry);
  if (key === "workflows") {
    if (WORKFLOW.test(entry)) return true;
    try {
      return privateWorkflowAddress(entry) !== null;
    } catch {
      return false;
    }
  }
  if (key === "hosts") return parseHost(entry) !== null;
  if (entry.length === 0 || entry.length > 1024 || entry.includes("\0"))
    return false;
  if (entry.split(/[\\/]/).includes("..")) return false;
  // Outside the project: where it starts must be said.
  if (key === "reads") return entry.startsWith("/") || entry.startsWith("~/");
  return true;
}

const ENTRY_HELP: Record<AccessKey, string> = {
  permissions: "permissions are state, notifications, processes or background",
  lists: "lists name Work's lists (chats, tabs, files, chips)",
  workflows:
    "workflows name the project's workflows or private:<artifactId>:<revision>",
  hosts:
    "hosts are names like api.example.com, *.example.com or localhost:3000",
  reads:
    "reads name files outside the project, from / or ~/ (the project is always readable)",
  writes: "writes name files and folders, in the project unless from / or ~/",
};

/** A declaration read and checked; throws what to fix. */
export function parseCodeAccess(raw: unknown, where: string): CodeAccess {
  if (raw === undefined) return {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw))
    throw new Error(`${where}: catamorphic.access must be an object.`);
  const unknown = Object.keys(raw).filter(
    (key) => !KEYS.some((known) => known === key),
  );
  if (unknown.length)
    throw new Error(
      `${where}: catamorphic.access has unknown keys ${unknown.join(", ")}; it takes ${KEYS.join(", ")}.`,
    );
  const access: CodeAccess = {};
  for (const key of KEYS) {
    const value: unknown = Reflect.get(raw, key);
    if (value === undefined) continue;
    if (
      !Array.isArray(value) ||
      value.length > MAX_ENTRIES ||
      value.some(
        (entry) => typeof entry !== "string" || !validEntry(key, entry),
      )
    )
      throw new Error(`${where}: ${ENTRY_HELP[key]}.`);
    const entries = [
      ...new Set(
        value
          .filter((entry): entry is string => typeof entry === "string")
          .map((entry) =>
            key === "hosts" ? entry.trim().toLowerCase() : entry,
          ),
      ),
    ].sort();
    if (entries.length) access[key] = entries;
  }
  return access;
}

export function isEmptyAccess(access: CodeAccess): boolean {
  return KEYS.every((key) => !access[key]?.length);
}

/** A stable text of the declaration, for comparing and signing. */
export function accessText(access: CodeAccess): string {
  return JSON.stringify(
    KEYS.flatMap((key) =>
      access[key]?.length ? [[key, [...(access[key] ?? [])].sort()]] : [],
    ),
  );
}

function hostCovers(approved: string, wanted: string): boolean {
  if (approved === wanted) return true;
  const outer = parseHost(approved);
  const inner = parseHost(wanted);
  if (!outer || !inner || outer.port !== inner.port) return false;
  if (!outer.host.startsWith("*.")) return false;
  const suffix = outer.host.slice(1);
  return inner.host.endsWith(suffix) && inner.host.length > suffix.length;
}

function pathCovers(approved: string, wanted: string): boolean {
  if (
    approved.split(/[\\/]/).includes("..") ||
    wanted.split(/[\\/]/).includes("..")
  )
    return false;
  if (approved === wanted) return true;
  const folder = approved.endsWith("/") ? approved : `${approved}/`;
  return wanted.startsWith(folder);
}

function covers(key: AccessKey, approved: string, wanted: string): boolean {
  if (key === "hosts") return hostCovers(approved, wanted);
  if (key === "reads" || key === "writes") return pathCovers(approved, wanted);
  return approved === wanted;
}

/** What `wanted` reaches that `approved` does not: what the person is asked. */
export function accessBeyond(
  approved: CodeAccess | null,
  wanted: CodeAccess,
): CodeAccess {
  const beyond: CodeAccess = {};
  for (const key of KEYS) {
    const extra = (wanted[key] ?? []).filter(
      (entry) =>
        !(approved?.[key] ?? []).some((known) => covers(key, known, entry)),
    );
    if (extra.length) beyond[key] = extra;
  }
  return beyond;
}

/** Whether an address of `host` on `port` is one the declaration reaches. */
export function hostAllowed(
  hosts: readonly string[] | undefined,
  host: string,
  port: number,
): boolean {
  const name = host.toLowerCase().replace(/^\[|\]$/g, "");
  return (hosts ?? []).some((entry) => {
    const allowed = parseHost(entry);
    if (!allowed) return false;
    const portMatches =
      allowed.port === undefined
        ? port === 443 || port === 80
        : allowed.port === port;
    if (!portMatches) return false;
    if (allowed.host.startsWith("*.")) {
      const suffix = allowed.host.slice(1);
      return name.endsWith(suffix) && name.length > suffix.length;
    }
    return name === allowed.host;
  });
}

const LIST_WORDS: Readonly<Record<string, string>> = {
  activity: "the project's activity",
  apps: "the project's apps",
  bookmarks: "your bookmarks",
  chats: "your chats",
  chips: "this chat's chips",
  files: "the project's files",
  git: "the project's changes",
  library: "your library",
  pinned: "your pinned pages",
  prs: "pull requests",
  remote: "the project's server",
  resources: "what Work runs",
  session: "the chat in front",
  subsessions: "the chat's subagents",
  tabs: "your open tabs",
  workflows: "the project's workflows",
};

/**
 * Where something written in a project runs later as the person or as the
 * project's code: Git hooks, harness settings and hooks, MCP servers, Work's
 * own capability workspace. Changing them is more than changing a file.
 */
const RUNS_LATER = [
  ".git",
  ".claude",
  ".codex",
  ".mcp.json",
  ".vscode",
  ".work",
];

function writeWords(path: string): string {
  const clean = path.replace(/^\.\/+/, "").replace(/\/+$/, "");
  if (clean === "" || clean === ".")
    return "Change any file in this project (including hooks and settings that run commands as you)";
  const first = clean.split("/")[0] ?? clean;
  return RUNS_LATER.includes(first)
    ? `Change ${path} (what is there can run commands as you)`
    : `Change ${path}`;
}

/**
 * The declaration in Work's words, one line per thing it reaches, for the
 * request the person answers. Work writes these, never the code asking.
 */
export function describeAccess(access: CodeAccess): string[] {
  return [
    ...(access.permissions ?? []).map(
      (permission) => PERMISSION_WORDS[permission] ?? `Use ${permission}`,
    ),
    ...(access.lists ?? []).map(
      (list) => `Read and act on ${LIST_WORDS[list] ?? `Work's ${list} list`}`,
    ),
    ...(access.workflows ?? []).map(
      (workflow) => `Run the ${workflow} workflow`,
    ),
    ...(access.hosts ?? []).map((host) =>
      host.startsWith("*.")
        ? `Reach any address under ${host.slice(2)}`
        : `Reach ${host}`,
    ),
    ...(access.reads ?? []).map((path) => `Read ${path}`),
    ...(access.writes ?? []).map(writeWords),
  ];
}

/**
 * What a module asks the person before it runs (ADR 0277), in Work's words:
 * what is new since they last allowed it, and the whole of it.
 */
export interface ModuleAccessRequest {
  /** The module, relative to the project. */
  module: string;
  /** What is new: what the person is asked now. */
  beyond: string[];
  /** All it will reach once allowed. */
  all: string[];
  /** Whether it reaches the network, so project files could leave with it. */
  network: boolean;
  /** The declaration asked about; allowing names it, so a changed one asks again. */
  fingerprint: string;
}
