import type { Identity } from "@catamorphic/core";
import type { FastifyRequest } from "fastify";

/**
 * The one identity mechanism of the HTTP surface. The host supplies a
 * resolver when it registers the plugin; it runs on every request (including
 * iframe navigations to served app documents, which carry the host's own
 * session cookie) and returns the caller's {@link Identity} — full for a
 * builder, scoped for a viewer — or `null` for "not authenticated" (401).
 *
 * There is no default: catamorphic is embed-only and never guesses who is
 * calling. Hosts that terminate auth elsewhere (a proxy, a sidecar behind
 * the host's gateway) pass {@link identityFromHeaders}; everyone else writes
 * the few lines that turn their verified session into an identity.
 */
export type IdentityResolver = (
  request: FastifyRequest,
) => Identity | null | Promise<Identity | null>;

const TENANT_HEADER = "x-catamorphic-tenant-id";
const EXTERNAL_USER_HEADER = "x-external-user-id";

const USER_ID_RE = /^[A-Za-z0-9._-]+$/;
const TENANT_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * A stock resolver reading `X-Catamorphic-Tenant-Id` and `X-External-User-Id`.
 * Only for hosts whose auth layer sits *in front of* the plugin and sets these
 * headers itself from a verified session (a proxy route, a gateway); never
 * expose a plugin using this resolver directly to browsers, since anyone
 * could then claim any identity. Both headers are required and yield full
 * identities — a header-terminated host that wants scoped viewers wraps this
 * in its own resolver.
 */
export function identityFromHeaders(): IdentityResolver {
  return (request) => ({
    tenantId: getTenantId(request),
    externalUserId: getExternalUserId(request),
  });
}

const IDENTITY_KEY = Symbol.for("catamorphic.identity");

interface IdentityCarrier {
  [IDENTITY_KEY]?: Identity;
}

/** Stores the resolved identity on the request (plugin-internal). */
export function attachIdentity(request: FastifyRequest, identity: Identity) {
  (request as unknown as IdentityCarrier)[IDENTITY_KEY] = identity;
}

/**
 * The identity the plugin's resolver attached to this request. Routes call
 * this; it never reads headers itself.
 */
export function resolveIdentity(request: FastifyRequest): Identity {
  const identity = (request as unknown as IdentityCarrier)[IDENTITY_KEY];
  if (!identity) {
    throw new HttpIdentityError(
      "No identity on request: the catamorphic plugin's identity resolver did not run",
    );
  }
  return identity;
}

export function getExternalUserId(request: FastifyRequest): string {
  const raw = request.headers[EXTERNAL_USER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.trim()) {
    throw new HttpIdentityError(
      "Missing X-External-User-Id header. Hosts using identityFromHeaders() must set the host user id on every request.",
    );
  }
  const trimmed = value.trim();
  if (!USER_ID_RE.test(trimmed) || trimmed.length > 128) {
    throw new HttpIdentityError("Invalid X-External-User-Id header");
  }
  return trimmed;
}

export function getTenantId(request: FastifyRequest): string {
  const raw = request.headers[TENANT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.trim()) {
    throw new HttpIdentityError(
      "Missing X-Catamorphic-Tenant-Id header. Hosts using identityFromHeaders() must set the host org id on every request.",
    );
  }
  const trimmed = value.trim();
  if (!TENANT_ID_RE.test(trimmed) || trimmed.length > 128) {
    throw new HttpIdentityError("Invalid X-Catamorphic-Tenant-Id header");
  }
  return trimmed;
}

/** A malformed identity claim from the host (400), distinct from 401. */
export class HttpIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpIdentityError";
  }
}
