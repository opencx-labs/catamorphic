import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { ArtifactRef, Identity } from "../identity.js";
import { assertBuilder } from "./artifact-scope.js";
import { readProgramFiles, withProgram } from "./program-reader.js";
import { ProjectNotFoundError } from "./projects-service.js";

/**
 * Roles as committed files (ADR 0055): `roles/<name>.json`, next to
 * `agents/`. A role is a reviewable, agent-authorable statement of what a
 * class of member may reach — agents, workflows, apps, documents, and
 * whether they build the program — expressed in the one enforcement
 * vocabulary core has (`Identity.scope`). Membership (which user has which
 * roles, with which grants) is the host's, or the stock
 * `MembershipsService`; core stores no policy.
 *
 * `{param}` placeholders in document paths and app/workflow/agent names are
 * filled from per-user grants (`{ customer: ["acme", "globex"] }`), one
 * ref per value; an entry whose placeholders are not all granted yields
 * nothing — never a wildcard.
 */
export const ROLES_DIR = "roles";

const NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ToolPolicySchema = z.object({
  default: z.enum(["allow", "ask", "deny", "auto"]).optional(),
  tools: z.record(z.string(), z.enum(["allow", "ask", "deny"])).optional(),
});

const AgentEntrySchema = z.union([
  z.string().min(1),
  z.object({
    name: z.string().min(1),
    /** Per connector server key, or `catamorphic` for the project's tools. */
    toolPolicies: z.record(z.string().min(1), ToolPolicySchema).optional(),
  }),
]);

const DocumentEntrySchema = z.union([
  z.string().min(1),
  z.object({
    path: z.string().min(1),
    access: z.enum(["read", "write"]).optional(),
  }),
]);

/** The committed `roles/<name>.json` schema, version 1. */
export const RoleDefinitionSchema = z.object({
  version: z.literal(1),
  /** Display name. */
  name: z.string().min(1),
  description: z.string().optional(),
  /** Full program access to the project (a `project` ref). */
  builder: z.boolean().optional(),
  agents: z.array(AgentEntrySchema).optional(),
  workflows: z.array(z.string().min(1)).optional(),
  apps: z.array(z.string().min(1)).optional(),
  /** Files or `dir/**` subtrees; `access` defaults to read. */
  documents: z.array(DocumentEntrySchema).optional(),
});

export type RoleDefinition = z.infer<typeof RoleDefinitionSchema>;

export interface ProjectRoleEntry {
  /** File name without `.json`; what memberships refer to. */
  slug: string;
  definition?: RoleDefinition;
  /** Present instead of `definition` when the file could not be used. */
  invalid?: { error: string };
}

export function validateRoleDefinition(
  raw: unknown,
): { definition: RoleDefinition } | { error: string } {
  if (
    typeof raw === "object" &&
    raw !== null &&
    "version" in raw &&
    (raw as { version: unknown }).version !== 1
  ) {
    return {
      error: `Unsupported role definition version ${String(
        (raw as { version: unknown }).version,
      )} (this host supports version 1)`,
    };
  }
  const parsed = RoleDefinitionSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return {
      error: issue
        ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
        : "Invalid role definition",
    };
  }
  return { definition: parsed.data };
}

/** Per-user values for `{param}` placeholders. */
export type RoleGrants = Readonly<Record<string, readonly string[]>>;

const PLACEHOLDER = /\{([A-Za-z0-9_]+)\}/g;

/**
 * Every filling of a template's placeholders from the grants: the cartesian
 * product over the params it names. Empty when a param has no grant.
 */
export function fillTemplate(template: string, grants: RoleGrants): string[] {
  const params = [
    ...new Set([...template.matchAll(PLACEHOLDER)].map((m) => m[1] as string)),
  ];
  if (params.length === 0) return [template];
  let fillings: Array<Record<string, string>> = [{}];
  for (const param of params) {
    const values = grants[param];
    if (!values || values.length === 0) return [];
    fillings = fillings.flatMap((partial) =>
      values.map((value) => ({ ...partial, [param]: value })),
    );
  }
  return fillings.map((filling) =>
    template.replace(PLACEHOLDER, (_m, name: string) => filling[name] ?? ""),
  );
}

/** Expand one role definition into the refs it grants, for one user's grants. */
export function expandRole(
  definition: RoleDefinition,
  projectId: string,
  grants: RoleGrants,
): ArtifactRef[] {
  const refs: ArtifactRef[] = [];
  if (definition.builder) refs.push({ kind: "project", projectId });
  for (const entry of definition.agents ?? []) {
    const name = typeof entry === "string" ? entry : entry.name;
    const toolPolicies =
      typeof entry === "string" ? undefined : entry.toolPolicies;
    for (const filled of fillTemplate(name, grants)) {
      refs.push({
        kind: "agent",
        projectId,
        name: filled,
        ...(toolPolicies ? { toolPolicies } : {}),
      });
    }
  }
  for (const name of definition.workflows ?? []) {
    for (const filled of fillTemplate(name, grants)) {
      refs.push({ kind: "workflow", projectId, name: filled });
    }
  }
  for (const name of definition.apps ?? []) {
    for (const filled of fillTemplate(name, grants)) {
      refs.push({ kind: "app", projectId, name: filled });
    }
  }
  for (const entry of definition.documents ?? []) {
    const path = typeof entry === "string" ? entry : entry.path;
    const access = typeof entry === "string" ? undefined : entry.access;
    for (const filled of fillTemplate(path, grants)) {
      refs.push({
        kind: "document",
        projectId,
        path: filled,
        ...(access === "write" ? { access } : {}),
      });
    }
  }
  return dedupeRefs(refs);
}

