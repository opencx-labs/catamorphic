# 0287: Better Auth 1.7 preserves Work's OAuth grants

- **Status:** Accepted (implements 0055 and 0161; runtime compatibility superseded by 0296)
- **Date:** 2026-10-27

## Context

Better Auth 1.7.14 fixes security advisories affecting Work's 1.6 dependency.
Its MCP provider is now a separate package, with new OAuth routes, split
access/refresh tables and hashed token storage. A manifest-only update breaks
sign-in and loses the meaning of Work's existing refresh-family ledger.

## Decision

The old token URL and client-secret translation below are superseded by
[0296](0296-one-oauth-token-endpoint.md). The forward database migration and
current opaque-grant design remain in force.

Keep `WorkAuth` as the private vendor boundary and retain ADR 0161's opaque,
immediately revocable grants. Use the new MCP provider with JWT disabled,
S256 PKCE and no refresh-token reuse interval. Work resolves opaque access
tokens independently of the short browser session used to authorize them.
Clients name the Work API resource explicitly; the resolver rejects tokens for
other audiences and proof-bound tokens until Work supports proof validation.

Convert the old auth tables in one migration transaction on both PGlite and
schema-scoped Postgres, under the existing replica migration lock. Preserve
users, clients, grants and approved consent; hash legacy tokens and encrypt
confidential client secrets in the new provider's format. Preserve access-row
IDs so the Work refresh-family ledger keeps referring to the same grants.
Any conversion failure rolls back the schema and data together.

Both the new token URL and the URL saved by existing clients run through one
Work lifecycle gate and one provider implementation. Consent uses the complete
signed authorization query, verified before display and again by the provider
on submission. Provider sign-in uses the new callback route.
Serve the new provider's issuer-path and resource-path well-known metadata
through the same handler, alongside Work's existing discovery URLs.
Reject auth paths changed by URL normalization before forwarding, so wildcard
routes cannot become token endpoints after skipping the lifecycle gate.
The saved token URL also normalizes form-body confidential client secrets to
Basic authentication, retaining the old endpoint's two accepted methods, which
1.6 did not distinguish in storage. The new token URL enforces registration.

## Consequences

Existing access and refresh credentials survive the upgrade without a parallel
authentication implementation. Operators update configured OIDC redirect URIs
to `/api/auth/callback/<id>`. An authorization flow started before the upgrade
must be restarted. Schema conversion is forward-only, so restoring an older
server requires restoring the corresponding database backup.
Remote PWA OAuth callbacks require HTTPS or exact loopback HTTP, as enforced
by the new provider's redirect URI validation.
