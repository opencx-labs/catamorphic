/**
 * Catamorphic is host-agnostic. The host (e.g. a SaaS app) owns the real user/org
 * model; catamorphic only cares about two opaque string identifiers:
 *
 * - `tenantId` — the host's org / workspace id. Becomes the UUID stored in
 *   `catamorphic.tenants.id` + referenced by `catamorphic.projects.tenant_id`.
 *   Auto-upserted on first use.
 * - `externalUserId`: the host's stable user id. Persisted where Catamorphic
 *   needs durable ownership, membership, or audit attribution, but never joined
 *   to or constrained by a host user table.
 *
 * Services defined in this package accept {@link Identity} explicitly. They
 * intentionally do NOT fall back to any default — catamorphic is embed-only,
 * so the host is always responsible for supplying identity.
 */
export interface Identity {
  tenantId: string;
  externalUserId: string;
  /**
   * The artifacts this identity may touch. Absent = the ROOT identity: every
   * project of the tenant, every surface, the whole store — the desktop's
   * own local projects and a host's service identity (ADR 0055). Present =
   * a scoped identity that may reach exactly the listed artifacts and
   * nothing else: a `project` ref makes it a BUILDER of that project (files,
   * deploys, secrets, agent definitions, every workflow/app/agent); an
   * `app`, `workflow` or `agent` ref makes it a VIEWER of that artifact; a
   * `document` ref grants a file or subtree — and the project store is
   * reachable ONLY through document refs, builders included.
   *
   * Scope is the *output* of host policy, never its input: the host decides
   * which of its users are builders and which artifacts each viewer is
   * entitled to (a role file expanded by `resolveRoles`, an entitlement
   * table — the host's business), and catamorphic only enforces the result.
   * An empty scope is a valid identity that may do nothing.
   */
  scope?: readonly ArtifactRef[];
  /**
   * Logical project Environments this identity may allocate work into.
   * Absent together with artifact scope means the host root identity. A
   * scoped identity requires an exact ref; project builder scope does not
   * imply managed compute access.
   */
  executionScope?: readonly ExecutionEnvironmentRef[];
  /** Environment-local connection aliases this caller may use. */
  connectionScope?: readonly ConnectionUseRef[];
  /** Host-issued administrative permissions, never sourced from project code. */
  controlPlanePermissions?: readonly ControlPlanePermission[];
  /**
   * Project capabilities granted by committed project roles. Catamorphic
   * services reserve and enforce their documented names; embedders may use
   * additional namespaced capabilities in their own services and UI.
   */
  projectPermissions?: readonly ProjectPermissionRef[];
}

/**
 * A namespaced project capability, for example `memberships:manage` or an
 * embedder-owned `acme:approve_deals`. The open string surface is deliberate:
 * roles are project-owned and embedders may add enforcement outside core.
 */
export type ProjectPermission = string;

/** Shared syntax for project capabilities at every public boundary. */
export const PROJECT_PERMISSION_PATTERN =
  /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;

export const CORE_PROJECT_PERMISSIONS = [
  "memberships:manage",
  "roles:manage",
] as const satisfies readonly ProjectPermission[];

export interface ProjectPermissionRef {
  projectId: string;
  permission: ProjectPermission;
}

export interface ExecutionEnvironmentRef {
  projectId: string;
  name: string;
}

export interface ConnectionUseRef {
  projectId: string;
  environment: string;
  alias: string;
  capabilities?: readonly string[];
}

export type ControlPlanePermission =
  | "connections:manage_service"
  | "connections:view_audit";

export function identityMayUseConnection(
  identity: Identity,
  projectId: string,
  environment: string,
  alias: string,
): ConnectionUseRef | undefined {
  if (
    identity.scope === undefined &&
    identity.executionScope === undefined &&
    identity.connectionScope === undefined
  ) {
    return { projectId, environment, alias };
  }
  return identity.connectionScope?.find(
    (ref) =>
      ref.projectId === projectId &&
      ref.environment === environment &&
      ref.alias === alias,
  );
}

