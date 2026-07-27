import type { Identity } from "@catamorphic/core";
import type { FastifyRequest } from "fastify";

const TENANT_HEADER = "x-catamorphic-tenant-id";
const EXTERNAL_USER_HEADER = "x-external-user-id";
const APP_ID_HEADER = "x-catamorphic-app-id";
const APP_VERSION_HEADER = "x-catamorphic-app-version-id";

const USER_ID_RE = /^[A-Za-z0-9._-]+$/;
const TENANT_ID_RE = /^[A-Za-z0-9._-]+$/;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Per-request identity resolver for the Fastify HTTP surface. Reads the
 * `X-Catamorphic-Tenant-Id` and `X-External-User-Id` headers. Both are
 * required on every request — catamorphic is embed-only, so the host app is
 * always responsible for injecting identity from its own auth context.
 *
 * When the host forwards a request that originated inside a published app, it
 * additionally sets `X-Catamorphic-App-Id` + `X-Catamorphic-App-Version-Id`.
 * These headers are a *narrowing* claim, never a widening one: they restrict
 * the identity to the app's frozen workflow set, so a guest forging them can
 * only reduce its own access. It is the host's job to set them on every
 * app-originated request — an app request forwarded without them would run
 * with the viewer's full project access.
 */
export function resolveIdentity(request: FastifyRequest): Identity {
  return {
    tenantId: getTenantId(request),
    externalUserId: getExternalUserId(request),
    appAudience: getAppAudience(request),
  };
}

function getAppAudience(
  request: FastifyRequest,
): Identity["appAudience"] | undefined {
  const appId = headerValue(request, APP_ID_HEADER);
  const appVersionId = headerValue(request, APP_VERSION_HEADER);
  if (!appId && !appVersionId) return undefined;
  if (!appId || !appVersionId) {
    throw new HttpIdentityError(
      "App requests must send both X-Catamorphic-App-Id and X-Catamorphic-App-Version-Id",
    );
  }
  if (!UUID_RE.test(appId) || !UUID_RE.test(appVersionId)) {
    throw new HttpIdentityError("Invalid app audience headers");
  }
  return { appId, appVersionId };
}

function headerValue(
  request: FastifyRequest,
  name: string,
): string | undefined {
  const raw = request.headers[name];
  const value = Array.isArray(raw) ? raw[0] : raw;
  return value?.trim() || undefined;
}

export function getExternalUserId(request: FastifyRequest): string {
  const raw = request.headers[EXTERNAL_USER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value?.trim()) {
    throw new HttpIdentityError(
      "Missing X-External-User-Id header. Embedding apps must pass the host user id on every request.",
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
      "Missing X-Catamorphic-Tenant-Id header. Embedding apps must pass the host org id on every request.",
    );
  }
  const trimmed = value.trim();
  if (!TENANT_ID_RE.test(trimmed) || trimmed.length > 128) {
    throw new HttpIdentityError("Invalid X-Catamorphic-Tenant-Id header");
  }
  return trimmed;
}

export class HttpIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HttpIdentityError";
  }
}
