# Work server

The prebuilt, self-hostable Work server (ADRs 0059, 0159), built on the
Catamorphic libraries. Every release publishes it as the multi-architecture
`work-server` image in the GitHub Container Registry, tagged with the release
version, `alpha` (every release), and `latest` (Stable releases), with a signed
build provenance attestation. Configuration variables use the `WORK_` prefix;
`WORK_SECRET` is the deployment secret. Build it locally with
`docker build -f apps/server/Dockerfile -t work-server .` from the repository
root. The image runs as an unprivileged user and keeps everything under `/data`.

The server is the `@catamorphic/work-server` package
([README](../../packages/work-server/README.md)); this app is the image's
process. A company that needs custom code extends the image with a small
server file that calls `createWorkServer` with its own hooks.

GitHub is an ordinary connection (ADR 0177). An organization administrator
connects a GitHub App installation as the `github` service connection, or the
operator registers a new App from a manifest
(`POST /_work/operator/github/app` on the loopback listener, then a one-time
browser link on the public URL). Sync, proposals, and agents' GitHub actions
use that connection with tokens minted per call; members never receive one.
See the setup skill's
[Connect GitHub](../../skills/setup-work-server/references/connect-github.md).

The machine-local project setup operation accepts `repository` as
`owner/repository` alongside the explicit roles and admission policy. It
attaches that repository through the `github` service connection and
proposes the requested role definitions when the repository has none. Ongoing source
changes use ordinary proposals and repository review. Members can list and read
proposals through their company sign-in only when their document scope permits
every changed path, including the old path of renamed files.

## Machines and execution Environments

One server is a complete brain. To add execution capacity, enroll workers: the
same image started as `bun apps/server/src/worker.ts`, holding only a machine
credential exchanged once for an operator's single-use enrollment code. Workers
dial out to the control plane over HTTPS and run agent sandboxes; workflow runs
and every credential stay on the control plane. For availability, run
control-plane replicas on shared Postgres with the same `WORK_SECRET`,
`WORK_VAULT_KEY`, `WORK_OPERATOR_SECRET`, public origin, and sign-in and
gateway configuration. Replicas are disposable (ADR 0190): each start is a new
machine, a stopped or lost replica's workflow runs and chats move to the
others, `/readyz` answers 503 while its lease is not renewing, and
`/healthz` answers 503 once its lease is lost for good.
`WORK_CONTROL_PLANE_WORKLOADS=workflow` keeps agent code off the control plane.
Each worker takes work for everyone or for named people and directory groups,
so a person's agents run on their own machine first; machine rules and a
provisioner hook give every member of a group a machine of their own (ADR 0167).
See [ADR 0164](../../docs/decisions/0164-control-plane-and-enrolled-workers.md)
and the [machines reference](../../skills/setup-work-server/references/cluster-deployment.md).

## First brain

For the shortest path from nothing to a running brain an MCP client can
connect to (build, run, provision a project and a person, connect), follow
[`../../skills/setup-work-server/references/first-brain.md`](../../skills/setup-work-server/references/first-brain.md).

## Authentication setup

Company deployments sign in through Google Workspace with directory-backed
deprovisioning (ADR 0161): only accounts in the configured Workspace domains
sign in, suspended or departed accounts lose every session within one five
minute sweep, access tokens last 15 minutes, refresh tokens rotate with reuse
detection, and directory groups can grant project roles. See
[company identity](../../skills/setup-work-server/references/company-identity.md).

Use [`../../skills/setup-work-server/SKILL.md`](../../skills/setup-work-server/SKILL.md)
for agent-guided stock setup or custom-host embedding. The guidance first
inspects existing auth and deployment. The stock host uses Better Auth; a
custom host keeps its own verified session model.

The built-in local fallback is provisioned through the running server, never
by writing auth rows. A setup agent inspects the schemas in
`packages/work-server/src/setup` and uses the machine-local operator operations
in `packages/work-server/src/server.ts` to create the
project, commit explicit roles, configure admission, and create an ordinary
local user when requested. There is no human setup command or first-run UI.
The owner-only operational credential under `WORK_DATA_DIR` is machine
authority, not a Catamorphic identity or super-admin account.

After initial provisioning, the company brain is configured through its
ordinary reviewed project files. `.work/roles/*.json` grants artifacts,
Environments, connection aliases, document paths, and namespaced permissions;
`.work/agents/*` defines the project agents (the built-in agent, or Claude
Code and Codex running in their sandbox with a model connection, ADR 0180);
`.work/workspace.js` and
`.work/project.json` can shape the desktop sidebar and starting actions
from resolved permissions. There is no parallel stock-server
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
`WORK_DATA_DIR/credentials`, with owner-only key and record permissions.
Postgres installs store encrypted records in shared object storage under
`WORK_VAULT_KEY`, a separate secret from `WORK_SECRET` (ADR 0162);
`WORK_VAULT_PREVIOUS_KEYS` keeps older keys readable during a rotation. Back up
the database and protect the key separately. Losing the key makes provider
connections and project secrets unrecoverable. Project secrets are sealed in
the same vault; their database rows hold only references.

