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
   * Present when this request reaches catamorphic through a published app
   * rather than the project surface. An audience-carrying identity may invoke
   * exactly the workflows frozen into that app version and nothing else —
   * no project reads, no file writes, no deploys. The host decides which of
   * its users get an audience-scoped identity (app viewers) versus a full one
   * (project builders); catamorphic only enforces the boundary.
   */
  appAudience?: AppAudience;
}

export interface AppAudience {
  appId: string;
  appVersionId: string;
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
