import {
  PROJECT_PERMISSIONS,
  type ProjectPermissionName,
} from "@catamorphic/workflow";

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
  /** Untrusted placement hint. Client execution verifies owner and lease. */
  clientRunnerId?: string;
  /**
   * The artifacts this identity may touch. Absent = the ROOT identity: every
   * project of the tenant, every surface, the whole store — the desktop's
   * own local projects and a host's service identity (ADR 0055). Present =
   * a scoped identity that may reach exactly the listed artifacts and
   * nothing else: an `app`, `workflow` or `agent` ref (a name, or `*` for
   * every one) lets it use that artifact; a `document` ref grants a file or
   * subtree, and the project store is reachable ONLY through document refs.
   * What it may do beyond using artifacts (read or change the program,
   * secrets, other people's chats…) is `projectPermissions` (ADR 0158).
   *
   * Scope is the *output* of host policy, never its input: the host decides
   * which artifacts and permissions each user is entitled to (a role file
   * expanded by `resolveRoles`, an entitlement table — the host's business),
   * and catamorphic only enforces the result. An empty scope is a valid
   * identity that may do nothing.
   */
  scope?: readonly ArtifactRef[];
  /**
   * Logical project Environments this identity may allocate work into.
   * Absent together with artifact scope means the host root identity. A
   * scoped identity requires a ref naming the Environment, or `*`.
   */
  executionScope?: readonly ExecutionEnvironmentRef[];
  /** Environment-local connection aliases this caller may use. */
  connectionScope?: readonly ConnectionUseRef[];
  /** Host-issued administrative permissions, never sourced from project code. */
  controlPlanePermissions?: readonly ControlPlanePermission[];
  /**
   * Project permissions granted by committed project roles (ADR 0158):
   * Catamorphic's `thing:action` names (`program:read`, `sessions:write`…),
   * `thing:*`, `*`, or an embedder's own namespaced capability.
   */
  projectPermissions?: readonly ProjectPermissionRef[];
}

/**
 * A granted project permission: one of {@link PROJECT_PERMISSIONS}, an
 * embedder's namespaced capability (`acme:approve_deals`), `thing:*` for
 * every action on a thing, or `*` for every permission.
 */
export type ProjectPermission = string;

export { PROJECT_PERMISSIONS, type ProjectPermissionName };

/** Syntax of a permission a role may grant (wildcards included). */
export const PROJECT_PERMISSION_GRANT_PATTERN =
  /^(\*|[a-z][a-z0-9._-]*:(\*|[a-z][a-z0-9._-]*))$/;

/** Syntax of one concrete permission, as a workflow declares it. */
export const PROJECT_PERMISSION_PATTERN =
  /^[a-z][a-z0-9._-]*:[a-z][a-z0-9._-]*$/;

export interface ProjectPermissionRef {
  projectId: string;
  permission: ProjectPermission;
}

/**
 * Whether a granted permission covers a wanted one: `*` covers all,
 * `thing:*` every action on the thing, and `write` or `publish` on a thing
 * also reads it. Nothing else implies anything.
 */
export function permissionCovers(
  granted: ProjectPermission,
  wanted: ProjectPermission,
): boolean {
  if (granted === "*" || granted === wanted) return true;
  const [grantedThing, grantedAction] = granted.split(":");
  const [wantedThing, wantedAction] = wanted.split(":");
  if (!grantedThing || grantedThing !== wantedThing) return false;
  if (grantedAction === "*") return true;
  return (
    wantedAction === "read" &&
    (grantedAction === "write" || grantedAction === "publish")
  );
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

/**
 * Host-issued permissions over resources shared across a tenant's projects,
 * never granted by project code: service connections and their audit.
 * `connections:write` also reads.
 */
export type ControlPlanePermission = "connections:read" | "connections:write";

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
      (ref.environment === "*" || ref.environment === environment) &&
      (ref.alias === "*" || ref.alias === alias),
  );
}

export function hasControlPlanePermission(
  identity: Identity,
  permission: ControlPlanePermission,
): boolean {
  return (
    (identity.scope === undefined && identity.executionScope === undefined) ||
    identity.controlPlanePermissions?.some((granted) =>
      permissionCovers(granted, permission),
    ) === true
  );
}

/** Whether an identity holds a project permission (root holds them all). */
export function hasProjectPermission(
  identity: Identity,
  projectId: string,
  permission: ProjectPermission,
): boolean {
  if (identity.scope === undefined) return true;
  return (
    identity.projectPermissions?.some(
      (ref) =>
        ref.projectId === projectId &&
        permissionCovers(ref.permission, permission),
    ) ?? false
  );
}

/**
 * The permissions both a grant list and an identity hold. A grant the
 * identity covers stays whole; a wider grant (`*`, `thing:*`, `write` over
 * a held `read`) keeps only the identity's own grants beneath it. It can
 * only narrow.
 */
