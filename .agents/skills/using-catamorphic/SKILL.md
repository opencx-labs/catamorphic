---
name: using-catamorphic
description: Wire Catamorphic into a host application's backend and frontend (createCatamorphic boot, per-request identity and permissions, workers, the Fastify plugin, the generated API client, React provider and hooks, local package linking). Use when embedding Catamorphic in a host, debugging an embed (401, 415, empty canvas, runs that never start), or choosing which @catamorphic package to import.
---

# Using Catamorphic

Catamorphic ships as libraries a host mounts in-process. The host owns auth,
users and orgs, the database, deployment, and product identity; Catamorphic
never references host tables. Everything is explicit: `createCatamorphic`
reads no environment variables and picks no default backend, tenant, or user.

Related guidance:

- [`INTEGRATION.md`](../../../INTEGRATION.md): the full integration guide with
  longer examples (roles, capabilities, doctrine hooks, execution Environments).
  Read the section for whatever you are wiring.
- [embedding-guide](../embedding-guide/SKILL.md): composing the UI (workflow
  editor, inspectors, member consent, sessions, registry components).
- [setup-catamorphic-server](../../../skills/setup-catamorphic-server/SKILL.md):
  stock-server setup, machine enrollment, and multi-instance deployment.
- Reference hosts: the desktop's embedded server
  [`apps/desktop/src/main/server/boot.ts`](../../../apps/desktop/src/main/server/boot.ts)
  (PGlite, local execution, fixed identity) and the stock server `apps/server`
  (single-tenant, Better Auth, local processes).

## Choose the surfaces

| Surface | Use when | Package |
| --- | --- | --- |
| SDK, in-process | Host is Node or Bun | `@catamorphic/server-sdk` |
| HTTP | A frontend needs the API, or the caller is not in-process | `catamorphicPlugin` from `@catamorphic/fastify-plugin`, consumed with `@catamorphic/api-client` |
| DB only | Reporting joins against Catamorphic tables | `@catamorphic/db` migrations |

Most hosts use the first two together: the SDK boots the core once, and the
plugin exposes that same core to the frontend. The React packages
(`@catamorphic/react`, `@catamorphic/ui`) always talk HTTP through the API client.

