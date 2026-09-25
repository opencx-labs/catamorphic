# Work server

The Work server is the prebuilt server: `apps/server`, published as the
`work-server` image with every release, built on `@catamorphic/work-server`.
Use this only when the deployment actually runs `apps/server` or its image.
Read `apps/server/AGENTS.md`, `apps/server/README.md`, the `Dockerfile`
header, and the mounted data directory before proposing commands. For a first
install from nothing, follow [A first brain on one machine](first-brain.md).
For more than one machine, read [Machines: control plane, replicas, and workers](cluster-deployment.md).

## What it is

One process, zero external services by default: PGlite, bare Git origins,
and local-process execution under one data directory (`/data` in the image).
It is **single-tenant only**: local-process execution gives processes the
host's filesystem and network (ADR 0047). It serves the API at `/api`, sign-in
at `/login`, the mobile PWA at `/`, and `/healthz`.

## Configuration

Environment variables parsed by `workServerConfigFromEnv` in
`packages/work-server/src/config.ts` (verify against the installed version):

| Variable | Purpose |
| --- | --- |
| `PORT` | Public listener (default 4700). |
| `WORK_DATA_DIR` | Data directory (default `/data`). Back up all of it. |
| `WORK_PUBLIC_URL` | Public origin for OAuth, invitations, and webhook URLs. Must be HTTPS unless loopback. |
| `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `OPENROUTER_API_KEY` | Model for the built-in agent. `WORK_MODEL`, `WORK_EFFORT` tune it. `WORK_FAKE_AGENT=1` runs a deterministic echo agent. |
| `WORK_AUTH_CONFIG` | Path to the auth config (default `<data>/auth-config.json`). |
| `WORK_OPERATOR_PORT` | Loopback-only setup listener (default 4701). |
| `WORK_OPERATOR_SECRET` | Supplies the operator credential instead of the generated `<data>/operator-secret`. |
| `WORK_MDNS` | `off`, or a hostname (default a unique `work-<id>.local`). |
| `DATABASE_URL` | Network Postgres instead of PGlite; then `WORK_SECRET`, `WORK_VAULT_KEY`, and a public URL are required. |
| `WORK_SECRET` | Deployment secret for sign-in state. Generated under the data directory when absent (PGlite only). |
| `WORK_VAULT_KEY`, `WORK_VAULT_PREVIOUS_KEYS` | Credential vault keys (32 bytes, base64); see [secrets and the gateway](secrets-and-gateway.md). |
| `WORK_GITHUB_CLIENT_ID`, `WORK_GITHUB_TOKEN` | Service account for GitHub-backed projects. |
| `WORK_GATEWAY_CONFIG` | Connections (MCP, HTTP APIs, databases) and the guards that review them; see [secrets and the gateway](secrets-and-gateway.md). |
| `WORK_SANDBOX` and budget variables | `local-process` (default) or `microsandbox`; see the machines reference. |
| `WORK_MACHINE_NAME`, `WORK_MACHINE_LABELS` | This machine's name and labels (`pool=agents,class=large`) that Environment pools select; see the machines reference. |
| `WORK_CONTROL_PLANE_WORKLOADS` | What the server runs itself: `agent,workflow` (default), `workflow`, or empty. Agents then run on enrolled workers. |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | Telemetry export (`OBSERVABILITY.md`). |

### Sign-in methods

The auth config is JSON. Local username/password is on unless disabled;
OIDC providers are listed explicitly. For a company, use the
`google-workspace` kind described in [company identity](company-identity.md);
providers with `"audience": "guests"` sign customers in to shares only
([sharing](sharing.md)). A generic provider:

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
`<WORK_PUBLIC_URL>/api/auth/oauth2/callback/<id>`. `scopes` defaults to
`openid email profile`. Keep client secrets out of the repository.

## Provisioning the first project and person

The server exposes machine-local operations on a separate listener bound to
`127.0.0.1` (port 4701). The public listener never registers them, and the
image does not publish that port. They are building blocks for a setup agent,
not a human CLI.

1. Settle with the person: sign-in method, explicit role definitions,
   admission policy, and the first ordinary member.
2. Read the operator credential without displaying it.
3. `POST /_work/operator/projects` with `name`, `roles`
   (`[{ slug, definition }]`), `admission` (`mode`: `invitation_only`,
   `approved_domain`, `request`, or `open`; `defaultRole`;
   `approvedDomains`), and optionally `githubRepository: "owner/repo"`.
4. For local sign-in, `POST /_work/operator/users` with `username`,
   `name`, `password`, optional `email`, and `memberships`
   (`[{ projectId, roles, grants? }]`).
5. Verify sign-in, OAuth discovery, membership, and revocation through the
   normal application paths.

Schemas live in `packages/work-server/src/setup/`. With company sign-in and
no local passwords, map an administrators directory group to the managing role
in `admission.directoryRoles`, or grant a signed-in person by email with
`POST /_work/operator/memberships` (`{ email, projectId, roles }`). Inside a container, run the request
from inside it (`docker exec ... bun -e` with `fetch`; the image has no curl).
Never echo credentials into history, open PGlite from a second process, hash
a password, or write Better Auth rows.

Grant execution as well as agents: a role needs `environments: ["default"]`
(the Environment every project has) to run agents and workflows. Permissions
alone grant no execution. A member-device target needs an Environment with
`device: "member"`, a
role grant for it, and a connected desktop. Never describe server-side output
as a file saved on the member's device.

## Clients and invitations

A credential-free invitation is the onboarding object. Members with
`memberships:write` create them with
`POST /api/projects/:projectId/admission/invitations`. Desktop and PWA
clients discover OAuth, sign in with PKCE, and redeem it. MCP clients use the
same protected-resource discovery against
`/api/projects/:projectId/mcp` and get the member's whole working loop there
([working from your own agent](members-over-mcp.md)). Do not mint separate
tokens.

## GitHub-backed projects

Use a service account distinct from human reviewers and never give its token
to members. Provisioning with `githubRepository` imports the source and
pushes the role files. The server syncs the linked repository every minute,
so merged PRs reach members through their normal download. If sync fails,
preserve both histories and resolve; never force-push one over the other.

## Webhooks and project automations

The stock server receives webhooks and runs project automations while nobody
is signed in (ADR 0156). Set `WORK_PUBLIC_URL` to an origin senders can
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
