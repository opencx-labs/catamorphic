import type { Identity } from "@catamorphic/core";
import type { FastifyRequest } from "fastify";

const TENANT_HEADER = "x-catamorphic-tenant-id";
const EXTERNAL_USER_HEADER = "x-external-user-id";

const USER_ID_RE = /^[A-Za-z0-9._-]+$/;
const TENANT_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Per-request identity resolver for the Fastify HTTP surface. Reads the
 * `X-Catamorphic-Tenant-Id` and `X-External-User-Id` headers. Both are
 * required on every request — catamorphic is embed-only, so the host app is
 * always responsible for injecting identity from its own auth context.
 */
export function resolveIdentity(request: FastifyRequest): Identity {
  return {
    tenantId: getTenantId(request),
    externalUserId: getExternalUserId(request),
  };
}

export function getExternalUserId(request: FastifyRequest): string {
  const raw = request.headers[EXTERNAL_USER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.trim()) {
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
  if (!value || !value.trim()) {
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