export function hasControlPlanePermission(
  identity: Identity,
  permission: ControlPlanePermission,
): boolean {
  return (
    (identity.scope === undefined && identity.executionScope === undefined) ||
    identity.controlPlanePermissions?.includes(permission) === true
  );
}

export function hasProjectPermission(
  identity: Identity,
  projectId: string,
  permission: ProjectPermission,
): boolean {
  if (identity.scope === undefined) return true;
  return (
    identity.projectPermissions?.some(
      (ref) => ref.projectId === projectId && ref.permission === permission,
    ) ?? false
  );
}

export function identityMayUseEnvironment(
  identity: Identity,
  projectId: string,
  name: string,
): boolean {
  if (identity.scope === undefined && identity.executionScope === undefined) {
    return true;
  }
  return (
    identity.executionScope?.some(
      (ref) => ref.projectId === projectId && ref.name === name,
    ) ?? false
  );
}

/**
 * A reference to one artifact a project publishes. Refs name artifacts by
 * `(projectId, name)` rather than by row id: that is what a host's
 * entitlement table naturally keys on, it is stable across republishes, and
 * it lets catamorphic resolve "the currently active published version" at
 * check time — a retired version can never be named, so it can never be
 * reached (ADR 0036, ADR 0053).
 */
export type ArtifactRef =
  | ProjectRef
  | AppRef
  | WorkflowRef
  | DocumentRef
  | AgentRef;

/**
 * Builder access to one project (ADR 0055): the whole program surface —
 * files, deploys, secrets, agent definitions, every workflow, app and
 * agent — but NOT the project store, which only document refs reach.
 */
export interface ProjectRef {
  kind: "project";
  projectId: string;
}

/**
 * A committed project agent (ADR 0050, `agents/<slug>.json`) a scoped
 * identity may open sessions on. `toolPolicies` is the caller's own
 * narrowing of that agent's tools (ADR 0055): per server key (a connector's
 * `serverKeyOf(name)`, or `catamorphic` for the project's workflow tools),
 * one more layer in the ADR 0054 intersection — it can only narrow.
 */
export interface AgentRef {
  kind: "agent";
  projectId: string;
  /** The agent's slug (`agents/<slug>.json`). */
  name: string;
  toolPolicies?: Readonly<Record<string, AgentRefToolPolicy>>;
}

/** Mirrors `@catamorphic/sandbox` `McpToolPolicy`; kept structural here so
 * identity stays dependency-free. */
export interface AgentRefToolPolicy {
  default?: "allow" | "ask" | "deny" | "auto";
  tools?: Readonly<Record<string, "allow" | "ask" | "deny">>;
}

export interface AppRef {
  kind: "app";
  projectId: string;
  /** The app's name (its `apps/<name>` workspace). */
  name: string;
  /**
   * Which build the ref resolves to — a resolution hint, not part of the
   * artifact's identity (two refs differing only in channel name the same
   * app). `published` (default) is the active published version — the only
   * thing a viewer ever sees. `dev` is the latest ready build *by this same
   * user* (the builder opening the build they are working on); for anyone
   * else a `dev` ref resolves to nothing, so a viewer asking for `dev` gets
   * nothing rather than something wider.
   */
  channel?: "published" | "dev";
}

export interface WorkflowRef {
  kind: "workflow";
  projectId: string;
  /** The exported workflow name at the production commit. */
  name: string;
}

/**
 * A file or subtree of the project's one path namespace (ADR 0055): a git
 * path (readable at the deployed commit) or a `store/…` path (the project
 * store). `path` ending in `/**` covers the subtree; anything else names one
 * file. `access` defaults to `read`; `write` implies read. Git paths are
 * always read-only through this ref, whatever `access` says.
 */
export interface DocumentRef {
  kind: "document";
  projectId: string;
  path: string;
  access?: "read" | "write";
}

/** True when the identity is scoped rather than root. */
export function isScoped(identity: Identity): boolean {
  return identity.scope !== undefined;
}

/**
 * True when the identity may edit the project's program: the root identity,
 * or a scoped one holding the project's `project` ref (ADR 0055).
 */