function dedupeRefs(refs: ArtifactRef[]): ArtifactRef[] {
  const seen = new Set<string>();
  const out: ArtifactRef[] = [];
  for (const ref of refs) {
    const key = JSON.stringify(ref);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(ref);
  }
  return out;
}

/**
 * The recipe-sized resolver body (ADR 0055): a host that has verified who is
 * calling and knows their roles/grants (its own table, an SSO claim, the
 * stock memberships) turns them into an identity in one call.
 */
export function resolveRoles(
  core: { roles: RolesService },
  input: ResolveRolesInput,
): Promise<Identity> {
  return core.roles.resolve(input);
}

export interface ResolveRolesInput {
  tenantId: string;
  projectId: string;
  externalUserId: string;
  /** Role slugs (`roles/<slug>.json`). Unknown slugs grant nothing. */
  roles: readonly string[];
  grants?: RoleGrants;
}

/** How long a project's parsed role set is trusted before re-reading. */
const DEFAULT_TTL_MS = 10_000;

interface CachedRoles {
  loadedAt: number;
  entries: ProjectRoleEntry[];
}

/**
 * Read-only view over a project's committed `roles/` directory, and the
 * expansion of a member's roles into an {@link Identity}. Mirrors
 * {@link AgentDefinitionsService}: never throws on a bad file (each is an
 * invalid entry). Reads the program as shared (see `program-reader`):
 * role resolution runs inside the host's identity resolver, before the
 * caller is anyone, so it never touches a caller's working copy.
 */
export class RolesService {
  private readonly cache = new Map<string, CachedRoles>();
  private readonly ttlMs: number;

  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
    opts?: { ttlMs?: number },
  ) {
    this.ttlMs = opts?.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** The project's roles, for its builders (the admin surface). */
  async list(
    identity: Identity,
    projectId: string,
  ): Promise<ProjectRoleEntry[]> {
    assertBuilder(identity, projectId);
    await this.requireProject(identity.tenantId, projectId);
    return this.load(identity.tenantId, projectId, { fresh: true });
  }

  /** Drop the cached role set (a checkpoint, a push, a deploy landed). */
  invalidate(projectId: string): void {
    for (const key of this.cache.keys()) {
      if (key.endsWith(`:${projectId}`)) this.cache.delete(key);
    }
  }

  /**
   * A member's identity: the union of their roles' expansions. Unknown
   * roles and invalid role files contribute nothing, so a typo can only
   * ever narrow. No roles → an empty scope (a valid identity that may do
   * nothing), never null: whether an unknown member is 401 or 403 is the
   * host's call, made before this.
   */
  async resolve(input: ResolveRolesInput): Promise<Identity> {
    await this.requireProject(input.tenantId, input.projectId);
    const entries = await this.load(input.tenantId, input.projectId);
    const grants = input.grants ?? {};
    const scope: ArtifactRef[] = [];
    for (const slug of input.roles) {
      const entry = entries.find((e) => e.slug === slug);
      if (!entry?.definition) continue;
      scope.push(...expandRole(entry.definition, input.projectId, grants));
    }
    return {
      tenantId: input.tenantId,
      externalUserId: input.externalUserId,
      scope: dedupeRefs(scope),
    };
  }

  private async load(
    tenantId: string,
    projectId: string,
    opts?: { fresh?: boolean },
  ): Promise<ProjectRoleEntry[]> {
    const key = `${tenantId}:${projectId}`;
    const cached = this.cache.get(key);
    if (!opts?.fresh && cached && Date.now() - cached.loadedAt < this.ttlMs) {
      return cached.entries;
    }
    const files = await this.readRoleFiles(tenantId, projectId);
    const entries = Object.entries(files)
      .map(([file, content]): ProjectRoleEntry => {
        const slug = file.slice(`${ROLES_DIR}/`.length, -".json".length);
        if (!NAME_PATTERN.test(slug)) {
          return {
            slug,
            invalid: {
              error: `Invalid role file name "${slug}.json" (use letters, digits, ".", "_", "-")`,
            },
          };
        }
        let raw: unknown;
        try {
          raw = JSON.parse(content);
        } catch (cause) {
          return {
            slug,
            invalid: {
              error: `Not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`,
            },
          };
        }
        const result = validateRoleDefinition(raw);
        return "error" in result
          ? { slug, invalid: { error: result.error } }
          : { slug, definition: result.definition };
      })
      .sort((a, b) => a.slug.localeCompare(b.slug));
    this.cache.set(key, { loadedAt: Date.now(), entries });
    return entries;
  }

  /** `roles/*.json` (top level only) → content, from the program as shared. */
  private async readRoleFiles(
    tenantId: string,
    projectId: string,
  ): Promise<Record<string, string>> {
    const prefix = `${ROLES_DIR}/`;
    const files = await withProgram(
      this.projectManager,
      tenantId,
      projectId,
      (repo, ref) => readProgramFiles(repo, ref, prefix),
    );
    return Object.fromEntries(
      Object.entries(files).filter(
        ([file]) =>
          file.endsWith(".json") && !file.slice(prefix.length).includes("/"),
      ),
    );
  }

  private async requireProject(
    tenantId: string,
    projectId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }
}