export function intersectProjectPermissions(
  grants: readonly ProjectPermissionRef[],
  identity: Identity,
): ProjectPermissionRef[] {
  if (identity.scope === undefined) return [...grants];
  const kept = grants.flatMap((grant) =>
    hasProjectPermission(identity, grant.projectId, grant.permission)
      ? [grant]
      : (identity.projectPermissions ?? []).filter(
          (held) =>
            held.projectId === grant.projectId &&
            permissionCovers(grant.permission, held.permission),
        ),
  );
  return kept.filter(
    (ref, index) =>
      kept.findIndex(
        (other) =>
          other.projectId === ref.projectId &&
          other.permission === ref.permission,
      ) === index,
  );
}

/**
 * The artifact refs both a scope and an identity reach: a ref the identity
 * covers stays; an app, workflow or agent `*` the identity does not hold
 * keeps the identity's own refs of that kind (an agent keeps the scope's
 * tool narrowing). It can only narrow.
 */
export function intersectScope(
  scope: readonly ArtifactRef[],
  identity: Identity,
): ArtifactRef[] {
  if (identity.scope === undefined) return [...scope];
  const held = identity.scope;
  return scope.flatMap((ref): ArtifactRef[] => {
    if (scopeCovers(held, ref)) return [ref];
    if (ref.kind === "document" || ref.kind === "sessions") return [];
    if (ref.name !== EVERY_ARTIFACT) return [];
    return held.flatMap((entry): ArtifactRef[] => {
      if (entry.projectId !== ref.projectId) return [];
      if (ref.kind === "agent" && entry.kind === "agent") {
        return [
          ref.toolPolicies
            ? { ...entry, toolPolicies: ref.toolPolicies }
            : entry,
        ];
      }
      if (ref.kind === "app" && entry.kind === "app") return [entry];
      if (ref.kind === "workflow" && entry.kind === "workflow") return [entry];
      return [];
    });
  });
}

/**
 * The concrete permissions an identity holds on a project, wildcards and
 * implications expanded: what `/me` reports so clients can simply test
 * membership. Embedder capabilities appear as granted.
 */
