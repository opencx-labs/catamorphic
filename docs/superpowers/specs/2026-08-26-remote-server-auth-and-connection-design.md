# Remote Server Authentication and Connection Design

## Status

Approved on 2026-08-26.

## Purpose

Make a Catamorphic project's optional remote server understandable,
recoverable, and easy to authenticate against. A project has at most one
remote Catamorphic server. Execution targets beneath that server are
Environments, not additional remotes.

This is a greenfield replacement. Existing token-bearing connect links,
`auth.json`, remote-link persistence, and connect-only UI are deleted when
their replacements land. There are no compatibility adapters, dual writes,
or legacy migrations for users in the wild.

## Product invariants

1. A project has zero or one Catamorphic remote. Environments belong beneath
   that remote and remain a separate concept.
2. Authentication proves who a caller is. Project memberships, committed
   roles, and grants decide what that caller may do.
3. Catamorphic libraries remain auth-provider-neutral. Embedders supply their
   existing authentication and identity mapping.
4. The stock server is a host. It may use Better Auth internally, but Better
   Auth never becomes a framework dependency or a Catamorphic identity model.
5. A deployment operator is not a privileged Catamorphic user. They have
   operational authority through the machine and database; inside
   Catamorphic they are an ordinary user with ordinary project roles.
6. Stock-server setup is agent-driven. There is no first-run wizard, server
   owner, super-admin account, or administration UI.
7. The setup guidance inspects the user's existing app, database, auth, and
   deployment before recommending a path. It asks whether the user wants to
   use existing or custom auth before offering stock local credentials.
8. Skills give decision guidance and canonical pointers. They do not force
   every host through one stack or command sequence.
9. GitHub CLI may supply credentials, but GitHub behavior has one API and git
   path after credential acquisition.
10. User-facing strings contain no em dashes or en dashes.

## 1. Auth boundary

The framework continues to consume a host-injected `IdentityResolver`.
Embedders map their current session, organization, user, and entitlement
model into Catamorphic identities and memberships. The setup skill first
inspects what the host already has and adapts to it.

The stock server uses Better Auth as a host implementation. Configured Google,
OIDC, or other providers authenticate through Better Auth. When the operator
chooses no provider, the stock server offers local username/password auth.
Local auth is a fallback selected during setup, not an implicit requirement
for custom hosts.

All successful sign-in methods produce the same server access and refresh
credentials. API authorization and membership resolution do not branch on
how the user authenticated.

## 2. Agent-driven stock setup

The public `setup-catamorphic-server` skill is the single discovery entry for
both stock-server setup and custom-host embedding. Its entrypoint asks only
the questions left open by the visible host:

- stock server or existing/custom host;
- current database and deployment shape;
- current authentication and identity model;
- whether to configure a provider or select local credentials;
- project source, code host, execution, and storage choices.

Substantial stock and custom-host mechanics live in routed references so an
agent reads only the applicable material. The skill is linked from the root
agent instructions, README, integration guide, Docker image, and
`catamorphic.ai` agent-discovery surface.

Local user provisioning must remain deliberately small. A maintained agent
script opens the installed stock-server configuration, calls Better Auth's
server-side user creation API, and assigns Catamorphic memberships through the
real service. It accepts secrets over stdin and never constructs password
hashes or Better Auth rows itself. The image includes Bun and the script, so an
agent operating a container can invoke it with `docker exec`; a source-checkout
agent invokes the same script directly.

The skill owns current PGlite and Postgres discovery, migration, backup,
provisioning, and verification guidance. Any new database backend or breaking
migration updates the skill and its tests in the same change.

Complexity is a product gate: local provisioning may be one auth call plus
membership assignment. It does not grow password-reset delivery, MFA,
administration roles, account-management UI, custom hashing, or another auth
database. If the installed auth library cannot keep this path small, built-in
local auth is removed and the setup skill requires host-provided auth.

## 3. Admission and roles

