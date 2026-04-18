import type { FastifyRequest } from "fastify";

export const DEFAULT_TENANT_ID = "00000000-0000-0000-0000-000000000001";
export const DEFAULT_EXTERNAL_USER_ID = "default";

export const SYSTEM_AUTHOR = {
  name: "Catamorphic",
  email: "system@catamorphic.dev",
};

const USER_ID_RE = /^[A-Za-z0-9._-]+$/;

/**
 * Resolve the acting user for a request. Embedding apps are expected to set
 * `X-External-User-Id`. When missing (single-user mode, local dev), we fall
 * back to {@link DEFAULT_EXTERNAL_USER_ID} so the FS backend still maps each
 * request to a stable dev clone.
 */
export function getExternalUserId(request: FastifyRequest): string {
  const raw = request.headers["x-external-user-id"];
  const value = Array.isArray(raw) ? raw[0] : raw;
  if (!value) return DEFAULT_EXTERNAL_USER_ID;
  const trimmed = value.trim();
  if (!trimmed) return DEFAULT_EXTERNAL_USER_ID;
  if (!USER_ID_RE.test(trimmed) || trimmed.length > 128) {
    throw new Error(`Invalid X-External-User-Id header`);
  }
  return trimmed;
}

export function authorFor(externalUserId: string): {
  name: string;
  email: string;
} {
  return {
    name: externalUserId,
    email: `${externalUserId}@users.catamorphic.dev`,
  };
}
