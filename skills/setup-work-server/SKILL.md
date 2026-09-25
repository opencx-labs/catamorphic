---
name: setup-work-server
description: Use when installing or configuring a Work server (the prebuilt self-hosted server image), adding machines or execution Environments, setting up a shared-Postgres cluster or multiple server instances, embedding Catamorphic in an existing application, connecting host authentication and identity, configuring Postgres or PGlite, or provisioning initial users and project access.
---

# Setting Up a Work Server or a Catamorphic Host

## Core principle

The Work server is the prebuilt host: one image, configured through
environment variables and project files. A custom host embeds the Catamorphic
libraries in an existing application. Adapt to the application that is
actually present. Inspect before
asking questions or choosing infrastructure. Existing auth, users,
organizations, databases, deployment, code hosts, and design systems are
inputs, not obstacles to replace.

## Start with evidence

Inspect the repository and runtime for:

- an existing application and HTTP framework;
- auth middleware, session verification, users, organizations, and roles;
- database clients, migrations, storage, and deployment manifests;
- whether this is `apps/server`, the published Work server image, or a custom
  host;
- execution trust, code-host integration, and user-facing surfaces.

Summarize what is already decided. Ask only about choices the visible setup
does not answer. If auth exists, first offer to preserve and map it. For the
stock server, ask whether the operator wants a configured provider before
offering local username/password.

## Route to the relevant reference

| Observed need | Read |
| --- | --- |
| Nothing installed yet; "a brain on this machine" that an MCP client can reach | [A first brain on one machine](references/first-brain.md) |
| Work server image or `apps/server` | [Work server](references/stock-server.md) |
| More execution capacity, workers, replicas for availability | [Machines: control plane, replicas, and workers](references/cluster-deployment.md) |
| Work server plus company code (a custom sign-in, classifier, connection provider, or route) | [`@catamorphic/work-server`](../../packages/work-server/README.md): extend the published image with hooks; never fork the server |
| Existing or custom application with its own auth and database | [Custom host](references/custom-host.md) |
| Sessions, OAuth/OIDC, users, invitations, roles | [Auth and identity](references/auth-and-identity.md) |
| Company sign-in through Google Workspace, deprovisioning, directory groups as roles | [Company identity](references/company-identity.md) |
| Credentials, API keys, a production database, query review, vault keys | [Secrets and the gateway](references/secrets-and-gateway.md) |
| Sharing documents, folders, or apps with customers behind a sign-in | [Sharing outside the company](references/sharing.md) |
| PGlite, Postgres, migrations, backup | [Database and migrations](references/database-and-migrations.md) |

## Fit the setup to the situation

Start small and add only what the situation needs:

- **One person or a small trusted team:** one Work server with defaults, a
  configured sign-in provider (or local sign-in), and invitations.
- **A company brain:** Google Workspace sign-in with directory
  deprovisioning and groups as roles ([company identity](references/company-identity.md));
  credentials only through the gateway, with guards on anything touching
  production ([secrets and the gateway](references/secrets-and-gateway.md));
  agent sandboxes on enrolled workers, with `WORK_CONTROL_PLANE_WORKLOADS=workflow`
  on the control plane ([machines](references/cluster-deployment.md)); and
  shares for customer material ([sharing](references/sharing.md)).
- **High availability:** control-plane replicas on shared Postgres, only for
  machines trusted with every secret.

Read `INTEGRATION.md` and the relevant package READMEs for mechanics. Read the
current source when documentation and the installed version differ.

## Invariants

- Catamorphic libraries receive verified host identity per request. They do
  not own a default user, organization, or authentication provider.
- The Work server is one host implementation. Its auth choices do not become
  framework contracts.
- Authentication identifies a person. Committed project roles and
  memberships authorize them.
- Roles grant provider-neutral workflow, project-agent, Environment, and
  connection references, document paths, and project permissions.
  Catamorphic enforces `thing:action` names such as `program:write`,
  `sessions:read`, and `memberships:write` (ADR 0158); an admin role grants
  `"*"` for agents, workflows, apps, environments, and permissions. Host-specific
  permissions remain inert unless that host or its UI explicitly interprets
  them. Each member separately enables unattended workflows after reviewing
  the deployed commit and authenticating every required member connection.
  Never make this Google Workspace-specific.
- MCP authorization is sufficient for a workflow or project agent when its
  server exposes the declared connection actions. Configure providers through
  the host-injected connection registry and credential vault.
- A member-owned workflow may call `catamorphic.sessions.wake` to create or
  reuse a stable agent session and request attention after the turn settles.
  Clients poll the ordinary session list, pulse rows with
  `attentionRequired`, and acknowledge on open. Web Push is an optional
  transport to that session, not a second notification inbox.
- A deployment operator is not a server-owner or super-admin user.
- A project has at most one Catamorphic remote. Execution targets beneath it
  are Environments.
- Add execution capacity with enrolled workers, which hold only their own
  machine credential (ADR 0164). Control-plane replicas share Postgres and
  every secret; add them only for availability, never for capacity. A
  member's **This machine** execution uses their authenticated project
  connection, not database access. Setting `DATABASE_URL` alone does not
  establish a working cluster.
- Credentials reach systems only through the gateway (ADR 0162): agents and
  workflows get reviewed actions, never keys. Workflow runs, which receive
  project secrets, stay on the control plane.
- For remote development, configure microsandbox and explicit machine resource
  budgets. Agent Environment requirements become sandbox limits. Read the cluster
  reference for capacity inventory, workspace retirement, and uncertain cleanup
  recovery; do not treat a live heartbeat as spare capacity.
- Initial machine provisioning is an operator operation. Ongoing role, agent,
  sidebar, and starting-action configuration belongs in normal reviewed
  project files; do not create a parallel stock-server bootstrap config.
- Keep one behavioral path after credentials are acquired. For example, a
  GitHub CLI token may feed the regular GitHub service; it does not create a
  second `gh api` or clone implementation.

## Common mistakes

- Replacing working host auth with stock auth.
- Asking the user to repeat facts visible in code or deployment files.
- Inventing provider environment variables, routes, or commands without
  checking the installed version.
- Treating login as project access or assigning a silent default role.
- Treating account authentication as consent to enable every compatible
  workflow, or reaching one member's personal chat from a project automation
  without naming that member.
- Targeting project presentation by role slug instead of resolved
  permissions.
- Writing Better Auth password hashes or rows directly.
- Turning setup guidance into a rigid stack recipe.

For agent self-context, permitted people/assignment inspection, and deferred host
tools, read [references/agent-context-and-capabilities.md](references/agent-context-and-capabilities.md).
