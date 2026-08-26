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

Roles live in `roles/<slug>.json` and are reviewed with the project. Memberships
bind a stable external user id to those roles and grants. Builder access,
membership management, and protected role-policy management are separate
capabilities; do not make every builder an administrator by accident.

Machine/database authority is outside this model. There is no server-owner or
super-admin user. A setup agent with deployment access may provision the first
ordinary user and membership through maintained host operations.

Never write password hashes or auth rows directly. Never put access tokens in
connect links. Browser and desktop authorization should use authorization code
with PKCE; MCP should use its standards-based authorization discovery.