Most `@catamorphic/*` packages are private workspace packages, not published
to npm. Link them from a built checkout ([Local dev linking](#local-dev-linking)).

## 1. Boot once per process

```ts
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { createCatamorphic, defineStaticEnvironments } from "@catamorphic/server-sdk";

const sandboxProvider = new CloudflareSandboxProvider({
  apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
  apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
});

export const catamorphic = createCatamorphic({
  // { pool } (host-owned, never closed by Catamorphic), { connectionString },
  // or { db } (a prebuilt Kysely, e.g. on PGliteDialect). Tables live in the
  // `catamorphic` schema unless `schema` says otherwise.
  database: { pool: hostPgPool },
  // Or { projectManager } for custom git backends (S3, Cloudflare Artifacts).
  storage: {
    projectsPath: process.env.CATAMORPHIC_PROJECTS_PATH!,
    remotesPath: process.env.CATAMORPHIC_REMOTES_PATH!,
  },
  sandboxProvider, // omit for read-only embeds; auto-instrumented, never wrap it yourself
  environmentProvider: defineStaticEnvironments([
    {
      descriptor: {
        id: "local",
        label: "Managed execution",
        trust: "managed",
        isolation: "sandbox",
        workloads: ["agent", "workflow"],
        agentTopologies: ["controller"],
        capabilities: ["network.egress"],
        resources: {},
      },
      sandboxProvider,
    },
  ]),
});
```

- `environmentProvider` is required. The static helper covers one execution
  pool; multi-pool hosts implement `EnvironmentProvider`.
- Execution backends are separate packages the host constructs:
  `@catamorphic/cloudflare`, `@catamorphic/daytona`,
  `@catamorphic/microsandbox` (`MicrosandboxSandboxProvider`), or
  `@catamorphic/local-process` (`LocalProcessSandboxProvider`, trusted
  single-tenant hosts only, ADR 0047).
- Agent sessions: pass `codingAgent` (one `CodingAgentProvider` such as
  `AiSdkCodingAgent`, or a `CodingAgentRegistry` of named agents) plus
  `hostId`. Registry entries with `topology: "native"` (Claude Code, Codex)
  also need `nativeAgentCheckout`.
- Other host hooks (`triggerKinds`, `plugins`, `capabilityProviders`,
  `projectHooks`, `projectSeeds`, `hostSkills`, `standingAgentPrompt`,
  `github`, `pluginResolver`, `credentialVault`, `clientExecution`, and more)
  are documented on `CreateCatamorphicConfig` in
  [`packages/server-sdk/src/catamorphic.ts`](../../../packages/server-sdk/src/catamorphic.ts).

## 2. Migrate and start background work

```ts
await catamorphic.migrate(); // idempotent, touches only its own schema

// Each process that should claim queued work starts its own handles.
const executionWorker = catamorphic.startExecutionWorker({ concurrency: 4 });
const agentWorker = catamorphic.startAgentWorker(); // only with codingAgent
const events = startEventDispatcher({ core: catamorphic.core }); // from @catamorphic/core

// Shutdown
await Promise.all([executionWorker.stop(), agentWorker.stop(), events.stop()]);
await catamorphic.close(); // closes only what Catamorphic created
```

Nothing starts implicitly. Without an execution worker, production runs stay
queued. The event dispatcher delivers project events (webhooks, chat events,
GitHub) to workflows. `startAgentWorker` resolves identities through
`core.memberships` unless you pass `resolveIdentity`.

Migrations can also run as a deploy step:
`DATABASE_URL=... CATAMORPHIC_DB_SCHEMA=catamorphic catamorphic-db migrate`
(also `status` and `reset`).

## 3. Bind identity per request

```ts
const scoped = catamorphic
  .forTenant({ tenantId: session.orgId }) // upserts catamorphic.tenants on first use
  .forUser({ externalUserId: session.userId, scope, projectPermissions });
```

- **Root** identity: `scope` omitted. Every project of the tenant and every
  permission. Use it for the host's own service identity or a single-user app,
  never as a shortcut for people who edit the program.
- **Scoped** identity: `scope` lists artifacts the user may use:
  `{ kind: "app" | "workflow" | "agent", projectId, name }` (`name: "*"` for
  every one of that kind) and `{ kind: "document", projectId, path, access? }`
  (the project store under `store/` is reachable only through document refs).
- `projectPermissions: [{ projectId, permission }]` says what they may do to
  the project (ADR 0158). Permissions are `thing:action`: `program` (`read`,
  `write`, `publish`), and `read`/`write` on `secrets`, `automations`,
  `webhooks`, `runs`, `sessions`, `memberships`, `roles`, `publications`.
  `write` and `publish` imply `read` on the same thing and nothing else, so
  `program:publish` does not include `program:write`. Grants may be `thing:*`
  or `*`. Unknown namespaced names (`acme:approve`) are kept for the host and
  shown on `GET /me` but grant no framework authority.

Which user gets what is host policy; Catamorphic enforces the result. To avoid
hand-writing scopes, commit roles as `.catamorphic/roles/<slug>.json` and
expand them with `resolveRoles(core, { tenantId, projectId, externalUserId, roles, grants })`
(from `@catamorphic/core`), or keep memberships in the stock table and call
`catamorphic.core.memberships.identityFor({ tenantId, projectId, externalUserId })`.
Role files, grants, and the scope ref table are in
[INTEGRATION.md](../../../INTEGRATION.md) ("Root and scoped identities" and
"Roles as files").

## 4. Call the SDK

Every public method takes one keyed object. The scoped client exposes
`projects`, `files`, `workflows`, `runs`, `triggers`, `workflowEnablements`,
`apps`, `sessionArtifacts`, `github` (when configured), and `capabilities`.

```ts
const project = await scoped.projects.create({ name: "onboarding" });
await scoped.files.write({
  projectId: project.id,
  path: ".catamorphic/workflows/src/welcome-user.ts", // workflow sources live here (ADR 0142)
  content: source,
  commitMessage: "Add welcome workflow",
});
const workflows = await scoped.workflows.list({ projectId: project.id });

// After a deploy:
const run = await scoped.runs.triggerProduction({
  projectId: project.id,
  workflowName: "welcomeUser",
  input: { email: "ada@example.com" },
});
const outcome = await scoped.runs.call({ projectId: project.id, workflowName: "welcomeUser", input: {} });
// { status: "completed" | "failed" | "suspended", runId, ... }; poll runs.get when suspended
```

- Every run executes the deployed commit. There is no test or mutable-source
  mode, so deploy first (`POST /api/projects/:projectId/deploy`, or
  `useDeployProject`); otherwise `ProductionDeploymentNotFoundError`.
- `triggerProduction` enqueues for the worker. `call` drives the run inline
  until it settles or reaches a durable wait.
- Typed errors are exported from the SDK: `SandboxProviderNotConfiguredError`,
  `ProductionDeploymentNotFoundError`, `WorkflowNotFoundError`,
  `PluginSecretsMissingError`, `AccessDeniedError`, `ProjectNotFoundError`.
- Plugins, secrets, git, agent sessions, deploy, and remote sync are reached
  through `catamorphic.core.*` or HTTP. Some core services take tenant and
  user positionally and do not check permissions themselves; mirror the checks
  the matching route in `packages/fastify-plugin/src/routes/` performs.

Workflow authoring (the `defineWorkflow` model, declared `permissions`,
`catamorphic.sessions.deliver`) is not host wiring. See the
[workflow-code-conventions](../workflow-code-conventions/SKILL.md) skill and
the seeded skill modules in `packages/core/src/*-skill.ts`.

## 5. Mount the HTTP API

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, {
  core: catamorphic.core,
  prefix: "/api", // the API client and React hooks expect /api
  identity: async (request) => {
    const session = await verifySession(request); // your auth
    if (!session) return null; // 401
    return {
      tenantId: session.orgId,
      externalUserId: session.userId,
      scope: [{ kind: "agent", projectId: BRAIN, name: "*" }],
      projectPermissions: [{ projectId: BRAIN, permission: "program:read" }],
    };
  },
  publicApiBase: "https://app.example.com/api", // needed for copyable webhook URLs
});
```

- `identity` is required and runs on every request, including iframe loads of
  app documents. There is no default identity and no header is read unless
  you choose a stock resolver: `identityFromBearer(verify)` for bearer tokens,
  or `identityFromHeaders()` (`X-Catamorphic-Tenant-Id`, `X-External-User-Id`)
  only behind a gateway browsers cannot reach directly.
- The plugin is encapsulated and registers no CORS. `createApp({ core, identity })`
  builds a standalone Fastify app (CORS, Swagger UI at `/docs`, plugin at `/api`)
  for a sidecar or spec generation.
- `features` switches instance-wide surfaces (`publications`, `proposals`,
  `mcp`, `storeUploadMaxBytes`). Clients read them, plus the caller's
  effective permissions, from `GET /api/me`.
- The plugin also serves the per-project MCP endpoint
  (`/api/projects/:id/mcp`) and app routes that confine the caller to the app
  named in the URL.

## 6. Frontend

```tsx
import { createApiClient } from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";

const apiClient = createApiClient({
  baseUrl: "https://app.example.com", // origin only: paths already start with /api
  fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
});

<CatamorphicProvider apiClient={apiClient} queryClient={hostQueryClient}>
  {children}
</CatamorphicProvider>;
```

- Peer deps: `react ^18.2 || ^19`, `react-dom`, `@tanstack/react-query ^5`.
  Pass the host's `queryClient` so caches are shared; the provider creates one
  otherwise. Pass `authorizationRedirectUri` when the API is mounted under a
  different prefix and connection authorization must return to it.
- Hooks are TanStack Query wrappers: projects and files (`useProjects`,
  `useWriteProjectFile`, ...), runs (`useRuns`, `useRun`, `useTriggerRun`,
  `useCancelRun`, ...), git (`useProjectGit`, `useDeployProject`,
  `useProjectGitState`, ...), plugins and secrets, agent sessions
  (`useAgentSessions`, `useSendAgentMessage`, `useArchiveAgentSession`, ...),
  enablements, `useAgentCatalog`, `useEnvironments`, `useToolPermissions`, and
  parsing (`useOnParse`, `useParseWorkflow`). The export list is
  [`packages/react/src/index.ts`](../../../packages/react/src/index.ts).
- Import server shapes from `@catamorphic/react/types` (`Project`, `Run`,
  `RunDetail`, `AgentSession`, ...) instead of redeclaring them. Pure authoring
  helpers that are safe in server components live in
  `@catamorphic/react/workflow-helpers`.
- Hooks reject with `CatamorphicError`. Check `err instanceof CatamorphicError`
  and switch on `err.code` (`unauthorized`, `forbidden`, `not_found`,
  `conflict`, `validation`, `rate_limited`, `sandbox_unavailable`,
  `authentication_required`, `network`, `unknown`); `details` is the raw
  server payload. Never match on `err.message`.
- Client bundles import only `@catamorphic/parser/layout`. The
  `@catamorphic/parser` barrel pulls in `ts-morph` and `node:fs` and fails at
  module evaluation in the browser. Parsing happens server-side through
  `useParseWorkflow` / `useOnParse`.

## Package cheatsheet

| Package | Key exports |
| --- | --- |
| `@catamorphic/server-sdk` | `createCatamorphic`, `Catamorphic`, `ScopedClient`, `defineStaticEnvironments`, `defineTriggerKind`, `webhook`, `schedule`, `definePlugin`, `defineCapability`, `startClientRunner`, typed errors, re-exported db/git/plugin building blocks |
| `@catamorphic/core` | `CatamorphicCore`, `createCatamorphicCore`, `CodingAgentRegistry`, `resolveRoles`, `startEventDispatcher`, `ToolPermissionBroker` |
| `@catamorphic/db` | `createDatabase`, `migrateToLatest`, `DB` types, `catamorphic-db` CLI |
| `@catamorphic/git` | `ProjectManager`, `FsBackend`, `FsRemoteBackend`, `ObjectRemoteBackend` |
| `@catamorphic/s3` | `S3ObjectStore` (use with `ObjectRemoteBackend`) |
| `@catamorphic/cloudflare` | `CloudflareSandboxProvider`, `ArtifactsClient`, `ArtifactsRemoteBackend` |
| `@catamorphic/daytona` | `DaytonaSandboxProvider` (and experimental git storage) |
| `@catamorphic/microsandbox` | `MicrosandboxSandboxProvider` |
| `@catamorphic/local-process` | `LocalProcessSandboxProvider` |
| `@catamorphic/sandbox` | `SandboxProvider`, `CodingAgentProvider` contracts |
| `@catamorphic/ai-sdk`, `claude-code`, `codex` | `AiSdkCodingAgent`, `ClaudeCodeAgent`, `CodexAgent` |
| `@catamorphic/plugins` | `LocalPluginResolver`, `PluginManifestSchema` |
| `@catamorphic/fastify-plugin` | `catamorphicPlugin`, `createApp`, `identityFromBearer`, `identityFromHeaders` |
| `@catamorphic/otel` | `getTracer`, `withSpan` (the host owns the OpenTelemetry SDK) |
| `@catamorphic/api-client` | `createApiClient`, `CatamorphicApiClient`, `paths` |
| `@catamorphic/react` | `CatamorphicProvider`, hooks, atoms, `CatamorphicError`; `/types`, `/workflow-helpers` subpaths |
| `@catamorphic/ui` | `WorkflowEditor`, `WorkflowCanvas`, `WorkflowEditorScope`, `RunsPanel`, `AppMount`, member workflow components, `styles.css` |
| `@catamorphic/registry` | Copy-paste component source (see embedding-guide) |
| `@catamorphic/parser` | `parseWorkflow`, `parseProject` (server only); `/layout` subpath for `layoutGraph` |
| `@catamorphic/workflow` | Workflow authoring API used inside projects, not by the host |

## Pitfalls

- **401 on every route.** The `identity` resolver returned null: the session
  did not reach the plugin's origin. Check `credentials: "include"` and
  same-origin or credentialed CORS. A 400 from `identityFromHeaders()` means a
  missing or malformed header.
- **415 from a custom `fetch`.** openapi-fetch passes a `Request` as `input`.
  When adding headers, start from
  `new Headers(input instanceof Request ? input.headers : init?.headers)` or
  `Content-Type` is dropped.
- **Runs stay queued.** No process started `startExecutionWorker`.
- **Shared pool, wrong `search_path`.** `{ connectionString }` pools set
  `search_path` to the Catamorphic schema; do not hand them to host code.
  Host-owned `{ pool }` is safe: queries are schema-qualified.
- **`useCatamorphic must be used within a <CatamorphicProvider>`.** The
  provider is missing, or two React copies are installed.
- **Empty workflow canvas or `node:fs` bundle errors.** See embedding-guide
  and the parser rule above.

## Local dev linking

Build the checkout (`bun run build` at its root; packages resolve each other
through `dist/`), then point the host at the package directories:

```bash
pnpm add @catamorphic/server-sdk@file:/abs/path/to/catamorphic/packages/server-sdk
pnpm add @catamorphic/react@file:/abs/path/to/catamorphic/packages/react \
  @catamorphic/api-client@file:/abs/path/to/catamorphic/packages/api-client \
  @catamorphic/ui@file:/abs/path/to/catamorphic/packages/ui
```

After a Catamorphic change: rebuild the changed packages, reinstall the
`file:` dependencies so the host picks up the new `dist/`, restart the host,
and rerun migrations if SQL changed.
