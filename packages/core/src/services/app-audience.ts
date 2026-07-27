import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import type { AppPoliciesService } from "./app-policies-service.js";

/**
 * Thrown whenever an app-audience identity reaches a surface it is not
 * entitled to. Deliberately one error for every denial (wrong project, wrong
 * version, inactive version, workflow outside the frozen set, project-surface
 * operation): the caller is an untrusted browser bundle, and detailed denials
 * would enumerate the project for it.
 */
export class AppAccessDeniedError extends Error {
  constructor() {
    super("This app is not authorized to perform that operation");
    this.name = "AppAccessDeniedError";
  }
}

export interface AppAudienceContext {
  appId: string;
  appVersionId: string;
  /** Workflow names frozen into the active version at build time. */
  allowedWorkflows: ReadonlySet<string>;
}

/**
 * Rejects app-audience identities outright. Every project-surface operation
 * (files, deploys, secrets, agent sessions, app builds) calls this: a viewer
 * reaches catamorphic only through an app, and an app only through the run
 * broker surface.
 */
export function assertProjectSurface(identity: Identity): void {
  if (identity.appAudience) throw new AppAccessDeniedError();
}

/**
 * Resolves what an audience identity may call. Returns null for full
 * identities. For audience identities the referenced version must exist,
 * belong to the claimed app, belong to this project, and be the currently
 * active published version — a stale or forged version id resolves to a
 * denial, never to a wider set.
 */
export async function resolveAppAudience(args: {
  db: Kysely<DB>;
  identity: Identity;
  projectId: string;
  policies?: AppPoliciesService;
}): Promise<AppAudienceContext | null> {
  const audience = args.identity.appAudience;
  if (!audience) return null;

  const policy = await args.policies?.get(args.identity.tenantId);
  if (policy && !policy.appsEnabled) throw new AppAccessDeniedError();

  const row = await args.db
    .selectFrom("app_versions")
    .innerJoin("apps", "apps.id", "app_versions.app_id")
    .innerJoin("projects", "projects.id", "apps.project_id")
    .where("app_versions.id", "=", audience.appVersionId)
    .where("app_versions.app_id", "=", audience.appId)
    .where("apps.project_id", "=", args.projectId)
    .where("projects.tenant_id", "=", args.identity.tenantId)
    .where("app_versions.is_active", "=", true)
    .where("app_versions.status", "=", "ready")
    .select(["app_versions.id", "app_versions.allowed_workflows"])
    .executeTakeFirst();
  if (!row) throw new AppAccessDeniedError();

  const frozen = parseWorkflowList(row.allowed_workflows);
  // The host allowlist can only narrow the frozen set, never widen it.
  const allowlist = policy?.workflowAllowlist;
  const effective = allowlist
    ? frozen.filter((name) => allowlist.includes(name))
    : frozen;
  return {
    appId: audience.appId,
    appVersionId: audience.appVersionId,
    allowedWorkflows: new Set(effective),
  };
}

/**
 * Gate for invoking or reading runs of one workflow. No-op for full
 * identities; audience identities pass only when the workflow is in their
 * version's frozen set.
 */
export async function assertWorkflowAllowed(args: {
  db: Kysely<DB>;
  identity: Identity;
  projectId: string;
  workflowName: string;
  policies?: AppPoliciesService;
}): Promise<void> {
  const context = await resolveAppAudience(args);
  if (!context) return;
  if (!context.allowedWorkflows.has(args.workflowName)) {
    throw new AppAccessDeniedError();
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
