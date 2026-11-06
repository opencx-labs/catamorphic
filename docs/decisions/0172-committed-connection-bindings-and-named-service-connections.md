# 0172 — Committed connection bindings, named service connections, organization administrators

- **Status:** Accepted
- **Date:** 2026-09-27
- **Refines:** 0065, 0086, 0158, 0162, 0163

## Context

The gateway (ADRs 0162, 0163) could broker a read-only replica, an HTTP API,
or a remote MCP server for unattended agents, but a stock Work server had no
way to set one up. Environment connection bindings lived in a table written
only through a host-issued `connections:write`, which no member ever held,
and service connections were anonymous rows filled with raw credential text
that bypassed each provider's own checks. The gateway itself capped HTTP
bodies at 1 MiB, opened a Postgres session per call, and could not authorize
MCP servers without dynamic client registration.

## Decision

**Bindings are committed.** Each Environment in `.work/project.json` declares
its connection aliases: `{ "provider", "principal": "member" | "service" |
"either", "service"?, "capabilities"? }`. `service` names a service
connection; `capabilities` narrows the alias (absent keeps the connection's
own). Bindings are read with the Environment on demand, exactly as
Environments are, so there is no table and no reconciliation; invalid entries
are reported like other Environment errors, and access changes are reviewed
in pull requests. A host may offer aliases of its own beside the committed
ones (`connectionBindings`, used by the desktop for its profile MCP servers,
ADR 0086); a committed alias of the same name wins. Grants, enablements, and
trigger snapshots refer to the alias and the exact connection id; a snapshot
fails closed when the name now resolves to another connection.

**Service connections are named and authorized like any connection.** A
service connection has a name, unique among live connections of the tenant
(`tenant_service`) or of one project (`project_service`); a binding resolves
the project's name first. An administrator creates one pending, then
authorizes it through the provider's ordinary challenge (form, URL with the
server's own callback, or device), so provider vetting such as the read-only
role check always runs. Authorizing again rotates; revoking frees the name.
The raw credential and binding endpoints are removed.

**Organization administrators.** A Work server account may be an
administrator: the operator marks the first ones (`/_work/operator/users`
with `administrator`, or `/_work/operator/administrators`), and any
administrator promotes others from the app. An administrator's API identity
carries the host-issued `connections:read` and `connections:write`; project
roles still cannot grant them (ADR 0158), app confinement still drops them,
and unattended work never inherits them. `/me` reports them so clients show
the admin surface. The operator listener and the API offer the same
operations: list providers, create, authorize, rotate, and revoke named
service connections, and promote or demote administrators.

**Gateway limits (#116).** `http` entries take `maxResponseBytes` and
`timeoutMs` under host ceilings (16 MiB, 120 s). A larger GET body is read in
byte ranges on whole UTF-8 characters: the result reports `range.offset`,
`length`, `nextOffset`, and `totalBytes`, and the agent writes parts to its
workspace instead of truncating. The Postgres provider keeps a small pool per
connection id and credential revision with an idle timeout; rotation,
refresh, and revocation close it (`ConnectionProvider.release`), and every
per-call step (read-only transaction, timeouts, EXPLAIN ceilings, cursor
budget, rollback) still runs, with a session that fails to roll back
destroyed. `mcp` entries take `oauth.client` (id, secret from an environment
variable, scopes) for pre-registered clients.

Considered: reconciling a bindings table on deploy (two sources of truth for
one committed file) and an allowlist of projects per tenant connection
(project service connections already scope a name to one project).

## Consequences

Publishing a binding to a tenant service connection is a `program:publish`
decision reviewed like any change; organizations that want a connection
reachable from one project only create it as a project service connection.
Hosts that wrote bindings through the old API supply them as committed
configuration or through `connectionBindings`. Member authorization UIs list
an Environment's committed aliases from the same read. Query results still
enter model context, so views and grants remain the way to keep personal
data out.