export function effectiveProjectPermissions(
  identity: Identity,
  projectId: string,
): string[] {
  const core = PROJECT_PERMISSIONS.filter((permission) =>
    hasProjectPermission(identity, projectId, permission),
  );
  const custom = (identity.projectPermissions ?? [])
    .filter(
      (ref) =>
        ref.projectId === projectId &&
        PROJECT_PERMISSION_PATTERN.test(ref.permission) &&
        !ref.permission.endsWith(":*") &&
        !(PROJECT_PERMISSIONS as readonly string[]).includes(ref.permission),
    )
    .map((ref) => ref.permission);
  return [...new Set([...core, ...custom])];
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
      (ref) =>
        ref.projectId === projectId && (ref.name === "*" || ref.name === name),
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
  | AppRef
  | WorkflowRef
  | DocumentRef
  | AgentRef
  | SessionsRef;

/** The name an app, workflow or agent grant uses for "every one". */
export const EVERY_ARTIFACT = "*";

/**
 * A committed project agent (ADR 0050, `.catamorphic/agents/<slug>.json`) a scoped
 * identity may open sessions on. `toolPolicies` is the caller's own
 * narrowing of that agent's tools (ADR 0055): per server key (a connector's
 * `serverKeyOf(name)`, or `catamorphic` for the project's workflow tools),
 * one more layer in the ADR 0054 intersection — it can only narrow.
 */
export interface AgentRef {
  kind: "agent";
  projectId: string;
  /**
   * The agent's slug (`.catamorphic/agents/<slug>.json`), or `*` for every
   * agent the project offers, the host's own included.
   */
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
  /** The app's name (its `.catamorphic/apps/<name>` workspace), or `*`. */
  name: string;
  /**
   * Which build the ref resolves to — a resolution hint, not part of the
   * artifact's identity (two refs differing only in channel name the same
   * app). `published` (default) is the active published version — the only
   * thing a viewer ever sees. `dev` is the latest ready build *by this same
   * user* (the author opening the build they are working on); for anyone
   * else a `dev` ref resolves to nothing, so a viewer asking for `dev` gets
   * nothing rather than something wider.
   */
  channel?: "published" | "dev";
  /** An authorized retained build of a session app. */
  versionId?: string;
}

export interface WorkflowRef {
  kind: "workflow";
  projectId: string;
  /** The exported workflow name at the production commit, or `*`. */
  name: string;
}

/**
 * The caller's own chat sessions in a project, on every agent of it: the
 * ref an app-narrowed identity gains when the app's built version declares
 * `catamorphic.access.sessions` (ADR 0148). It never reaches another
 * user's sessions — `assertAgentSessionAccess` still requires the session
 * owner to be the caller — and it grants nothing beyond reading and the
 * session actions a viewer may take on their own conversations.
 */
export interface SessionsRef {
  kind: "sessions";
  projectId: string;
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
 * The project principal (ADR 0156): project automations run as it and
 * project chats belong to it. It is never a person; a chat it owns is shared
 * by everyone whose role reaches the chat's agent.
 */
export const PROJECT_PRINCIPAL_ID = "catamorphic:project";

export function isProjectPrincipal(externalUserId: string): boolean {
  return externalUserId === PROJECT_PRINCIPAL_ID;
}

/**
 * The identity one project automation runs with (ADR 0158): its own
 * workflow, the project's agents (for the chats it keeps), exactly the
 * Environment, connection aliases and permissions consented to when it was
 * turned on — and nothing of the person who turned it on. A hand-started
 * run reaching the project chat gets the same shape without a workflow.
 */
export function projectPrincipalIdentity(input: {
  tenantId: string;
  projectId: string;
  environment: string;
  workflowName?: string;
  connections?: ReadonlyArray<{
    alias: string;
    capabilities?: readonly string[];
  }>;
  permissions?: readonly ProjectPermission[];
}): Identity {
  return {
    tenantId: input.tenantId,
    externalUserId: PROJECT_PRINCIPAL_ID,
    scope: [
      ...(input.workflowName
        ? [
            {
              kind: "workflow" as const,
              projectId: input.projectId,
              name: input.workflowName,
            },
          ]
        : []),
      { kind: "agent", projectId: input.projectId, name: EVERY_ARTIFACT },
    ],
    executionScope: [{ projectId: input.projectId, name: input.environment }],
    projectPermissions: (input.permissions ?? []).map((permission) => ({
      projectId: input.projectId,
      permission,
    })),
    connectionScope: (input.connections ?? []).map((connection) => ({
      projectId: input.projectId,
      environment: input.environment,
      alias: connection.alias,
      ...(connection.capabilities
        ? { capabilities: connection.capabilities }
        : {}),
    })),
  };
}

/**
 * Whether an identity uses the project at all: root, or a scoped identity
 * holding any ref or permission on it (an agent to chat with, a document
 * to read, a workflow to call, `program:read`…). The gate for member-facing
 * surfaces that are not themselves an artifact: skills, proposals, `/me`.
 */
export function mayUseProject(identity: Identity, projectId: string): boolean {
  if (identity.scope === undefined) return true;
  return (
    identity.scope.some((ref) => ref.projectId === projectId) ||
    (identity.projectPermissions ?? []).some(
      (ref) => ref.projectId === projectId,
    )
  );
}

/** Structural equality on the fields that identify an artifact. */
export function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  if (a.kind !== b.kind || a.projectId !== b.projectId) return false;
  switch (a.kind) {
    case "app":
      return a.name === (b as AppRef).name;
    case "workflow":
      return a.name === (b as WorkflowRef).name;
    case "agent":
      return a.name === (b as AgentRef).name;
    case "document":
      return a.path === (b as DocumentRef).path;
    case "sessions":
      return true;
  }
}

/** Whether a scoped identity may read its own sessions across the project. */
export function scopeCoversSessions(
  identity: Identity,
  projectId: string,
): boolean {
  return (
    identity.scope !== undefined &&
    scopeCovers(identity.scope, { kind: "sessions", projectId })
  );
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
 * Document refs cover by subtree and access; an app, workflow or agent
 * entry named `*` covers every one of its kind in the project; everything
 * else by identity.
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
  return scope.some(
    (entry) =>
      sameArtifact(entry, ref) ||
      ((entry.kind === "app" ||
        entry.kind === "workflow" ||
        entry.kind === "agent") &&
        entry.kind === ref.kind &&
        entry.projectId === ref.projectId &&
        entry.name === EVERY_ARTIFACT),
  );
}

/**
 * Narrows an identity to a single artifact — the primitive every
 * artifact-scoped surface (an app's routes, an app's MCP endpoint) applies
 * structurally to whoever arrives:
 *
 * - root becomes scoped to exactly that artifact (someone using their own
 *   app is confined to it while inside it — the untrusted bundle never
 *   inherits project access, ADR 0036);
 * - a scoped identity that covers the artifact is narrowed to it;
 * - a scoped identity that does not cover it gets an empty scope and can do
 *   nothing on that surface.
 *
 * Narrowing can only ever shrink access, so it is always safe to apply.
 */
export function narrowIdentity(identity: Identity, ref: ArtifactRef): Identity {
  return confineIdentity(identity, identityCovers(identity, ref) ? [ref] : []);
}

/**
 * The identity reduced to exactly `scope`: no project or control-plane
 * permission survives (ADR 0158), so an admin inside an app holds only
 * what the app is given.
 */
export function confineIdentity(
  identity: Identity,
  scope: readonly ArtifactRef[],
): Identity {
  return {
    ...identity,
    scope,
    projectPermissions: [],
    controlPlanePermissions: [],
  };
}

/**
 * Whether an identity may reach an artifact: root reaches everything; a
 * scoped identity exactly what its scope covers (`*` included).
 */
export function identityCovers(identity: Identity, ref: ArtifactRef): boolean {
  return identity.scope === undefined || scopeCovers(identity.scope, ref);
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
