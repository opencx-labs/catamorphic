# Stock server

Use this only when the deployment actually runs `apps/server` or its image.
Read `apps/server/AGENTS.md`, `apps/server/README.md`, the `Dockerfile`
header, and the mounted data directory before proposing commands. For a first
install from nothing, follow [A first brain on one machine](first-brain.md).
For more than one machine, read [Managed machines and clusters](cluster-deployment.md).

## What it is

One process, zero external services by default: PGlite, bare Git origins,
and local-process execution under one data directory (`/data` in the image).
It is **single-tenant only**: local-process execution gives processes the
host's filesystem and network (ADR 0047). It serves the API at `/api`, sign-in
at `/login`, the mobile PWA at `/`, and `/healthz`.

## Configuration

Environment variables read by `apps/server/src` (verify against the installed
version):

| Variable | Purpose |
| --- | --- |
| `PORT` | Public listener (default 4700). |
| `CATAMORPHIC_DATA_DIR` | Data directory (default `/data`). Back up all of it. |
| `CATAMORPHIC_PUBLIC_URL` | Public origin for OAuth, invitations, and webhook URLs. Must be HTTPS unless loopback. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | Model for the built-in agent. `CATAMORPHIC_MODEL`, `CATAMORPHIC_EFFORT` tune it. `CATAMORPHIC_FAKE_AGENT=1` runs a deterministic echo agent. |
| `CATAMORPHIC_AUTH_CONFIG` | Path to the auth config (default `<data>/auth-config.json`). |
| `CATAMORPHIC_OPERATOR_PORT` | Loopback-only setup listener (default 4701). |
| `CATAMORPHIC_OPERATOR_SECRET` | Supplies the operator credential instead of the generated `<data>/operator-secret`. |
| `CATAMORPHIC_MDNS` | `off`, or a hostname (default a unique `catamorphic-<id>.local`). |
| `DATABASE_URL` | Network Postgres instead of PGlite; then `BETTER_AUTH_SECRET` and a public URL are required. |
| `CATAMORPHIC_GITHUB_CLIENT_ID`, `CATAMORPHIC_GITHUB_TOKEN` | Service account for GitHub-backed projects. |
| `CATAMORPHIC_CONNECTION_PROVIDERS_CONFIG` | JSON list of MCP connection providers (see the cluster reference). |
| `CATAMORPHIC_SANDBOX` and budget variables | `local-process` (default) or `microsandbox`; see the cluster reference. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Telemetry export (`OBSERVABILITY.md`). |

### Sign-in methods

The auth config is JSON. Local username/password is on unless disabled;
OIDC providers are listed explicitly:

```json
{
  "local": { "enabled": false },
  "providers": [
    {
      "id": "google",
      "label": "Google",
      "discoveryUrl": "https://accounts.google.com/.well-known/openid-configuration",
      "clientId": "...",
      "clientSecret": "...",
      "allowedDomains": ["example.com"]
    }
  ]
}
```

Register the provider's redirect URI as
`<CATAMORPHIC_PUBLIC_URL>/api/auth/oauth2/callback/<id>`. `scopes` defaults to
`openid email profile`. Keep client secrets out of the repository.

## Provisioning the first project and person

The server exposes machine-local operations on a separate listener bound to
`127.0.0.1` (port 4701). The public listener never registers them, and the
image does not publish that port. They are building blocks for a setup agent,
not a human CLI.

1. Settle with the person: sign-in method, explicit role definitions,
   admission policy, and the first ordinary member.
2. Read the operator credential without displaying it.
3. `POST /_catamorphic/operator/projects` with `name`, `roles`
   (`[{ slug, definition }]`), `admission` (`mode`: `invitation_only`,
   `approved_domain`, `request`, or `open`; `defaultRole`;
   `approvedDomains`), and optionally `githubRepository: "owner/repo"`.
4. For local sign-in, `POST /_catamorphic/operator/users` with `username`,
   `name`, `password`, optional `email`, and `memberships`
   (`[{ projectId, roles, grants? }]`).
5. Verify sign-in, OAuth discovery, membership, and revocation through the
   normal application paths.

Schemas live in `apps/server/src/setup/`. Inside a container, run the request
from inside it (`docker exec ... bun -e` with `fetch`; the image has no curl).
Never echo credentials into history, open PGlite from a second process, hash
a password, or write Better Auth rows.

Grant execution as well as agents: a role needs `environments: ["local"]` to
run agents on the server itself. Permissions alone grant no execution. A
member-device target needs an Environment with `binding: "this-machine"`, a
role grant for it, and a connected desktop. Never describe server-side output
as a file saved on the member's device.

## Clients and invitations

A credential-free invitation is the onboarding object. Members with
`memberships:write` create them with
`POST /api/projects/:projectId/admission/invitations`. Desktop and PWA
clients discover OAuth, sign in with PKCE, and redeem it. MCP clients use the
same protected-resource discovery against
`/api/projects/:projectId/mcp`. Do not mint separate tokens.

## GitHub-backed projects

Use a service account distinct from human reviewers and never give its token
to members. Provisioning with `githubRepository` imports the source and
pushes the role files. The server syncs the linked repository every minute,
so merged PRs reach members through their normal download. If sync fails,
preserve both histories and resolve; never force-push one over the other.

## Webhooks and project automations

The stock server receives webhooks and runs project automations while nobody
is signed in (ADR 0156). Set `CATAMORPHIC_PUBLIC_URL` to an origin senders can
reach; webhook URLs are `/api/hooks/<projectId>/<name>/<token>` under it.
Someone with `automations:write` plus every permission the workflow declares
enables it for the project; holders of `webhooks:read` copy its URL from the
workflow's **Automatic** view, and `webhooks:write` rotates it. Signed senders
use a project secret named in the trigger's `verify`. Requests are answered
202 once stored; failures show in the workflow's runs.

## Boundaries

- The operator credential proves machine access. It is not a user, role,
  session, or invitation.
- Local auth does not grow an admin UI, first-run wizard, password reset, MFA,
  or custom hashing. If the installed version has one, stop and simplify.
- Never expose the setup port, distribute signing secrets, or print them.
