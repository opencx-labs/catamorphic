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
| Execution | Cloud sandboxes (`@catamorphic/cloudflare`, `@catamorphic/daytona`) | **Local sandboxes** (`@catamorphic/microsandbox`), or omit `sandboxProvider` entirely for read-only embeds |
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
- **Single-tenant internal tool**: network Postgres the team already has,
  filesystem storage, one tenant, often no HTTP surface.
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

`scoped.runs` is the one SDK family for all Workflows. It includes production
and test triggers, list/detail, cancellation, operator processing pause/resume,
input submission, and item inspection. Capabilities on a Workflow or Run decide
which controls apply; there is no separate batch or persisted-continuation Run
resource.

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

- `POST /api/projects/:projectId/workflows/:name/runs` triggers a production Run.
- `POST /api/projects/:projectId/workflows/:name/test-runs` triggers a mutable-source test Run for a plain `"use workflow"` function.
- `GET /api/projects/:projectId/workflows/:name/runs` lists Runs.
- `GET /api/runs/:runId` and `/api/runs/:runId/*` expose detail and capability-specific controls.

The test/production distinction is a Run mode and provenance choice, not a
type split. Workflows with persisted scopes currently require an immutable
production deployment; test triggering returns a capability error.

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
- **Runs**: `useRuns`, `useRun`, `useTriggerRun`, `useTriggerTestRun`, `useCancelRun`, `usePauseRunProcessing`, `useResumeRunProcessing`, `useSubmitRunInput`, `useRunItems`, `useRunItemSteps`.
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

## Workflow authoring model

All exports are Workflows and every invocation is a Run. An exported async
function with the exact `"use workflow"` directive has no persisted continuation
between operations. A Workflow that needs continuation uses
`defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))` from
`@catamorphic/workflow` (or a host wrapper):

- `defineBoundary` is an atomic retry scope whose callback operations retry together.
- `defineBatch` is a finite paged per-item processing scope with an optional sink.
- `defineBatchStep` physically coalesces compatible calls made inside `defineBatch.process`.

These capabilities share workflow discovery, graph APIs, Runs routes, SDK
resources, React hooks, and UI. Do not introduce a public stage, category
selector, or capability-specific Run family.

## Operational Notes

- `catamorphic.migrate()` / `catamorphic-db migrate` are idempotent and schema-scoped; run them in CI/deploy (preferred) or at boot.
- Catamorphic uses strict schema scoping on its own DB access: connection strings get `search_path = "catamorphic"`, host-provided pools get Kysely's `WithSchemaPlugin`. Unqualified names cannot fall through to `public`.
- Host-owned pools and Kysely instances are never destroyed by catamorphic; `catamorphic.close()` only closes what catamorphic created.
- Stop handles returned by `catamorphic.startExecutionWorker(...)` during host shutdown. Constructing the SDK or Fastify plugin never starts workers implicitly.
