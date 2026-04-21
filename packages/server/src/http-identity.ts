import {
  DEFAULT_EXTERNAL_USER_ID,
  DEFAULT_TENANT_ID,
  type Identity,
} from "@catamorphic/core";
import type { FastifyRequest } from "fastify";

const TENANT_HEADER = "x-catamorphic-tenant-id";
const EXTERNAL_USER_HEADER = "x-external-user-id";

const USER_ID_RE = /^[A-Za-z0-9._-]+$/;
const TENANT_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Per-request identity resolver for the Fastify HTTP surface. Reads the
 * `X-Catamorphic-Tenant-Id` and `X-External-User-Id` headers. When the server
 * is configured with `standalone: true` (i.e. the local playground), missing
 * headers fall back to {@link DEFAULT_TENANT_ID} + {@link DEFAULT_EXTERNAL_USER_ID}.
 * Embedded deployments run with `standalone: false` and require the headers.
 */
export function resolveIdentity(
  request: FastifyRequest,
  opts: { standalone: boolean },
): Identity {
  return {
    tenantId: getTenantId(request, opts),
    externalUserId: getExternalUserId(request, opts),
  };
}

export function getExternalUserId(
  request: FastifyRequest,
  opts: { standalone: boolean },
): string {
  const raw = request.headers[EXTERNAL_USER_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.trim()) {
    if (opts.standalone) return DEFAULT_EXTERNAL_USER_ID;
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

export function getTenantId(
  request: FastifyRequest,
  opts: { standalone: boolean },
): string {
  const raw = request.headers[TENANT_HEADER];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value || !value.trim()) {
    if (opts.standalone) return DEFAULT_TENANT_ID;
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
