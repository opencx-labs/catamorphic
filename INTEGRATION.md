# Catamorphic Integration Guide

Catamorphic is an **embeddable framework for agentic work environments**. A host mounts it in-process and gets the whole environment: general-purpose projects (git repos that hold docs, data, code, automations, and apps — ADR 0043), git-native work tracking (per-turn checkpoint commits, remote sync, the CodeHost seam — ADR 0044), multi-harness coding agents with durable sessions (ADR 0038), durable TypeScript workflows, sandboxed user-built apps (ADRs 0035–0037), and hooks that make the result look and behave like the *host's* product (ADRs 0048–0049). Workflows are one capability among these, not the frame.

A host application runs catamorphic services in-process against its own Postgres instance: all catamorphic tables live in one schema (default: `catamorphic`). Three integration surfaces are available, in increasing order of coupling:

1. **`@catamorphic/db` only**: run the migrations, let the host join against `catamorphic.projects` / `catamorphic.workflow_runs`. Read-only relationship. Useful for reporting / BI.
2. **`@catamorphic/server-sdk` (library-direct, recommended)**: host imports `createCatamorphic(...)` and calls resources in-process. Identity is bound per request via `cat.forTenant({ tenantId }).forUser({ externalUserId })`. No sidecar process.
3. **`@catamorphic/fastify-plugin` + `@catamorphic/api-client`**: host registers the Fastify plugin on its own server (or runs `createApp` as a sidecar) and frontends talk to it over HTTP. Same backing services; required for the React UI, and useful when the host is non-Node or wants a network boundary.

Most hosts use 2 + 3 together: the server-sdk boots the core once, the fastify plugin exposes it to the frontend.

## Host shapes: Catamorphic runs wherever TypeScript runs

Do not assume the host is a multi-tenant SaaS server. Every infrastructure
dependency is an axis with a lightweight end, and the combinations are all
supported: **Catamorphic Desktop is the existence proof for the lightest
column**: it embeds this same framework inside an Electron app with pglite
and local sandboxes, no server, no network Postgres, by design.

| Axis | Heavy end | Light end |
| --- | --- | --- |
| Database | Network Postgres (`{ pool }` / `{ connectionString }`) | **Embedded pglite**: build a Kysely instance on `PGliteDialect` and pass `database: { db }`. Migrations run statement-by-statement specifically so single-connection dialects work. |
| Execution | Cloud sandboxes (`@catamorphic/cloudflare`, `@catamorphic/daytona`) | **Local sandboxes** (`@catamorphic/microsandbox`), **plain local processes** (`@catamorphic/local-process`, trusted single-tenant hosts only — ADR 0047), or omit `sandboxProvider` entirely for read-only embeds |
| Code storage | S3-compatible bucket (`@catamorphic/s3`: R2, S3, MinIO) or Cloudflare Artifacts | Two writable directories (`projectsPath`, `remotesPath`) |
| Identity | Host org/user per request (`forTenant({ tenantId }).forUser({ externalUserId })`) | A single fixed tenant/user for single-user apps |
| Surface | HTTP API + React UI | In-process SDK calls only, or migrations-only (`@catamorphic/db`) |

Common host shapes, composed from those axes:

- **Multi-tenant SaaS**: network Postgres, cloud sandboxes, S3-compatible
  storage, identity from the host's auth. The rest of this guide's examples
  use this shape.
- **Desktop / local-first app**: pglite, local sandboxes, filesystem
  storage, fixed identity. Reference implementation:
  [`apps/desktop/src/main/server/boot.ts`](apps/desktop/src/main/server/boot.ts).
- **Single-tenant internal tool**: network Postgres the team already has
  (or pglite), **`@catamorphic/local-process` execution** — plain
  subprocesses, no cloud sandbox account, and workflows reach host-local
  services (internal APIs, a loopback database gateway) with no tunnels.
  Sound because every production run executes an immutable deployed commit
  (ADR 0040): the trust statement attaches to a reviewed deploy, not to
  whatever an agent typed five minutes ago. Never use this provider for
  multi-tenant hosts — the only isolation is a process boundary and an
  explicit env. **This shape ships ready-made as the stock server**
  (`apps/server`, ADR 0059): `docker run` with everything on disk, bearer
  tokens in `auth.json`, invites over an admin API, mDNS LAN discovery,
  `DATABASE_URL` to swap PGlite for real Postgres — read it as the
  reference for this shape before writing a host from scratch.
- **Read-only embed / reporting**: `@catamorphic/db` migrations plus SQL
  joins, or the SDK without a sandbox provider.

## Library-direct SDK: `@catamorphic/server-sdk`

See [`packages/server-sdk/README.md`](packages/server-sdk/README.md) for the full usage guide. The short version:

