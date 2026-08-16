import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { AppRef, Identity } from "../identity.js";
import type { AppPoliciesService } from "./app-policies-service.js";

/**
 * Thrown whenever a scoped identity reaches something outside its scope.
 * Deliberately one error for every denial (wrong project, unpublished app,
 * workflow outside the frozen set, project-surface operation): the caller is
 * an untrusted viewer — often a browser bundle — and detailed denials would
 * enumerate the project for it.
 */
export class AccessDeniedError extends Error {
  constructor() {
    super("Not authorized to perform that operation");
    this.name = "AccessDeniedError";
  }
}

/**
 * Rejects scoped identities outright. Every project-surface operation
 * (files, deploys, secrets, agent sessions, app builds, run controls) calls
 * this: a viewer reaches catamorphic only through an artifact, and an
 * artifact only through its own surface.
 */
export function assertFullIdentity(identity: Identity): void {
  if (identity.scope !== undefined) throw new AccessDeniedError();
}

export interface ResolvedScope {
  /**
   * Workflow names in this project the scope may trigger and read: the
   * union of every covered app's frozen set (at its resolved version) and
   * every directly covered workflow. Empty means the scope allows nothing
   * here.
   */
  allowedWorkflows: ReadonlySet<string>;
}

/**
 * Resolves what a scoped identity may call in a project. Returns null for
 * full identities.
 *
 * App refs resolve to the app's *currently active published* version and its
 * frozen workflow set — a retired version cannot be named by a ref, so its
 * (possibly wider) old set can never be reached. The one exception is a
 * `dev` ref, which resolves to the latest ready build made by this same
 * user (the builder opening the build they are working on) and to nothing
 * for anyone else; that never widens access either, since a `dev` ref only
 * arises by narrowing the builder's own full identity.
 *
 * Tenant policy applies to app refs: the `apps_enabled` kill switch denies
 * them outright and `workflow_allowlist` intersects with (only ever narrows)
 * each frozen set.
 */
export async function resolveScope(args: {
  db: Kysely<DB>;
  identity: Identity;
  projectId: string;
  policies?: AppPoliciesService;
}): Promise<ResolvedScope | null> {
  const scope = args.identity.scope;
  if (scope === undefined) return null;

  const allowed = new Set<string>();
  const apps = scope.filter(
    (ref): ref is AppRef =>
      ref.kind === "app" && ref.projectId === args.projectId,
  );
  for (const ref of scope) {
    if (ref.kind === "workflow" && ref.projectId === args.projectId) {
      allowed.add(ref.name);
    }
  }
  if (apps.length === 0) return { allowedWorkflows: allowed };

  const policy = await args.policies?.get(args.identity.tenantId);
  if (policy && !policy.appsEnabled) throw new AccessDeniedError();
  const allowlist = policy?.workflowAllowlist;

  for (const ref of apps) {
    let query = args.db
      .selectFrom("app_versions")
      .innerJoin("apps", "apps.id", "app_versions.app_id")
      .innerJoin("projects", "projects.id", "apps.project_id")
      .where("apps.project_id", "=", args.projectId)
      .where("apps.name", "=", ref.name)
      .where("projects.tenant_id", "=", args.identity.tenantId)
      .where("app_versions.status", "=", "ready")
      .select(["app_versions.allowed_workflows"]);
    query =
      ref.channel === "dev"
        ? query
            .where(
              "app_versions.built_by_external_user_id",
              "=",
              args.identity.externalUserId,
            )
            .orderBy("app_versions.created_at", "desc")
            .limit(1)
        : query.where("app_versions.is_active", "=", true);
    const row = await query.executeTakeFirst();
    if (!row) continue;
    for (const name of parseWorkflowList(row.allowed_workflows)) {
      if (!allowlist || allowlist.includes(name)) allowed.add(name);
    }
  }
  return { allowedWorkflows: allowed };
}

/**
 * Gate for invoking or reading runs of one workflow. No-op for full
 * identities; scoped identities pass only when the workflow is in their
 * resolved set for this project.
 */
export async function assertScopeAllowsWorkflow(args: {
  db: Kysely<DB>;
  identity: Identity;
  projectId: string;
  workflowName: string;
  policies?: AppPoliciesService;
}): Promise<void> {
  const resolved = await resolveScope(args);
  if (!resolved) return;
  if (!resolved.allowedWorkflows.has(args.workflowName)) {
    throw new AccessDeniedError();
  }
}

function parseWorkflowList(value: unknown): string[] {
  // A corrupt row must read as an empty frozen set (deny everything), not a
  // 500 that leaks parse errors to an untrusted caller.
  let parsed: unknown;
  try {
    parsed = typeof value === "string" ? JSON.parse(value) : value;
  } catch {
    return [];
  }
  return Array.isArray(parsed)
    ? parsed.filter((entry): entry is string => typeof entry === "string")
    : [];
}