export function isBuilder(identity: Identity, projectId: string): boolean {
  return (
    identity.scope === undefined ||
    identity.scope.some(
      (ref) => ref.kind === "project" && ref.projectId === projectId,
    )
  );
}

/**
 * Whether an identity uses the project at all — a builder, or a scoped
 * identity holding any ref on it (an agent to chat with, a document to
 * read, a workflow or app to call). The gate for member-facing surfaces
 * that are not themselves an artifact: skills, proposals, `/me` summaries.
 */
export function mayUseProject(identity: Identity, projectId: string): boolean {
  if (isBuilder(identity, projectId)) return true;
  return (identity.scope ?? []).some((ref) => ref.projectId === projectId);
}

/** Structural equality on the fields that identify an artifact. */
export function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  if (a.kind !== b.kind || a.projectId !== b.projectId) return false;
  switch (a.kind) {
    case "project":
      return true;
    case "app":
      return a.name === (b as AppRef).name;
    case "workflow":
      return a.name === (b as WorkflowRef).name;
    case "agent":
      return a.name === (b as AgentRef).name;
    case "document":
      return a.path === (b as DocumentRef).path;
  }
}

/** Whether one document ref (an entry of a scope) grants another. */
export function documentRefCovers(
  entry: DocumentRef,
  ref: DocumentRef,
): boolean {
  if (entry.projectId !== ref.projectId) return false;
  if (ref.access === "write" && entry.access !== "write") return false;
  if (entry.path.endsWith("/**")) {
    const prefix = entry.path.slice(0, -2); // keep the trailing slash
    return ref.path === prefix.slice(0, -1) || ref.path.startsWith(prefix);
  }
  return entry.path === ref.path;
}

/**
 * Whether a scope (from a scoped identity) contains the given artifact.
 * Document refs cover by subtree and access; every other kind by identity.
 */
export function scopeCovers(
  scope: readonly ArtifactRef[],
  ref: ArtifactRef,
): boolean {
  if (ref.kind === "document") {
    return scope.some(
      (entry) => entry.kind === "document" && documentRefCovers(entry, ref),
    );
  }
  return scope.some((entry) => sameArtifact(entry, ref));
}

/**
 * Narrows an identity to a single artifact — the primitive every
 * artifact-scoped surface (an app's routes, an app's MCP endpoint) applies
 * structurally to whoever arrives:
 *
 * - a builder (root, or holding the project ref) becomes scoped to exactly
 *   that artifact (a builder using their own app is confined to it while
 *   inside it — the untrusted bundle never inherits project access, ADR
 *   0036);
 * - a scoped identity that covers the artifact is narrowed to it;
 * - a scoped identity that does not cover it gets an empty scope and can do
 *   nothing on that surface.
 *
 * Narrowing can only ever shrink access, so it is always safe to apply.
 */
export function narrowIdentity(identity: Identity, ref: ArtifactRef): Identity {
  return { ...identity, scope: identityCovers(identity, ref) ? [ref] : [] };
}

/**
 * Whether an identity may reach an artifact: builders of the project reach
 * every artifact in it; scoped identities exactly what their scope covers.
 */
export function identityCovers(identity: Identity, ref: ArtifactRef): boolean {
  return (
    isBuilder(identity, ref.projectId) ||
    (identity.scope !== undefined && scopeCovers(identity.scope, ref))
  );
}

export type TenantId = string;
export type ExternalUserId = string;

/**
 * Identity used for system-initiated writes (project initial commit, test-run
 * commits). Never reflects a real human actor.
 */
export const SYSTEM_AUTHOR = {
  name: "Catamorphic",
  email: "system@catamorphic.dev",
};

/**
 * Derive a git commit author from the opaque `externalUserId`. We synthesize
 * an email because catamorphic has no users table — the host knows the real
 * email, we just need something git will accept and that is stable per user.
 */
export function authorFor(externalUserId: string): {
  name: string;
  email: string;
} {
  return {
    name: externalUserId,
    email: `${externalUserId}@users.catamorphic.dev`,
  };
}
