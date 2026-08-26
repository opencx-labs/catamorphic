# Stock server

Use this path only when the repository or deployment actually uses
`apps/server` or the stock image. Inspect its version, `apps/server/AGENTS.md`,
`apps/server/README.md`, Docker configuration, and mounted data directory
before proposing commands.

## Resolve choices from the deployment

1. Identify image/source version, public HTTPS URL, data mount, database mode,
   and model credentials.
2. Inspect configured auth providers. If none are configured, ask whether the
   operator wants Google Workspace, another OAuth/OIDC provider, or local
   username/password. Do not assume local credentials.
3. Inspect existing projects and committed `roles/*.json`. Never invent a role
   name or silently write authorization policy.
4. Confirm how invited members will reach the server: desktop, PWA, MCP, or a
   combination.

## Local agent operation

The running server owns its Better Auth connection and exposes small,
machine-local operator operations for project bootstrap and local user
provisioning on a separate listener bound only to loopback (port 4701 by
default). The public listener does not register these routes. These are
building blocks for an AI setup agent, not a human CLI or product setup flow.

Inspect `apps/server/src/server.ts`, the schemas under
`apps/server/src/setup`, and the running deployment before acting. The setup
agent should:

1. Resolve the desired auth method, explicit project roles, admission policy,
   and first ordinary manager with the user.
2. Read the owner-only operator credential from the mounted data directory or
   deployment secret without displaying it.
3. Invoke the project operation on the dedicated loopback listener with
   explicit committed role definitions and admission policy.
4. If local username/password is selected, invoke the user operation and bind
   that stable auth user to an explicit project role.
5. Verify sign-in, OAuth discovery, project membership, and revocation through
   the normal application paths.

Adapt the transport to the deployment. An agent in a source checkout may call
the loopback operations directly. An agent managing a container must execute a
small request from inside the container because the operator port is not
published. Do not require one shell tool, echo
credentials into history, open PGlite concurrently, hash a password, or
construct Better Auth rows.

Before provisioning, verify that the installed server exposes both its
machine-local operator operations and its intended human sign-in routes.

## Boundaries

- The operational credential proves machine access. It is not a Catamorphic
  user, role, session, invitation, or server owner.
- Local auth does not grow an admin UI, first-run wizard, password reset
  service, MFA system, or
  custom hashing path. If the installed implementation does, stop and simplify.
- Provider configuration belongs to the stock host. Inspect current supported
  provider configuration rather than inventing environment variable names.
- Do not distribute signing or operational secrets and do not print them at
  boot.
