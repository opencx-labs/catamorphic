# Catamorphic Integration Guide

Catamorphic is an **embeddable framework**. A host application runs catamorphic services in-process against its own Postgres instance: all catamorphic tables live in one schema (default: `catamorphic`). Three integration surfaces are available, in increasing order of coupling:

1. **`@catamorphic/db` only**: run the migrations, let the host join against `catamorphic.projects` / `catamorphic.workflow_runs`. Read-only relationship. Useful for reporting / BI.
2. **`@catamorphic/server-sdk` (library-direct, recommended)**: host imports `createCatamorphic(...)` and calls resources in-process. Identity is bound per request via `cat.forTenant(orgId).forUser(userId)`. No sidecar process.
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
| Identity | Host org/user per request (`forTenant(orgId).forUser(userId)`) | A single fixed tenant/user for single-user apps |
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
  explicit env.
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
const scoped = catamorphic.forTenant(req.org.id).forUser(req.user.id);
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

The scoped client exposes project CRUD, workflow listing/fetching, file I/O, and
the complete identity-bound Runs resource. Every public method takes one keyed
object parameter, for example `scoped.projects.get({ projectId })`,
`scoped.workflows.get({ projectId, workflowName })`, and
`scoped.runs.get({ runId })`. Hosts do not pass tenant or user IDs into
individual calls. Plugin, secret, and git operations remain available through
`catamorphic.core.*` and the HTTP surface.

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

For local development against a catamorphic checkout, install via `file:` links and rebuild after changes: see `.cursor/skills/using-catamorphic/SKILL.md` → "Local dev linking".

## HTTP path: `@catamorphic/fastify-plugin`

Register the plugin on the host's Fastify server:

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, {
  core: catamorphic.core,
  prefix: "/api", // the generated api-client expects /api
});
```

The plugin is fully encapsulated (its Zod compilers and error handler don't leak into the host app) and registers no CORS: the host owns cross-origin policy. For a sidecar process or spec generation, `createApp({ core })` returns a complete Fastify app with CORS + Swagger UI at `/docs` and the plugin mounted at `/api`.

Every request requires two headers (there are no defaults):

- `X-Catamorphic-Tenant-Id`: host org id
- `X-External-User-Id`: host user id

**Set these server-side from the host's verified auth context** (session, JWT). Never trust values forwarded from the browser. Typical setup: the host exposes its own authenticated proxy route, or wraps `fetch` in the api-client to inject the headers after verifying the session.

The generated HTTP client lives in `@catamorphic/api-client`; construct it with `createApiClient({ baseUrl, fetch })`.

All execution uses one Runs route family:

- `POST /api/projects/:projectId/workflows/:name/runs` triggers a Run.
- `GET /api/projects/:projectId/workflows/:name/runs` lists Runs.
- `GET /api/runs/:runId` and `/api/runs/:runId/*` expose detail and capability-specific controls.

Every Run executes an immutable deployed commit and retains that provenance;
there is no mutable-source or test mode. The synchronous trigger-firing path
runs any workflow inline until its first durable wait, so a workflow that
cannot suspend settles in the request.

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
    // Route through the host's authenticated proxy, which sets
    // X-Catamorphic-Tenant-Id + X-External-User-Id from the session.
    return fetch(input, init);
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

- **Projects + workflows + files**: `useTemplates`, `useProjects`, `useProject`, `useCreateProject`, `useUpdateProject`, `useDeleteProject`, `useProjectFiles`, `useProjectFile`, `useWriteProjectFile`, `useWorkflows`, `useWorkflow`.
- **Runs**: `useRuns`, `useRun`, `useTriggerRun`, `useCancelRun`, `usePauseRunProcessing`, `useResumeRunProcessing`, `useSubmitRunInput`, `useRunItems`, `useRunItemSteps`.
- **Git**: `useProjectGit`, `useProjectBranches`, `useProjectCommits`, `useProjectConflicts`, `useCreateBranch`, `useCheckoutBranch`, `useCommitChanges`, `useDeployProject`, plus the composite `useProjectGitState({ projectId, baselineFiles })` for multi-branch draft persistence.
- **Plugins + secrets**: `usePluginCatalog`, `useProjectPlugins`, `useAttachPlugin`, `useDetachPlugin`, `useProjectSecrets`, `useUpsertProjectSecret`, `useDeleteProjectSecret`.
- **Agent (coding sessions)**: `useAgentSessions`, `useAgentSession`, `useCreateAgentSession`, `useSendAgentMessage`.

All hooks reject with the typed `CatamorphicError` envelope (discriminated by `code`: `unauthorized`, `not_found`, `validation`, `conflict`, `server_error`, `network`, `unknown`). Use `isCatamorphicError(err)` and switch on `err.code`; never branch on `err.message`. Shared OpenAPI-derived domain types (`Project`, `Run`, `RepoStatus`, `BranchInfo`, `ConflictEntry`, `PluginInfo`, `Secret`, `AgentSession`, …) live behind a single `@catamorphic/react/types` barrel.

## Ready-made components: `@catamorphic/ui`

`@catamorphic/ui` ships the workflow canvas (`WorkflowEditor`, `WorkflowCanvas`), detail panel, history sidebar, toolbar, and AI bar as composable React components built on `@catamorphic/react`. Everything is opt-in: use `WorkflowEditor` for the full experience, or compose `WorkflowCanvas` + your own chrome. Code editors are plugged in via render props (bring your own Monaco/CodeMirror). Import `@catamorphic/ui/styles.css` once.

## Component registry: `@catamorphic/registry`

`@catamorphic/registry` is a shadcn-style copy-paste registry for hosts that want to own the component source. Items are JSON manifests that inline a single React component file; consumers run `npx shadcn add <path-or-url>/r/<item>.json` and the component drops into `components/catamorphic/`. The component then imports hooks from `@catamorphic/react` and primitives from `@catamorphic/ui` only: there's no runtime dependency on the registry itself.

Items shipped: `catamorphic-provider`, `projects-list`, `project-editor`, `file-explorer`, `git-panel`, `diff-drawer`, `runs-panel`, `plugins-settings`, `monaco-editor`, `agent-chat`.

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
like* in your product is yours. Three `createCatamorphic` hooks receive the
framework defaults and return the host-final set — replacing or removing
entries is legitimate:

- `projectSeeds` — the per-project seed files (`.agents/skills/…`). The
  seeded `building-apps` skill is mechanics (framework contracts — keep it);
  `designing-apps` is design doctrine, the seed you most likely swap for
  your own. A seed you remove also never resurrects via the per-turn
  workflow-skill restore.
- `projectTemplates` — the template picker's set. Build file maps with the
  exported `workspaceFiles` / `appScaffold` helpers. Creates compose
  `{...seeds, ...template.files}` (template wins collisions), so every
  template picks up your seed set.
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
  projectTemplates: (defaults) => [
    {
      id: "acme-crm",
      name: "Acme CRM",
      description: "A CRM sync starter",
      defaultWorkflow: "syncContacts",
      files: {
        ...workspaceFiles({ name: "acme-crm" }),
        "workflows/src/crm.ts": CRM_WORKFLOW,
      },
    },
    ...defaults,
  ],
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
