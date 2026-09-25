---
name: setup-catamorphic-server
description: Use when installing or operating the stock Catamorphic server, provisioning its first project and user, adding machines or execution Environments, running several instances on shared Postgres, embedding Catamorphic in an existing application, mapping host authentication to Catamorphic identity, or configuring Postgres or PGlite.
---

# Setting up Catamorphic

Catamorphic ships as libraries a host mounts. The stock server (`apps/server`,
also a Docker image) is one such host; a custom application is another. Adapt
to what is already there: existing auth, users, organizations, databases,
deployment, and code hosts are inputs, not things to replace.

## 1. Inspect before asking

Look at the repository and running deployment for:

- the application and HTTP framework, if any;
- auth middleware, session verification, users, organizations, roles;
- database clients, migrations, storage, deployment manifests;
- whether this is `apps/server`, the stock image, or a custom host;
- how trusted the executed code is, and which clients people will use.

Summarize what is already decided, then ask only what the evidence does not
answer. If auth exists, offer to keep and map it. On the stock server, ask
whether the operator wants an OIDC provider before offering local
username/password.

## 2. Read the matching reference

| Situation | Read |
| --- | --- |
| Nothing installed; "a brain on this machine" an MCP client can reach | [A first brain on one machine](references/first-brain.md) |
| Stock image or `apps/server` | [Stock server](references/stock-server.md) |
| Another machine, Environment enrollment, several instances | [Managed machines and clusters](references/cluster-deployment.md) |
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
  in `.catamorphic/roles/*.json` granting agents, workflows, apps,
  Environments, connection aliases, documents, and `thing:action` permissions
  such as `program:write`, `sessions:read`, and `memberships:write`
  (ADR 0158). An admin role grants `"*"`. Login alone grants no project, and
  there is no silent default role.
- **No super-admin.** The operator credential is machine access, not a user.
  A setup agent provisions the first ordinary user and membership through the
  server's own operations.
- **After setup, configuration is project code.** Roles, agents,
  `.catamorphic/sidebar.js`, and `.catamorphic/project.json` change through
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
- **Several machines share one brain** through network Postgres and shared
  storage. Setting `DATABASE_URL` alone is not a working cluster. A member's
  **This machine** execution uses their project connection, never database
  credentials.
- **Isolation matches trust.** Local-process execution is for trusted
  single-tenant use. For remote development use microsandbox with explicit
  budgets; a live heartbeat is not spare capacity.
- **One code path after credentials.** A GitHub CLI token may feed the regular
  GitHub service; it does not justify a second clone or API implementation.

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
