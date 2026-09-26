# Auth and identity

## Keep the boundary explicit

Authentication answers who the caller is. Catamorphic authorization answers
which project artifacts and Environments that caller may use. A successful
login does not grant a project.

Custom hosts keep their existing provider and session model. After verifying a
request, return a Catamorphic identity directly or resolve committed project
roles through `core.memberships.identityFor` / `resolveRoles`. Better Auth is
not required outside the stock host.

The stock host may offer configured OAuth/OIDC and a local username/password
fallback. All methods must resolve to the same stable user id and the same
membership path. Do not branch authorization by sign-in method.

## Questions that may remain

- Which existing user id is stable across sign-ins?
- Which organization/workspace becomes the tenant?
- Is admission invitation-only, approved-domain, access-request, or open
  authenticated join?
- Which committed role does an invitation or admission policy assign?
- Who may manage memberships and protected role policy?
- Which OAuth redirect and desktop deep-link origins are trusted?

Ask only those not answered in the visible app or deployment.

## Roles and operators

Roles live in `.catamorphic/roles/<slug>.json` and are reviewed with the project. Memberships
bind a stable external user id to those roles and grants. Editing the program
(`program:write`), making it live (`program:publish`), membership management
(`memberships:write`), and role-policy management (`roles:write`) are separate
permissions; do not make everyone who edits the program an administrator by
accident. Changing any `.catamorphic/roles/*.json` needs `roles:write`.

Role `permissions` use the `thing:action` form (ADR 0158). Core enforces
`program` (read, write, publish) and `secrets`, `automations`, `webhooks`,
`runs`, `sessions`, `memberships`, `roles`, and `publications` (read, write).
`write` and `publish` imply `read` on the same thing; a role may grant
`thing:*` or `*`. Other valid names, such as `brain:maintain`, survive identity
resolution for an embedder's services and project-authored presentation but
grant no framework authority on their own. Service connections are governed by
the host-issued `connections:read` and `connections:write`, which project roles
cannot grant. Desktop presentation may match resolved `permissions` on shared
sidebar items and project starting actions. It must not branch on role names.

Machine/database authority is outside this model. There is no server-owner or
super-admin user. A setup agent with deployment access may provision the first
ordinary user and membership through maintained host operations.

An invitation admits a user once; it is not a recovery credential after
membership revocation. Test sign-in, redemption, revocation, and attempted replay
through the normal API. Email-targeted and approved-domain admission require
verified email from the configured auth path. Do not assume the local password
fallback verifies email or weaken verification to make admission work.

Never write password hashes or auth rows directly. Never put access tokens in
connect links. Browser and desktop authorization should use authorization code
with PKCE; MCP should use its standards-based authorization discovery.
