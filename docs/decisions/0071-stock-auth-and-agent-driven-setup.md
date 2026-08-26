# 0071: Stock auth and agent-driven setup

- **Status:** Accepted
- **Date:** 2026-08-26
- **Supersedes:** Authentication and operator setup portions of 0059

## Context

The stock server currently treats a token file and a boot-printed root token as
both identity and administration. That makes reconnection hard, introduces a
special privileged human identity, and cannot support browser authorization,
OAuth providers, or standards-based MCP authentication. Catamorphic embedders,
however, already have application and authentication choices that the
framework must not replace.

The stock server still needs a zero-provider path. It must stay simple enough
for a coding agent operating a checkout or container to provision an ordinary
user without a setup UI, password hashing code, or direct database row
construction.

## Decision

Catamorphic's framework identity contract remains host-injected and
auth-provider-neutral. Better Auth is used only by the stock host. Existing
hosts adapt their verified sessions and identity model instead of adopting
Better Auth.

Stock auth supports configured OAuth/OIDC providers and an operator-selected
local username/password fallback. Both resolve to the same Better Auth user id,
which becomes Catamorphic's `externalUserId`; authorization remains committed
project roles plus memberships. There is no server owner, super-admin user,
first-run wizard, or auth administration UI.

Agent-driven setup is the initial administration surface. Small maintained,
machine-local operations call Catamorphic services to create a project, commit
explicit roles, configure admission, and call Better Auth's server user
creation API before assigning an ordinary membership. They are discovered from
source and invoked by a setup agent over loopback using an owner-only operator
credential. They never log credentials, construct auth rows, or invent role
policy. There is no human setup CLI or first-run UI.

Local stock installs keep auth data in a separate PGlite database at
`<data>/auth-db`, isolating Better Auth migrations from Catamorphic's schema and
long-lived PGlite session. `DATABASE_URL` installs use a dedicated
`catamorphic_auth` schema in the same Postgres. The signing secret is injected
or persisted with owner-only permissions and is never a user credential.

One public setup skill covers both the stock server and custom hosts. It first
inspects the visible application, auth, database, and deployment, asks only
questions the setup leaves open, and routes to focused guidance. It gives
contracts and pointers rather than requiring one stack or command sequence.

If local provisioning grows beyond one auth call, role validation, and
membership assignment, built-in local credentials are removed rather than
expanded into an account-management product.

## Consequences

The stock server can add OAuth, reconnectable sessions, and MCP authorization
without making Better Auth part of the framework. PGlite remains zero-service
and Postgres remains a supported scale-up path. Initial setup remains possible
without a provider or privileged in-product user, but requires an agent with
deployment access. Role definitions stay reviewable project files.

The old token file and admin routes are deleted without compatibility or
dual-write code.
