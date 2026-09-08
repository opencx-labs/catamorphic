# 0072: Remote OAuth, admission, and project administration

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes:** Remote authentication, invite, and privileged-user portions of 0055, 0059, 0060, and 0061

## Context

The stock server's bearer file combines user identity, one project's access,
invitations, and a privileged admin account. Tokens travel in connect links
and cannot be refreshed through a normal sign-in. The same assumptions have
spread into desktop remote storage, PWA profiles, pairing, and session
mirroring. Builder access also implicitly authorizes membership management,
so project construction and team administration cannot be delegated
independently.

Catamorphic must remain usable inside hosts with their own identity systems.
The stock host additionally needs local credentials, upstream OIDC login,
native desktop authorization, browser PWA authorization, and MCP discovery
without creating separate authorization paths.

## Decision

The stock server exposes one OAuth authorization server using authorization
code, S256 PKCE, access tokens, refresh tokens, dynamic public-client
registration, and standard authorization-server and protected-resource
discovery. Desktop, PWA, and MCP clients use it. Better Auth local credentials
and configured upstream OIDC providers are login methods behind that server;
they do not change Catamorphic API authorization.

An access token resolves exactly one stable host user. It carries no project,
role, or grant. On each API request the stock host expands all current
memberships for that user into a scoped Catamorphic identity. Signing in
without a membership yields an authenticated identity with empty scope.

Project roles may grant `memberships:manage` and `roles:manage` separately
from builder access. Managing membership does not permit assigning a role
that grants project administration. That assignment, and every change to a
committed `roles/*.json` policy file, requires `roles:manage`. Operational
setup identities can establish the initial ordinary user and role but never
become application users.

The stock host owns admission policy with four modes: invitation only,
approved verified-email domain, authenticated access request, and open
authenticated join. An invitation identifies proposed membership and may be
sent as a link, but it is not an API credential. Admission validates committed
roles before writing membership. Custom hosts may implement the same outcome
through their existing entitlement system and do not adopt the stock tables
or Better Auth.

Token-bearing connect links, `auth.json`, boot-printed admin tokens, special
server-owner users, and admin-token application routes are deleted in the
cutover. An `Open in desktop` link contains only a server locator and optional
project or invitation identifier.

## Consequences

Every remote client has one refresh and reconnect model, and MCP-compatible
clients can discover authorization without copied secrets. Revocation and
role changes take effect on the next request because membership is resolved
fresh. One authenticated user may work across multiple projects without one
credential per project.

Role policy becomes a protected part of the project program, which requires
path-aware authorization in every program mutation route. Stock admission
adds host state and tests, but it remains outside Better Auth and outside the
embeddable framework contract. Existing token links and local remote records
are intentionally not migrated because the product is greenfield.
