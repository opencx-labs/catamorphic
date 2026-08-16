/**
 * Catamorphic is host-agnostic. The host (e.g. a SaaS app) owns the real user/org
 * model; catamorphic only cares about two opaque string identifiers:
 *
 * - `tenantId` — the host's org / workspace id. Becomes the UUID stored in
 *   `catamorphic.tenants.id` + referenced by `catamorphic.projects.tenant_id`.
 *   Auto-upserted on first use.
 * - `externalUserId` — the host's user id. Not persisted in any catamorphic
 *   table; used only for per-user git working directories and commit authorship.
 *
 * Services defined in this package accept {@link Identity} explicitly. They
 * intentionally do NOT fall back to any default — catamorphic is embed-only,
 * so the host is always responsible for supplying identity.
 */
export interface Identity {
  tenantId: string;
  externalUserId: string;
  /**
   * The artifacts this identity may touch. Absent = a full identity: the
   * whole project surface (files, deploys, secrets, agents, every run
   * control) — a builder. Present = a scoped identity: it may reach exactly
   * the listed artifacts (an app and, transitively, the workflows frozen into
   * its published version; a workflow directly) and nothing else — a viewer.
   *
   * Scope is the *output* of host policy, never its input: the host decides
   * which of its users are builders and which artifacts each viewer is
   * entitled to (an entitlement table, a role, a workflow that resolves
   * roles — the host's business), and catamorphic only enforces the result.
   * An empty scope is a valid identity that may do nothing.
   */
  scope?: readonly ArtifactRef[];
}

/**
 * A reference to one artifact a project publishes. Refs name artifacts by
 * `(projectId, name)` rather than by row id: that is what a host's
 * entitlement table naturally keys on, it is stable across republishes, and
 * it lets catamorphic resolve "the currently active published version" at
 * check time — a retired version can never be named, so it can never be
 * reached (ADR 0036, ADR 0053).
 */
export type ArtifactRef = AppRef | WorkflowRef | DocumentRef;

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
 * Reserved for published documents (ADR 0053): a file path in the project,
 * served to an audience. Carried in the type so publications never have to
 * touch `Identity` again; no surface enforces or serves it yet, so a scope
 * holding only document refs allows nothing.
 */
export interface DocumentRef {
  kind: "document";
  projectId: string;
  path: string;
}

/** True when the identity is scoped (a viewer) rather than full (a builder). */
export function isScoped(identity: Identity): boolean {
  return identity.scope !== undefined;
}

/** Structural equality on the fields that identify an artifact. */
export function sameArtifact(a: ArtifactRef, b: ArtifactRef): boolean {
  if (a.kind !== b.kind || a.projectId !== b.projectId) return false;
  switch (a.kind) {
    case "app":
      return a.name === (b as AppRef).name;
    case "workflow":
      return a.name === (b as WorkflowRef).name;
    case "document":
      return a.path === (b as DocumentRef).path;
  }
}

/** Whether a scope (from a scoped identity) contains the given artifact. */
export function scopeCovers(
  scope: readonly ArtifactRef[],
  ref: ArtifactRef,
): boolean {
  return scope.some((entry) => sameArtifact(entry, ref));
}

/**
 * Narrows an identity to a single artifact — the primitive every
 * artifact-scoped surface (an app's routes, an app's MCP endpoint) applies
 * structurally to whoever arrives:
 *
 * - a full identity becomes scoped to exactly that artifact (a builder using
 *   their own app is confined to it while inside it — the untrusted bundle
 *   never inherits project access, ADR 0036);
 * - a scoped identity that covers the artifact is narrowed to it;
 * - a scoped identity that does not cover it gets an empty scope and can do
 *   nothing on that surface.
 *
 * Narrowing can only ever shrink access, so it is always safe to apply.
 */
export function narrowIdentity(identity: Identity, ref: ArtifactRef): Identity {
  const scope =
    identity.scope === undefined || scopeCovers(identity.scope, ref)
      ? [ref]
      : [];
  return { ...identity, scope };
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