Signing in creates or resolves a host user but grants no project access by
itself. Project admission modes are host policy:

- invitation only;
- approved identity-provider domain with designated discoverable projects;
- authenticated access request;
- open authenticated join with an explicit default role.

An invitation may assign explicit roles and grants. Domain or open joining
uses the project's configured default role, which an authorized user or setup
agent may later replace. The deployment operator provisions their own initial
user and roles through the same agent-driven path.

Project administration is expressed as ordinary role capabilities rather
than server-owner flags. Membership and role-management permissions stay
separate from builder and document access. Changing protected role policy must
itself require the corresponding role-management permission so ordinary
builders cannot grant it to themselves.

## 4. Browser and protocol entry

Visiting the stock server host presents a lightweight entry surface:

- server identity and configured sign-in methods;
- sign-in for an existing account;
- pending or discoverable projects after authentication;
- desktop download and `Open in desktop` guidance;
- MCP connection guidance.

It does not provide browser project execution in this phase and has no setup
or administration UI.

Desktop authorization uses the system browser and OAuth authorization code
with PKCE. An `Open in desktop` link contains only the server URL and project
id. It never contains an access token. MCP endpoints expose standards-based
protected-resource and authorization-server discovery so compatible clients
can authenticate without copied bearer tokens.

## 5. Project remote binding

The project working copy stores a gitignored, non-secret remote locator with
the server URL, remote project id, display name, and stable connection id.
This survives local database ids, profile changes, and app-data recreation
without leaking credentials into Git or forcing other clones to inherit the
same server address.

Personal access and refresh credentials remain encrypted in profile storage
and are keyed by the stable connection id. Project source metadata and Git
remotes remain separate from the Catamorphic server locator.

The connection state machine distinguishes:

- local only;
- checking;
- connected;
- offline;
- authentication required;
- access revoked;
- remote project missing;
- local changes waiting to sync.

Transient network failure never becomes "disconnected" and never blocks
local work.

## 6. Builder checkout and GitHub

The server advertises whether the caller is a builder and whether the project
has a code-host source. A builder accepting a GitHub-backed project receives a
full clone rather than the scoped document working copy used by non-builders.

The desktop first checks for `gh`, an authenticated account, and access to the
exact repository. It may read the CLI token in the main process and feed it
into the normal GitHub credential store. Repository permission is verified by
the existing `GithubApi`. Cloning, fetching, pushing, and pull requests then
use `GithubService`, `CodeHost`, and the shared git engine.

The desktop never implements a `gh repo clone` or `gh api` branch. When CLI
credentials are absent or insufficient, the same onboarding flow acquires a
credential through GitHub authorization and resumes at the shared permission
check.

## 7. Desktop remote experience

The project selector shows a compact remote status indicator. Its tooltip
summarizes state; clicking opens a Project Connection popover with server,
remote project, signed-in identity, last successful contact, pending sync,
and the action appropriate to the current state.

The palette action adapts to the selected project:

- local-only project: connect to a server;
- locator without credentials: reconnect to the known server/project;
- connected project: open connection details;
- unhealthy connection: retry or sign in again.

Local-agent messages continue when the remote is unavailable and show that
remote mirroring is paused. A genuinely remote operation preserves the user's
draft and offers Retry or Sign in. Background mirror failures become visible
connection state instead of console-only warnings.

## 8. Verification

Each replacement slice deletes the legacy contract it supersedes and ships
focused unit, integration, and end-to-end coverage. Required scenarios include:

- PGlite and Postgres stock auth configuration;
- local username provisioning and login;
- existing-host auth adaptation;
- OAuth PKCE connect and reconnect;
- role and admission enforcement;
- locator recovery after app-data loss;
- offline, revoked, and missing-project states;
- GitHub CLI credential reuse and OAuth fallback through one code path;
- builder clone versus member document checkout;
- MCP OAuth discovery;
- desktop sidebar, popover, message, and retry flows.
