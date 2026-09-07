# Catamorphic stock server

## Machines and execution Environments

The accepted managed deployment model uses multiple Catamorphic server instances
sharing one authority and network Postgres. Operators enroll machines; project
roles and agent policy determine which Environments members may use. The
desktop's **This machine** option uses the member's project connection and does
not require direct database access. PGlite remains available for standalone use.

Postgres mode shares origin objects, bundles, encrypted vault records, auth,
approvals, and worker leases. Each machine owns its runtime and local caches.
Configure a common public origin and deployment secret before enrollment. See
[ADR 0099](../../docs/decisions/0099-shared-postgres-server-environments.md) and
the [setup reference](../../skills/setup-catamorphic-server/references/cluster-deployment.md)
for enrollment, session recovery, and required verification.

## Authentication setup

Use [`../../skills/setup-catamorphic-server/SKILL.md`](../../skills/setup-catamorphic-server/SKILL.md)
for agent-guided stock setup or custom-host embedding. The guidance first
inspects existing auth and deployment. The stock host uses Better Auth; a
custom host keeps its own verified session model.

The built-in local fallback is provisioned through the running server, never
by writing auth rows. A setup agent inspects the schemas in `src/setup` and
uses the machine-local operator operations in `src/server.ts` to create the
project, commit explicit roles, configure admission, and create an ordinary
local user when requested. There is no human setup command or first-run UI.
The owner-only operational credential under `CATAMORPHIC_DATA_DIR` is machine
authority, not a Catamorphic identity or super-admin account.

After initial provisioning, the company brain is configured through its
ordinary reviewed project files. `roles/*.json` grants artifacts,
Environments, connection aliases, document paths, and namespaced permissions;
`agents/*` defines the project agents; `.catamorphic/sidebar.js` and
`.catamorphic/project.json` can shape the desktop sidebar and starting actions
from resolved builder state and permissions. There is no parallel stock-server
bootstrap config.

Invitations are credential-free project locators. Desktop, PWA, and MCP clients
discover the server's OAuth endpoints, sign in as the same user, and redeem the
same admission policy. Access tokens identify the person and carry no role or
project grant. Each request resolves current membership, so revocation and role
changes apply immediately.

Workflow access is not unattended-run consent. Members preview and enable an
exact deployed workflow with its trigger, Environment, agent, and connection
requirements. Account authorization can finish that selected flow but never
enables every compatible workflow automatically.

## Credential vault and provider setup

Standalone PGlite installs create an AES-256-GCM credential vault under
`CATAMORPHIC_DATA_DIR/credentials`, with owner-only key and record permissions.
Postgres installs store encrypted records in shared object storage and derive the
vault key from `BETTER_AUTH_SECRET`. Back up the database and protect the key
separately. Losing the key makes provider connections unrecoverable.

Rotate a service credential with the authenticated
`PUT /connections/:connectionId/credential` endpoint. Rotation writes a new
encrypted record, atomically advances the connection revision, deletes the old
record, and wakes workflow calls parked on that connection. Keep old vault
wrapping keys available until all stored records have been re-encrypted.

Provider drivers and OAuth application details are deployment configuration.
The stock image does not ship a shared Slack or Google OAuth identity. Register
your own provider applications, configure their HTTPS callback URLs, and inject
their connection providers when embedding `buildStockServer`. Service accounts
are explicit project or tenant service connections and are never inferred from
a member login. Unattended workflows use the connections authorized by their
explicit enablement, including member connections for member-owned enablements.

## Remote development resources

Choose `CATAMORPHIC_SANDBOX=microsandbox` for per-agent CPU/memory isolation and
configure each server's workspace budget. Full servers reject new allocations;
idle development workspaces retain their reservation until archived or closed.
See the [capacity and recovery setup](../../skills/setup-catamorphic-server/references/cluster-deployment.md#capacity-and-isolated-development)
for configuration, agent requirements, machine inventory, and cleanup recovery.