```ts
// Boot, once per process
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { createCatamorphic } from "@catamorphic/server-sdk";

export const catamorphic = createCatamorphic({
  // Pass a pg.Pool the host already owns, or a connection string catamorphic
  // manages itself. Tables live in the `catamorphic` schema either way.
  database: { pool: hostPgPool },
  storage: {
    projectsPath: process.env.CATAMORPHIC_PROJECTS_PATH!,
    remotesPath: process.env.CATAMORPHIC_REMOTES_PATH!,
  },
  // Sandbox backends are vendor plugin packages: @catamorphic/cloudflare
  // (default) or @catamorphic/daytona. Omit for read-only embeds.
  sandboxProvider: new CloudflareSandboxProvider({
    apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
    apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
  }),
});

// Apply pending migrations (idempotent, schema-scoped). Run from a deploy
// step or at boot. It never touches the host's own tables.
await catamorphic.migrate();

// Worker startup is explicit. Start it once when this host process should
// process queued production runs.
const executionWorker = catamorphic.startExecutionWorker({ concurrency: 4 });

// Per request
const scoped = catamorphic
  .forTenant({ tenantId: req.org.id })
  .forUser({ externalUserId: req.user.id });
const project = await scoped.projects.create({ name: "onboarding" });
await scoped.files.write({
  projectId: project.id,
  path: "src/welcome.ts",
  content: welcomeTs,
  commitMessage: "Add welcome workflow",
});

const run = await scoped.runs.triggerProduction({
  projectId: project.id,
  workflowName: "welcomeUser",
  input: { email: "ada@example.com" },
});
```

Advanced hosts can inject their own wiring instead: `database: { db }` with a pre-built Kysely instance, `storage: { projectManager }` with custom git backends, or a custom `sandboxProvider`. Every injected sandbox provider is automatically wrapped with OpenTelemetry instrumentation.

### Identity mapping

- `tenantId` = host's org id. Maps 1:1 to `catamorphic.tenants(id)` and is upserted on first use: hosts never need to pre-register orgs with catamorphic.
- `externalUserId` = host's user id. Never persisted in catamorphic's DB; used only for (a) per-user git working directories via the `ProjectManager` and (b) git commit authorship.
- The host can freely `JOIN host.orgs.id = catamorphic.projects.tenant_id` for reports, analytics, cascading deletes, etc. Catamorphic never references host tables.

### Scoped-client surface

The scoped client exposes project CRUD, workflow listing/fetching, file I/O,
the complete identity-bound Runs resource, the Triggers resource, and — when
`github` is configured on `createCatamorphic` — a `scoped.github` resource
(connection status, repo listing, repo import; token acquisition uses the
OAuth/device-flow helpers exported from `@catamorphic/github`). Every public
method takes one keyed object parameter, for example
`scoped.projects.get({ projectId })`,
`scoped.workflows.get({ projectId, workflowName })`, and
`scoped.runs.get({ runId })`. Hosts do not pass tenant or user IDs into
individual calls. Plugin, secret, git, agent-session, and remote-sync
operations remain available through `catamorphic.core.*` and the HTTP
surface.

`scoped.runs` is the one SDK family for all Workflows. It includes run
triggering, list/detail, cancellation, operator processing pause/resume,
input submission, and item inspection. Capabilities on a Workflow or Run decide
which controls apply; there is no separate batch or persisted-continuation Run
resource.

`scoped.triggers` is the custom-trigger surface: hosts register domain trigger
kinds at boot (`defineTriggerKind` + `createCatamorphic({ triggerKinds })`),
workflows subscribe in code with `triggers: [trigger("kind", config)]`, and
the host fires a kind with a typed payload (`fire`, sync or async — sync runs
inline until the workflow's first durable wait, then detaches with an honest
`suspended` outcome), lists subscribed workflows with their constant configs
(`list`), and projects the generated `catamorphic-triggers.d.ts` into a
workspace (`syncTypes`). A trigger firing starts ordinary Runs — no new run
family. See `docs/decisions/0039-custom-trigger-kinds.md`.

### Observability

Catamorphic instruments itself with `@opentelemetry/api` only. Register your OpenTelemetry SDK (NodeSDK, exporters, sampling) in the host as usual and catamorphic's spans (`workflow.run`, `workflow.execute`, `project.create`, `project.deploy`, `sandbox.*`) appear in your traces automatically, correlated with your HTTP spans. Without an SDK they are no-ops. For dev, the repo-root `docker-compose.yml` ships an OTel collector → ClickHouse stack to point your exporter at.

## Database-only setup (just run the migrations)

Use the DB-only path when the host just wants to reach into catamorphic's schema (reporting, BI) without running catamorphic services.

Install `@catamorphic/db` in the host and run migrations as a deploy step:

```bash
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<hostdb> \
CATAMORPHIC_DB_SCHEMA=catamorphic \
npx catamorphic-db migrate     # or: catamorphic-db status
```

Or programmatically:

```ts
import { createDatabase, migrateToLatest } from "@catamorphic/db";

const db = createDatabase({ pool: hostPgPool });
await migrateToLatest({ db, schema: "catamorphic" });
```

For local development against a catamorphic checkout, install via `file:` links and rebuild after changes: see `.agents/skills/using-catamorphic/SKILL.md` → "Local dev linking".

