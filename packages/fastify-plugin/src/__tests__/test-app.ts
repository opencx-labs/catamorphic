import { type AppConfig, createApp } from "../app.js";
import {
  type IdentityResolver,
  identityFromHeaders,
} from "../http-identity.js";

/** The builder every contract test runs as unless it sets identity headers. */
export const TEST_IDENTITY = {
  tenantId: "test-tenant",
  externalUserId: "test-user",
};

/**
 * Route tests drive the API as a builder by default; a test that sets the
 * identity headers takes over (the header resolver validates them exactly as
 * a header-terminated host would see it).
 */
export function createTestApp(config: Partial<AppConfig> = {}) {
  const fromHeaders = identityFromHeaders();
  const identity: IdentityResolver = (request) =>
    request.headers["x-catamorphic-tenant-id"] ||
    request.headers["x-external-user-id"]
      ? fromHeaders(request)
      : TEST_IDENTITY;
  return createApp({ identity, ...config });
}