Agents and workflows reach company systems through the connection gateway:
`WORK_GATEWAY_CONFIG` declares MCP endpoints, HTTP APIs, Git hosts, model APIs,
and read-only database connections. The image ships no guards: a company that
wants each action reviewed (a model classifier, a required approval) adds a
guard in a small custom server with `@catamorphic/work-server` (ADR 0183). See
[secrets and the gateway](../../skills/setup-work-server/references/secrets-and-gateway.md).

Service connections are named and administered (ADR 0172). Organization
administrators (made by the operator with `POST /_work/operator/users`
`"administrator": true` or `POST /_work/operator/administrators`, then by each
other from the app) create them with `POST /api/service-connections`,
authorize them through the provider's own challenge with
`POST /api/service-connections/:id/authorize` (form fields complete with
`POST /api/connection-authorizations/complete`; OAuth returns to
`/api/connection-authorizations/callback`), rotate them by authorizing again,
and revoke them with `DELETE /api/connections/:id`. The loopback operator
listener offers the same operations under `/_work/operator/service-connections`.
Rotation writes a new encrypted record, advances the connection revision,
closes pooled sessions of the old credential, deletes the old record, and
wakes workflow calls parked on that connection. Keep old vault wrapping keys
available until all stored records have been re-encrypted.

Projects commit which Environment may use which named connection in
`.work/project.json` (`environments.<name>.connections`); there is no binding
API. Members see an Environment's aliases and authorize their own accounts at
`/api/projects/:id/environments/:environment/connections`.

Provider drivers and OAuth application details are deployment configuration.
The stock image does not ship a shared Slack or Google OAuth identity. Register
your own provider applications (an `mcp` gateway entry takes a pre-registered
`oauth.client`), configure their HTTPS callback URLs, and inject further
connection providers with the `connectionProviders` hook. Service accounts
are explicit project or tenant service connections and are never inferred from
a member login. Unattended workflows use the connections authorized by their
explicit enablement, including member connections for member-owned enablements.
Project enablements use only project and tenant service connections.

Workflows can start from webhooks: `trigger("webhook", { name })` gives each
name a public URL under `WORK_PUBLIC_URL` (`/api/hooks/...`), shown to
holders of `webhooks:read` in the workflow's **Automatic** view, with a replace
control for holders of `webhooks:write`. The binding declares how senders are
checked (`verify`: a signature scheme or shared token) and which handshakes are
answered (`respond`); projects usually declare an integration's webhook once as
a trigger kind in `.work/triggers/` (ADR 0171). Bodies are capped at 1 MiB per
endpoint unless a binding asks for more, up to `WORK_WEBHOOK_MAX_BYTES`.

## Sharing with customers

Shares (ADR 0165) give people outside the company a sign-in link to one
document, folder, or app. They sign in through a guest provider (for example
your product's own accounts over OIDC) and see only what was addressed to
their email or domain; guests never become members or receive API tokens.
Members with `publications:write` manage shares under
`/api/projects/:projectId/shares`. See
[sharing outside the company](../../skills/setup-work-server/references/sharing.md).

## Remote development resources

Choose `WORK_SANDBOX=microsandbox` for per-agent CPU/memory isolation and
configure each server's workspace budget. Full servers reject new allocations;
idle development workspaces retain their reservation until archived or closed.
See the [capacity and recovery setup](../../skills/setup-work-server/references/cluster-deployment.md#capacity-and-isolated-development)
for configuration, agent requirements, machine inventory, and cleanup recovery.

Agent context and deferred capabilities are documented in
[AGENT-CAPABILITIES.md](../../AGENT-CAPABILITIES.md). The stock host supplies the
current user's display name and a paginated project-member directory for ordinary
membership managers. `StockServerOptions.agentCapabilities` customizes profiles,
capabilities, approvals, and activity reporting; host access remains authoritative.

## Observability

Configure `OTEL_EXPORTER_OTLP_ENDPOINT` to export traces, metrics, and logs.
Standard OTEL variables select protocols, headers, sampling, and signal-specific
settings. `OTEL_SDK_DISABLED=true` disables export. See
[OBSERVABILITY.md](../../OBSERVABILITY.md) for examples and coverage.
