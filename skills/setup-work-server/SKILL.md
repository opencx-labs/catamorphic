---
name: setup-work-server
description: Use when installing or operating a Work server (the prebuilt server image), provisioning its first project and user, company sign-in and deprovisioning, credentials and the connection gateway, connecting Slack, reviewing pull requests on a review pool, enrolling workers or replicas, sharing with customers, embedding Catamorphic in an existing application, mapping host authentication to Catamorphic identity, or configuring Postgres or PGlite.
---

# Setting up a Work server or a Catamorphic host

Catamorphic ships as libraries a host mounts. The Work server (`apps/server`,
published as the `work-server` image with every release) is one such host; a
custom application is another. Adapt
to what is already there: existing auth, users, organizations, databases,
deployment, and code hosts are inputs, not things to replace.

## 1. Inspect before asking

Look at the repository and running deployment for:

- the application and HTTP framework, if any;
- auth middleware, session verification, users, organizations, roles;
- database clients, migrations, storage, deployment manifests;
- whether this is `apps/server`, the `work-server` image, or a custom host;
- how trusted the executed code is, and which clients people will use.

Summarize what is already decided, then ask only what the evidence does not
answer. If auth exists, offer to keep and map it. On the stock server, ask
whether the operator wants an OIDC provider before offering local
username/password.

## Fit the setup to the situation

Start small and add only what the situation needs:

- **One person or a small trusted team:** one Work server with defaults, a
  configured sign-in provider (or local sign-in), and invitations.
- **A company brain:** Google Workspace sign-in with directory
  deprovisioning and groups as roles ([company identity](references/company-identity.md));
  credentials only through the gateway, with guards in a small custom server
  on anything touching production
  ([secrets and the gateway](references/secrets-and-gateway.md));
  a private GitHub App you register for the company from the server, as the
  `github` service connection ([Connect GitHub](references/connect-github.md)),
  with pull request reviews
  on a review pool ([Review pull requests](references/review-pull-requests.md));
  agent sandboxes on enrolled workers with `WORK_CONTROL_PLANE_WORKLOADS=workflow`
  on the control plane ([machines](references/cluster-deployment.md)); and
  shares for customer material ([sharing](references/sharing.md)). Members
  then work from the Work app or from their own agents over the project MCP
  ([working from your own agent](references/members-over-mcp.md)).
- **High availability:** control-plane replicas on shared Postgres, only on
  machines trusted with every secret.

## 2. Read the matching reference

| Situation | Read |
| --- | --- |
| Nothing installed; "a brain on this machine" an MCP client can reach | [A first brain on one machine](references/first-brain.md) |
| Work server image or `apps/server` | [Work server](references/stock-server.md) |
| Company sign-in through Google Workspace, deprovisioning, groups as roles | [Company identity](references/company-identity.md) |
| Credentials, API keys, a production database, query review, vault keys | [Secrets and the gateway](references/secrets-and-gateway.md) |
| GitHub: a GitHub App, company repositories, pull requests, webhooks | [Connect GitHub](references/connect-github.md) |
| Slack: a project answering mentions in threads, reading and searching Slack | [Connect Slack](references/connect-slack.md) |
| Code and security review of every pull request on a dedicated review pool | [Review pull requests with Work](references/review-pull-requests.md) |
| More execution capacity, workers, replicas for availability | [Machines: control plane, replicas, and workers](references/cluster-deployment.md) |
| Sharing documents, folders, or apps with customers behind a sign-in | [Sharing outside the company](references/sharing.md) |
| Members working from Claude Code, Codex, or another MCP client | [Working from your own agent](references/members-over-mcp.md) |
| Project agents that are Claude Code or Codex, running on the server with a model key the gateway holds | [Harnesses on the server](references/harnesses.md) |
| Work server plus company code (a guard or classifier, a directory, a connection provider, seeds, or a route) | [`@catamorphic/work-server`](../../packages/work-server/README.md): extend the published image with hooks; never fork the server |
| Existing or custom application | [Custom host](references/custom-host.md) |
| Sign-in, OIDC, invitations, roles, permissions | [Auth and identity](references/auth-and-identity.md) |
| PGlite, Postgres, migrations, backup | [Database and migrations](references/database-and-migrations.md) |
| Agent self-context, member directory, host tools | [Agent context and capabilities](references/agent-context-and-capabilities.md) |

`INTEGRATION.md` and the package READMEs hold the mechanics. When they
disagree with the installed source, the source wins.

## Rules that always hold

- **Identity comes from the host.** Libraries receive verified identity per
  request and have no default user, organization, or auth provider. The stock
  server's auth choices are not framework contracts.
- **Sign-in identifies; project roles authorize.** Roles are committed files
  in `.work/roles/*.json` granting agents, workflows, apps,
  Environments, connection aliases, documents, and `thing:action` permissions
  such as `program:write`, `sessions:read`, and `memberships:write`
  (ADR 0158). An admin role grants `"*"`. Login alone grants no project, and
  there is no silent default role.
- **No super-admin.** The operator credential is machine access, not a user.
  A setup agent provisions the first ordinary user and membership through the
  server's own operations. Organization administrators manage only the named
  service connections (ADR 0172); they gain nothing inside projects.
- **After setup, configuration is project code.** Roles, agents,
  `.work/sidebar.js`, and `.work/project.json` change through
  ordinary review. Do not create a parallel bootstrap config.
- **Unattended work needs explicit consent.** Each member reviews and enables
  a deployed workflow and authorizes its connections. Project automations
  (`automations:write`) run as the project, not as whoever enabled them
  (ADR 0156).
- **Workflows reach chats with `catamorphic.sessions.deliver`**, by session id
  or by a stable `key`. Clients show `attentionRequired` on the ordinary
  session list and acknowledge on open. Web Push is an optional transport,
  not a second inbox.
- **One remote per project.** Execution targets under it are Environments.
- **Capacity comes from workers, not replicas.** Enrolled workers hold only
  a machine credential (ADR 0164). Control-plane replicas share Postgres and
  every secret; add them only for availability. A member's **This machine**
  execution uses their project connection, never database credentials.
- **Credentials reach systems only through the gateway** (ADR 0162): agents
  and workflows get reviewed actions, never keys. Workflow runs, which receive
  project secrets, stay on the control plane. An administrator enters each
  service credential once; projects bind it by name to an Environment in
  `.work/project.json` (ADR 0172).
- **Isolation matches trust.** Local-process execution is for trusted
  single-tenant use. For remote development use microsandbox with explicit
  budgets; a live heartbeat is not spare capacity.
- **Model keys are connections too.** Claude Code and Codex agents run in
  their sandbox and reach their model through the gateway with the chat's
  grant (ADR 0180); the server's own model variables never reach them.
- **GitHub is a connection.** The organization's GitHub App installation is
  the `github` service connection; sync, proposals, and agents' GitHub
  actions all go through it (ADR 0177). There is no GitHub token variable
  and no second clone or API implementation.
- **Each server has its own private GitHub App.** Register one from the
  server's manifest flow for every company brain you set up, owned by that
  organization. The public Work Desktop App only signs people in on the
  desktop: a shared App's key would reach every organization that installed
  it, and it has one webhook URL.

## Common mistakes

- Replacing working host auth with the stock auth.
- Asking for facts visible in code or deployment files.
- Inventing environment variables, routes, or commands without checking the
  installed version.
- Treating login as project access, or targeting presentation by role name
  instead of resolved permissions.
- Treating one account authorization as consent to enable every workflow.
- Writing Better Auth password hashes or rows directly.
- Printing the operator secret, a password, or a token.
- Turning this guidance into a rigid stack recipe.
