# 0296: One OAuth token endpoint

- **Status:** Accepted (supersedes 0287's runtime compatibility provisions)
- **Date:** 2026-10-28

## Context

Better Auth 1.7 changed its token endpoint and confidential-client authentication
contract. ADR 0287 retained the old token URL and translated form-body client
secrets to preserve saved connections. During alpha, we accept breaking API
changes instead of maintaining these compatibility paths.

## Decision

Work serves token requests only at `/api/auth/oauth2/token`, through its existing
lifecycle gate and the current Better Auth implementation. Remove the
`/api/auth/mcp/token` alias and all client-secret translation. Clients use the
authentication method registered with the provider.

The one-time forward database migration remains: it converts persisted auth
data into the current schema, then stops applying when the old tables are gone.
It does not retain a second schema or authentication implementation.

## Consequences

Saved connections using the removed token URL must reconnect to discover the
current endpoints. Confidential clients must use their registered authentication
method. Fresh registrations, refresh rotation, revocation and resource binding
all use the same current implementation.
