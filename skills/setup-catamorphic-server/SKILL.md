---
name: setup-catamorphic-server
description: Use when installing the stock Catamorphic server, embedding Catamorphic in an existing application, connecting host authentication and identity, configuring Postgres or PGlite, or provisioning initial users and project access.
---

# Setting Up Catamorphic

## Core principle

Adapt Catamorphic to the application that is actually present. Inspect before
asking questions or choosing infrastructure. Existing auth, users,
organizations, databases, deployment, code hosts, and design systems are
inputs, not obstacles to replace.

## Start with evidence

Inspect the repository and runtime for:

- an existing application and HTTP framework;
- auth middleware, session verification, users, organizations, and roles;
- database clients, migrations, storage, and deployment manifests;
- whether this is `apps/server`, a stock image, or a custom host;
- execution trust, code-host integration, and user-facing surfaces.

Summarize what is already decided. Ask only about choices the visible setup
does not answer. If auth exists, first offer to preserve and map it. For the
stock server, ask whether the operator wants a configured provider before
offering local username/password.

## Route to the relevant reference

| Observed need | Read |
| --- | --- |
| Stock image or `apps/server` | [Stock server](references/stock-server.md) |
| Existing or custom application | [Custom host](references/custom-host.md) |
| Sessions, OAuth/OIDC, users, invitations, roles | [Auth and identity](references/auth-and-identity.md) |
| PGlite, Postgres, migrations, backup | [Database and migrations](references/database-and-migrations.md) |

Read `INTEGRATION.md` and the relevant package READMEs for mechanics. Read the
current source when documentation and the installed version differ.

## Invariants

- Catamorphic libraries receive verified host identity per request. They do
  not own a default user, organization, or authentication provider.
- The stock server is one host implementation. Its auth choices do not become
  framework contracts.
- Authentication identifies a person. Committed project roles and
  memberships authorize them.
- A deployment operator is not a server-owner or super-admin user.
- A project has at most one Catamorphic remote. Execution targets beneath it
  are Environments.
- Keep one behavioral path after credentials are acquired. For example, a
  GitHub CLI token may feed the regular GitHub service; it does not create a
  second `gh api` or clone implementation.

## Common mistakes

- Replacing working host auth with stock auth.
- Asking the user to repeat facts visible in code or deployment files.
- Inventing provider environment variables, routes, or commands without
  checking the installed version.
- Treating login as project access or assigning a silent default role.
- Writing Better Auth password hashes or rows directly.
- Turning setup guidance into a rigid stack recipe.