## HTTP path: `@catamorphic/fastify-plugin`

Register the plugin on the host's Fastify server, telling it who is calling:

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, {
  core: catamorphic.core,
  prefix: "/api", // the generated api-client expects /api
  // The one identity mechanism. Runs on every request (including iframe
  // navigations to served app documents, which carry your session cookie).
  identity: async (request) => {
    const session = await verifySession(request); // your auth
    if (!session) return null;                     // → 401
    return { tenantId: session.orgId, externalUserId: session.userId };
  },
});
```

The plugin is fully encapsulated (its Zod compilers and error handler don't leak into the host app) and registers no CORS: the host owns cross-origin policy. For a sidecar process or spec generation, `createApp({ core, identity })` returns a complete Fastify app with CORS + Swagger UI at `/docs` and the plugin mounted at `/api`.

**There is no default identity.** The `identity` resolver is required and the plugin reads no headers on its own. Hosts whose auth terminates *in front of* the plugin (a gateway or proxy route that already verified the session) can pass the stock header resolver, `identityFromHeaders()`, which reads `X-Catamorphic-Tenant-Id` (host org id) and `X-External-User-Id` (host user id) — but a plugin mounted with it must never be reachable by browsers directly, since anyone could then claim any identity.

### Root, builders and viewers: identity scope

An identity is either **root** (`scope` absent: every project of the tenant, every surface — the desktop's own local projects, a host's service identity) or **scoped** (exactly the listed artifact refs and nothing else). Refs name artifacts by `(projectId, name|path)`:

| Ref | Grants |
| --- | --- |
| `{ kind: "project", projectId }` | **Builder** of that project: files, deploys, secrets, agent definitions, every workflow, app and agent — the whole program surface (not the store, see below). |
| `{ kind: "app", projectId, name }` | The app's served document plus, transitively, the workflows frozen into its *active published* version. |
| `{ kind: "workflow", projectId, name }` | One workflow directly (a per-customer MCP tool, a host-triggered action). |
| `{ kind: "agent", projectId, name, toolPolicies? }` | Chat sessions on the committed project agent `agents/<name>.json` (ADR 0050). Inside those sessions the caller's scope intersects the agent's tool policy: the project's tools server is narrowed to the caller's workflow refs, and `toolPolicies` (per connector server key, ADR 0054's shape) is one more narrowing layer. Own sessions only. |
| `{ kind: "document", projectId, path, access? }` | A file (`docs/handbook.md`) or subtree (`store/customers/acme/**`) of the project's path namespace; `access` defaults to `read`, `write` implies read. Git paths are read-only through this ref; `store/…` paths are the project store, reachable ONLY through document refs — builders included. |

```ts
identity: async (request) => {
  const session = await verifySession(request);
  if (!session) return null;
  const base = { tenantId: session.orgId, externalUserId: session.userId };
  if (session.isAdmin) return { ...base, scope: [{ kind: "project", projectId: BRAIN }] };
  // A CSM: the CSM agent, its workflows, and their own customers' subtree.
  return {
    ...base,
    scope: [
      { kind: "agent", projectId: BRAIN, name: "csm-assistant" },
      { kind: "workflow", projectId: BRAIN, name: "crm.lookup" },
      ...session.customers.map((c) => ({ kind: "document", projectId: BRAIN, path: `store/customers/${c}/**`, access: "write" })),
    ],
  };
}
```

Which users are builders and which artifacts each viewer gets is host policy (a role file, an entitlement table); catamorphic only enforces the result. Enforcement lives in core, so `server-sdk` callers get it too: `catamorphic.forTenant({ tenantId }).forUser({ externalUserId, scope })`. Scoped agent sessions hand the harness the caller (`StartSessionOpts.caller`, forwarded on `ExtraToolContext.caller`) and the caller's policy layers (`StartSessionOpts.toolPolicies`, refreshed on every `TurnOptions.toolPolicies`) — a hosting backend uses `caller` in `mcpServersForSession` to mint the project MCP endpoint's credentials for that user, so the endpoint enforces the same scope structurally. See [`docs/decisions/0053-identity-scope-and-app-routes.md`](docs/decisions/0053-identity-scope-and-app-routes.md) and [`0055`](docs/decisions/0055-company-brain-roles-store-and-change-loop.md).

### Roles as files, memberships as the stock source (ADR 0055)

Most hosts do not want to hand-write scopes. Commit roles into the project — `roles/<slug>.json`, next to `agents/` — and let core expand them:

```jsonc
// roles/csm.json
{
  "version": 1,
  "name": "CSM",
  "agents": ["csm-assistant"],                       // or { "name", "toolPolicies": { "slack": { "default": "ask" } } }
  "workflows": ["crm.lookup", "docs.search"],
  "apps": ["customer-tracker"],
  "documents": ["docs/**", { "path": "store/customers/{customer}/**", "access": "write" }]
}
// roles/admin.json
{ "version": 1, "name": "Admin", "builder": true, "documents": ["store/**"] }
```

`{param}` placeholders are filled from per-user **grants** (`{ customer: ["acme", "globex"] }`), one ref per value; an entry whose placeholder has no grant yields nothing. `builder: true` emits the `project` ref; an admin who may not see the whole store simply lists less. Role files are read from the shared origin `main` (a project without a remote reads its working tree), cached briefly (`rolesCacheTtlMs`, default 10s), and never throw: a broken file is reported by `GET /projects/:id/roles` and contributes nothing.

Two ways to turn a verified user into an identity:

```ts
// 1. You keep roles/grants yourself (a table, an SSO claim):
identity: async (req) => {
  const u = await verifySession(req);
  return u && resolveRoles(catamorphic.core, { tenantId: ORG, projectId: BRAIN, externalUserId: u.id, roles: u.roles, grants: u.grants });
}
// 2. The stock memberships table (core.memberships) keeps them:
identity: async (req) => {
  const u = await verifySession(req);
  return u && catamorphic.core.memberships.identityFor({ tenantId: ORG, projectId: BRAIN, externalUserId: u.id });  // null = not a member
}
// An invite is one call (builder-only), plus whatever link you send:
await catamorphic.core.memberships.grant({ identity: adminIdentity, projectId: BRAIN, externalUserId: "alice", roles: ["csm"], grants: { customer: ["acme"] } });
```

The plugin serves the same as HTTP for admin UIs: `GET /projects/:id/roles`, `GET|PUT|DELETE /projects/:id/memberships[/:externalUserId]` (`PUT` body `{ roles, grants? }`). Members arriving with a token the host issued (a connect link, their own agent on the MCP endpoint) use `identityFromBearer(verify)`: the host's `verify(token)` returns the identity (typically via `memberships.identityFor`) or `null`. Every request re-resolves, so revocation is immediate.

### Feature switches and introspection

Scope is how a host says "may not"; a few coarse switches say what the whole instance offers: `app.register(catamorphicPlugin, { …, features: { publications: "public" | "members" | false, proposals, mcp, storeUploadMaxBytes } })`. They are enforced by the routes concerned (403 / 404 / 413) *and* advertised on **`GET /me`**, together with the caller's own summary — `{ version: 1, identity: { externalUserId, root }, projects: [{ projectId, builder, agents, workflows, apps, documents: [{ path, access }] }], features: { publications, proposals, proposalsOpenPullRequests, mcp, agentSessions, storeUploadMaxBytes } }` — so a client (the desktop, a member's own agent) shows what is possible instead of discovering it by 403. Older hosts without `/me` degrade to "assume everything".

**Tokens for desktop members.** The connect link is the host's login flow: the invite page signs the user in with the host's own auth, mints a bearer token, and redirects to `catamorphic://connect?server=…&token=…&project=…&name=…&renew=<host URL>`. `identityFromBearer(verify)` decides what the token means on every request, so revocation is immediate; when a token stops working (401) the desktop offers "Sign in again", which opens `renew` — the host hands back a fresh link. Long-lived revocable tokens are the pragmatic default; refresh is the host's business.

### The project MCP endpoint: bring your own agent

`POST /api/projects/:id/mcp` serves the caller's whole scope as one MCP server: the project's `mcpToolKinds` workflow tools (roster filtered to the caller's workflow refs), `documents_list/read/search/write/delete/history` (the documents surface, per the caller's document refs; `documents_write` takes `text` or `base64` for binaries), `publish_document/revoke_publication/list_publications`, `propose_change`, `list_skills/read_skill`, and `ask_agent` (a synchronous turn with a project agent the caller may open sessions on). Claude Code, Cursor, or the host's own assistant connect with a host-issued token through `identityFromBearer`; the desktop's harnesses mount the same URL per session (`mcpServersForSession`). Being invited *is* receiving this URL.

The generated HTTP client lives in `@catamorphic/api-client`; construct it with `createApiClient({ baseUrl, fetch })`.

All execution uses one Runs route family:

- `POST /api/projects/:projectId/workflows/:name/runs` triggers a Run (async; returns the Run).
- `POST /api/projects/:projectId/workflows/:name/calls` **calls** a workflow synchronously: the run is driven inline until it settles or reaches a durable wait, and the response is `{ status: "completed", output } | { status: "failed", error } | { status: "suspended", runId, suspendedOn }` — poll `runId` in the last case. Sync is a calling mode, not a workflow kind: same durable run record, same deployed commit.
- `GET /api/projects/:projectId/workflows/:name/runs` lists Runs.
- `GET /api/runs/:runId` and `/api/runs/:runId/*` expose detail and capability-specific controls.

Apps have their own execution routes — `POST /api/projects/:id/apps/:name/calls/:workflow`, `POST …/apps/:name/runs/:workflow`, `GET …/apps/:name/runs/:runId` — which the `AppMount` component uses. The URL names the app, so the plugin narrows whoever arrives to that app structurally (a builder is confined to the app while inside it; a viewer must be entitled to it) before the server re-authorizes against the frozen workflow set. Nothing is claimed by the client.

Every Run executes an immutable deployed commit and retains that provenance;
there is no mutable-source or test mode.

## React bindings: `@catamorphic/react`

`@catamorphic/react` is the headless UI layer: a `CatamorphicProvider`, jotai atoms, and TanStack Query data hooks over `@catamorphic/api-client`. It has zero smart components: wire it up once and call the hooks from your own screens (or from `@catamorphic/ui`).

Peer deps: `react ^18.2 || ^19`, `react-dom ^18.2 || ^19`, `@tanstack/react-query ^5`.

```tsx
import { createApiClient } from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";

const queryClient = new QueryClient();
const apiClient = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_CATAMORPHIC_URL!,
  fetch: async (input, init) => {
    // Same origin as your API: the session cookie rides along and the
    // plugin's `identity` resolver turns it into a catamorphic identity.
    return fetch(input, { ...init, credentials: "include" });
  },
});

export function Root({ children }) {
  return (
    <CatamorphicProvider apiClient={apiClient} queryClient={queryClient}>
      {children}
    </CatamorphicProvider>
  );
}
```

Then anywhere under the provider:

```tsx
import {
  useCreateProject,
  useProject,
  useProjects,
  useWorkflow,
  useWriteProjectFile,
} from "@catamorphic/react";

function ProjectList() {
  const { data } = useProjects();
  const createProject = useCreateProject();
  // …
}
```

Hooks shipped:

- **Projects + workflows + files**: `useProjects`, `useProject`, `useCreateProject`, `useUpdateProject`, `useDeleteProject`, `useProjectFiles`, `useProjectFile`, `useWriteProjectFile`, `useWorkflows`, `useWorkflow`.
- **Runs**: `useRuns`, `useRun`, `useTriggerRun`, `useCancelRun`, `usePauseRunProcessing`, `useResumeRunProcessing`, `useSubmitRunInput`, `useRunItems`, `useRunItemSteps`.
- **Git**: `useProjectGit`, `useProjectBranches`, `useProjectCommits`, `useProjectConflicts`, `useCreateBranch`, `useCheckoutBranch`, `useCommitChanges`, `useDeployProject`, plus the composite `useProjectGitState({ projectId, baselineFiles })` for multi-branch draft persistence.
- **Plugins + secrets**: `usePluginCatalog`, `useProjectPlugins`, `useAttachPlugin`, `useDetachPlugin`, `useProjectSecrets`, `useUpsertProjectSecret`, `useDeleteProjectSecret`.
- **Agent (coding sessions)**: `useAgentSessions`, `useAgentSession`, `useCreateAgentSession`, `useSendAgentMessage`.

All hooks reject with the typed `CatamorphicError` envelope (discriminated by `code`: `unauthorized`, `not_found`, `validation`, `conflict`, `server_error`, `network`, `unknown`). Use `isCatamorphicError(err)` and switch on `err.code`; never branch on `err.message`. Shared OpenAPI-derived domain types (`Project`, `Run`, `RepoStatus`, `BranchInfo`, `ConflictEntry`, `PluginInfo`, `Secret`, `AgentSession`, …) live behind a single `@catamorphic/react/types` barrel.

## Agent tool permissions for hosts (ADR 0054)

Coding-agent harnesses gate every MCP tool call through a permission policy
(`allow` / `ask` / `deny`; `auto` = read-only tools run, others ask). A host
supplies two things:

- **Policies** — per server key, as layers that intersect (strictest wins).
  Pass `mcpPolicies` (a value or a getter) to `AiSdkCodingAgent` /
  `ClaudeCodeAgent` / `CodexAgent`; a shared org credential's ceiling is
  simply the first layer, the user's own policy the second, the agent's the
  third. Codex has no per-call approval channel: `deny` and `ask` become
  `disabled_tools` there.
- **The answer to `ask`** — `onToolPermission`. Hosts with their own consent
  UI implement it directly. Browser-served hosts use the broker: create a
  `ToolPermissionBroker` (from `@catamorphic/core`), pass it as
  `toolPermissions` on the core config and hand `broker.handlerFor(agentName)`
  to each provider. The plugin then serves
  `GET /projects/:id/agent/sessions/:sid/permissions` and
  `POST …/permissions/:pid` (`{decision: "allow" | "deny", remember?:
  "always"}`); `useToolPermissions()` in `@catamorphic/react` polls them
  while a turn runs and the registry's `tool-permission-card` (already inside
  `agent-chat`) renders the consent. Unanswered asks deny after five minutes.
  Persisting an "always allow" is the host's job — it knows where the
  connection's policy lives.

## Ready-made components: `@catamorphic/ui`

`@catamorphic/ui` ships the workflow canvas (`WorkflowEditor`, `WorkflowCanvas`), detail panel, history sidebar, toolbar, and AI bar as composable React components built on `@catamorphic/react`. Everything is opt-in: use `WorkflowEditor` for the full experience, or compose `WorkflowCanvas` + your own chrome. Code editors are plugged in via render props (bring your own Monaco/CodeMirror). Import `@catamorphic/ui/styles.css` once.

## Component registry: `@catamorphic/registry`

`@catamorphic/registry` is a shadcn-style copy-paste registry for hosts that want to own the component source. Items are JSON manifests that inline a single React component file; consumers run `npx shadcn add <path-or-url>/r/<item>.json` and the component drops into `components/catamorphic/`. The component then imports hooks from `@catamorphic/react` and primitives from `@catamorphic/ui` only: there's no runtime dependency on the registry itself.

Items shipped: `catamorphic-provider`, `projects-list`, `project-editor`, `file-explorer`, `git-panel`, `diff-drawer`, `runs-panel`, `plugins-settings`, `monaco-editor`, `agent-chat`, `chat-timeline`, `sessions-list`, `tool-permission-card`.

Catamorphic doesn't host the registry itself. After `bun run build`, the built manifests live at `packages/registry/dist/r/<name>.json`; hosts install them from `./node_modules/@catamorphic/registry/dist/r/<name>.json` or from a URL the host serves. To add a new item: drop a `src/<name>/<name>.tsx` + `registry-item.json` under `packages/registry/src/`, run `bun run build`, and re-install it in the host.

## Plugin packages (workflow SDKs)

Catamorphic can attach external packages (for example workflow SDKs) to a project so workflows can `import` plugin exports.

In v1, plugins are resolved from a local directory configured via env:

```bash
CATAMORPHIC_LOCAL_PLUGINS_DIR=/path/to/host/plugin/packages
```

Runtime summary:

1. Server loads attached plugins and secret values for the project.
2. Plugin files are mirrored into sandbox `node_modules/<packageName>/`.
3. Secrets are injected into the harness env for plugin runtime usage.
4. Agent and workflow-builder context include plugin README + d.ts.

For full details (manifest contract, REST API, service internals, runtime flow, troubleshooting, and resolver roadmap), use [`packages/plugins/README.md`](packages/plugins/README.md) as the canonical source.

## Capabilities, lifecycle hooks, and plugin host halves (ADR 0046)

A plugin has **two activation planes**. Its *sandbox half* (client library,
manifest, docs) is attached per project through the catalog — a UI action.
Its *host half* (code that runs in the host process) activates **only by
boot registration** in `createCatamorphic`. A UI click can never execute
code in the host process.

Run-time env resolves through one bindings chain:
**capability provider → stored secret → manifest default.**

- A plugin manifest declares `requires: [{ "name": "acme.database" }]`.
- The host registers a **capability provider** for that name. At run
  launch, `resolve(...)` returns env values that are merged into the run's
  environment and never persisted — mint short-lived, per-project
  credentials here.
- Attaching a plugin whose non-optional requirement has no registered
  provider fails closed with a 400 at attach time.
- **Project lifecycle hooks** provision per-project infrastructure:
  `onProjectCreated` failures roll the create back; `onProjectDeleted` runs
  before deletion and a failure aborts it (retryable, nothing leaks). Hooks
  must be idempotent.

```ts
import {
  createCatamorphic,
  defineCapability,
  definePlugin,
} from "@catamorphic/server-sdk";

// Ships in the same npm package as the plugin's sandbox half.
const acmeDbPlugin = (cfg: { apiKey: string }) =>
  definePlugin({
    name: "@acme/catamorphic-db",
    capabilities: [
      defineCapability({
        name: "acme.database",
        resolve: async ({ projectId, environment }) => ({
          DATABASE_URL: await mintScopedUrl(cfg.apiKey, projectId, environment),
        }),
      }),
    ],
    projectHooks: {
      onProjectCreated: ({ project }) => provisionDb(cfg.apiKey, project.id),
      onProjectDeleted: ({ project }) => dropDb(cfg.apiKey, project.id),
    },
  });

export const catamorphic = createCatamorphic({
  database: { pool: hostPgPool },
  storage: { projectsPath, remotesPath },
  plugins: [acmeDbPlugin({ apiKey: process.env.ACME_KEY! })],
  // Loose providers/hooks can also be passed directly:
  // capabilityProviders: [...], projectHooks: [...],
});
```

Workflow code stays vendor-blind — it imports the plugin's client and reads
`process.env.DATABASE_URL`. Providers must not return `CATAMORPHIC_`-prefixed
names, and duplicate capability or trigger-kind names across plugins fail at
boot.

### Caller-bound host functions and the documents surface (ADR 0055)

A capability provider may also expose **calls** — host functions a workflow
reaches as `context.host.<capability>.<fn>(args)`. Runs are stamped with the
identity that triggered them (`workflow_runs.caller_scope`); a boundary that
returns a host call ends there, core executes the function **as that
caller** (`{ caller, projectId, runId, workflowName }` is the first
argument — a workflow cannot claim to be anyone), and the result is the next
step's input, exactly like `callWorkflow`. A throw fails the step; the
step's retry policy re-runs the call (at-least-once, like any step IO).

```ts
defineCapability({
  name: "acme.crm",
  calls: {
    lookupAccount: async ({ caller }, args: { id: string }) =>
      crm.accounts.get(args.id, { asUser: caller.externalUserId }),
  },
});
// in a workflow:
defineBoundary({ run: ({ input, host }: BoundaryContext<{ id: string }>) => host.acme.crm.lookupAccount({ id: input.id }) }),
defineBoundary({ run: ({ input }: BoundaryContext<{ name: string }>) => ... }),
```

`context.documents` is the first built-in such capability: `list`, `read`,
`write`, `delete`, `history`, `search` over the project's one path
namespace — the program (git, read-only) and the project store (`store/…`,
versioned, caller-stamped) — every operation narrowed to the caller's
document refs. That is what makes project-authored search safe by
construction: an indexer or ranker that reads through `context.documents`
cannot leak what the caller may not see. `context.caller` (`{
externalUserId, scope? }`) is available for anything else that needs to
know who asked. The same surface is served over HTTP at
`/projects/:id/documents` (list, `content` JSON, `raw` bytes, `PUT` text or
base64 with `ifVersion`, `history`, `search?q=&mode=grep|text&prefix=`).
Store bytes live inline in Postgres unless `documentBlobStore` (a
filesystem or S3-compatible store) is configured; metadata, versions, text
and the search index always stay in the database. On a hosting backend,
agents' `store/` writes in their working folder are **pulled before and
shipped after every turn as the caller** (`storeSyncAroundTurns`, default
on; the turn's message metadata carries `storeSync` with what shipped, was
refused, or conflicted) — a member's agent can only land what the member
may write. Hosts whose folders are the truth (the desktop's local projects)
set it `false` and sync explicitly. The framework's
`searching-documents` host skill carries the recipe agents follow.

### Proposals and publications (ADR 0055)

Two more members' surfaces, both enforced by core and served by the plugin:

- **Propose a change** — `POST /projects/:id/proposals` `{ title, body?, changes: [{ path, content } | { path, delete: true }] }` (also the MCP tool `propose_change`). Program paths only (store paths ship directly). Core commits the files on a fresh `proposals/<member>/<title>-<stamp>` branch from the shared `main`, authored as the member, and — when the project is linked to a code host and you configured `proposalBot` (the identity whose GitHub connection acts for members) — pushes it and opens a pull request "Proposed by <member> via Catamorphic". Without a bot the branch lands on the project origin, where builders see it. Anyone who may use the project may propose.
- **Publications** — `POST /projects/:id/publications` `{ path, audience: "public" | "members", slug? }` → `{ slug, url, … }`; `GET` lists (builders all, members their own), `DELETE …/:slug` revokes. Builders publish what they may read; members what they may write (their own store documents). Serving: `GET /projects/:id/publications/:slug` for members (host auth) and `GET /public/:id/:slug` for `public` — the one route the identity hook lets through unauthenticated (route config `public: true`); it reads the document as an anonymous identity scoped to exactly that document, so nothing else is reachable. Unknown, revoked and not-for-you are one uniform 404.

### Reference architecture: a database per project

The capability seam is how embedders give every project real database
storage without Catamorphic knowing any vendor:

- **Internal tools / single server**: run a fleet of server-side PGlite
  instances (one datadir per project, hibernated when idle) behind a
  Postgres wire-protocol gateway such as `pg-gateway` on loopback. The
  provider resolves to `postgres://…@127.0.0.1` with per-project
  credentials; with `@catamorphic/local-process` execution, workflows reach
  it with no ingress or tunnels. Snapshot datadirs to S3 for backup.
- **Embedded SaaS at scale**: provision a managed Postgres per project
  (Neon-style database-per-tenant with scale-to-zero, or an equivalent
  service) from `onProjectCreated`, deprovision in `onProjectDeleted`, and
  mint short-lived pooled connection URLs in the provider. No long-lived
  credential is ever at rest in Catamorphic.

Both tiers are Postgres and both arrive as "a URL in env," so promoting a
project from the PGlite fleet to a managed database is a data migration,
not an app change.

## Bring your own doctrine (ADR 0049)

The framework ships mechanism plus good defaults; what work should *look
like* in your product is yours. Two `createCatamorphic` hooks receive the
framework defaults and return the host-final set — replacing or removing
entries is legitimate:

- `projectSeeds` — the per-project seed files (`.agents/skills/…`). The
  seeded `building-apps` skill is mechanics (framework contracts — keep it);
  `designing-apps` is design doctrine, the seed you most likely swap for
  your own. A seed you remove also never resurrects via the per-turn
  workflow-skill restore.
- `standingAgentPrompt` — the standing system prompt for coding-agent
  sessions: omit for the workflow-authoring default, a string to replace,
  `false` for none.

```ts
export const catamorphic = createCatamorphic({
  database: { pool: hostPgPool },
  storage: { projectsPath, remotesPath },
  projectSeeds: (defaults) => {
    const seeds = { ...defaults };
    delete seeds[".agents/skills/designing-apps/SKILL.md"];
    seeds[".agents/skills/acme-design/SKILL.md"] = ACME_DESIGN_SKILL;
    return seeds;
  },
});
```

Everything resolves once at boot; the desktop app passes none of these and
runs on the defaults.

## Validating projects in CI or a local editor

Each project seeds `scripts/check.ts` (project-owned; the logic lives in the
`@catamorphic/parser` devDependency). `bun run check` parses the workspace,
validates trigger bindings (add `--host <url>` to check against a live
host's kind catalog), and fails on stale generated types; `--write`
regenerates the app-api types. Sandbox installs strip the tooling
dependency automatically, so it never reaches execution or app builds.

## Workflow authoring model

All exports are Workflows and every invocation is a Run. Every workflow is an
exported `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
value from `@catamorphic/workflow` (or a host wrapper):

- `defineBoundary` is an atomic retry scope whose callback operations retry together.
- `defineBatch` is a finite paged per-item processing scope with an optional sink.
- `defineBatchStep` physically coalesces compatible calls made inside `defineBatch.process`.
- `"use step"` functions hold IO and business operations, called from boundary
  run bodies and batch process callbacks.

These capabilities share workflow discovery, graph APIs, Runs routes, SDK
resources, React hooks, and UI. Do not introduce a public stage, category
selector, or capability-specific Run family. Apps consume workflows through a
single `Workflow<T>` contract from `@catamorphic/app`: the client exposes
`.call(input)` (waits for the terminal output; a workflow with no pause,
retry, rate limit, batch, or child call settles inline) and `.start(input)`
(returns a pollable run handle).

## Operational Notes

- `catamorphic.migrate()` / `catamorphic-db migrate` are idempotent and schema-scoped; run them in CI/deploy (preferred) or at boot.
- Catamorphic uses strict schema scoping on its own DB access: connection strings get `search_path = "catamorphic"`, host-provided pools get Kysely's `WithSchemaPlugin`. Unqualified names cannot fall through to `public`.
- Host-owned pools and Kysely instances are never destroyed by catamorphic; `catamorphic.close()` only closes what catamorphic created.
- Stop handles returned by `catamorphic.startExecutionWorker(...)` during host shutdown. Constructing the SDK or Fastify plugin never starts workers implicitly.

## Execution Environments and credential connections

Hosts own physical execution and provider credentials. Projects name logical
Environments in `.catamorphic/project.json`; the host maps each binding id to
an actual provider with `defineStaticEnvironments`. An Environment is
project-visible policy, a binding is its host-owned realization, and an
Allocation is the immutable decision for one root session or workflow run.
WorkerNode selection is a later placement concern and is never a project
choice.

Pass `credentialVault` and `connectionProviders` to `createCatamorphic` when
external systems are enabled. The vault stores opaque bytes outside the
Catamorphic database. Provider code runs in the control plane. Workflows call
`context.connections.<alias>.<action>(args)` and agents use allocation-bound
Catamorphic MCP grants. Neither receives upstream credentials.
Connection aliases use letters, numbers, underscores, and hyphens only. Core
does not perform lossy alias normalization, so one alias always maps to one MCP
server and policy key.

Roles grant Environments and logical connection aliases separately. Project
builder access does not imply managed-compute or connection access. Projects
cannot declare physical endpoints, OAuth clients, credential values, or
service identities.

Member connections use the authorization flow supported by the provider.
Project and tenant service connections are created only by a host identity
with `connections:manage_service`. An Environment binding chooses allowed
principal kinds, capabilities, and any assigned service connection. A trigger
scan is the unattended enablement boundary: it must resolve every required
alias to an assigned service connection, then freezes those ids for dispatch.
Member connections are never eligible for schedules or webhooks. To prevent a
privileged service action from running in a local Environment, do not create
that alias binding there and grant it only in the managed Environment.

Long-lived API keys and service-account material use service connections, not
project secrets. The service-credential API accepts provider-defined opaque
text. For `defineMcpConnectionProvider`, that text is a JSON
`McpConnectionCredential`, for example
`{"headers":{"Authorization":"Bearer ..."}}`. The broker opens it only for
the provider call. A workflow step that will later invoke an agent inherits the
workflow's Environment, Allocation, and narrowed grants; it must not create a
second credential selection path.

Vault backup and rotation are host responsibilities. Back up encrypted records
and their wrapping key together, restrict both to the server account, rotate
service material through the connection API, and retain the old wrapping key
until every record has been re-encrypted. Public OAuth redirects require TLS, a
stable callback URL, and trusted proxy headers. MCP servers may support dynamic
client registration; Slack, Google, and providers that require pre-registration
still need deployment-owned client ids and secrets configured in the provider.

OAuth registries and MCP discovery do not remove deployment setup. Slack still
requires a Slack app with approved scopes. Google Workspace still requires a
Google Cloud OAuth client or a service account with administrator-approved
domain-wide delegation. Remote deployments need stable HTTPS callback URLs,
correct proxy headers, a backed-up vault key, and a documented rotation plan.
