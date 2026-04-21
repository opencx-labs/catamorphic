/**
 * Catamorphic is host-agnostic. The host (e.g. OpenCX) owns the real user/org
 * model; catamorphic only cares about two opaque string identifiers:
 *
 * - `tenantId` — the host's org / workspace id. Becomes the UUID stored in
 *   `catamorphic.tenants.id` + referenced by `catamorphic.projects.tenant_id`.
 *   Auto-upserted on first use.
 * - `externalUserId` — the host's user id. Not persisted in any catamorphic
 *   table; used only for per-user git working directories and commit authorship.
 *
 * Services defined in this package accept {@link Identity} explicitly. They
 * intentionally do NOT fall back to any default. HTTP/standalone fallbacks live
 * in `@catamorphic/server`'s `http-identity.ts`.
 */
export interface Identity {
  tenantId: string;
  externalUserId: string;
}

export type TenantId = string;
export type ExternalUserId = string;

/**
 * Default tenant UUID used by the standalone playground + specs. Embedders
 * should pass their own `tenantId` (typically the host's org id) and never
 * reference this constant.
 */
export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";

/**
 * Default external user id used by the standalone playground when the request
 * omits the `X-External-User-Id` header. Embedders should pass their real
 * user id per request.
 */
export const DEFAULT_EXTERNAL_USER_ID = "default";

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
