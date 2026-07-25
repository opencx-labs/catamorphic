# @catamorphic/server-sdk

The core SDK for embedding Catamorphic inside a host application's Node/Bun backend.

The host hands it a Postgres connection (or `pg.Pool`) and a storage location; catamorphic manages its own tables inside a dedicated schema (default `catamorphic`) and exposes projects, workflows, files, and execution. All identity (host org id, host user id) is scoped per request via `catamorphic.forTenant({ tenantId }).forUser({ externalUserId })` — no sidecar HTTP server required.

## Usage

### Boot — once per process

```ts
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { createCatamorphic } from "@catamorphic/server-sdk";

export const catamorphic = createCatamorphic({
  // One of:
  //   { pool: hostPgPool }                      — host-owned pool (recommended)
  //   { connectionString: process.env.DATABASE_URL! } — catamorphic owns the pool
  //   { db: kyselyInstance }                    — advanced, pre-built Kysely
  database: { connectionString: process.env.DATABASE_URL! },

  // Filesystem git storage (per-user working copies + bare origin remotes),
  // or { projectManager } for custom backends (e.g. ArtifactsRemoteBackend
  // from @catamorphic/cloudflare for Cloudflare Artifacts).
  storage: {
    projectsPath: process.env.CATAMORPHIC_PROJECTS_PATH!,
    remotesPath: process.env.CATAMORPHIC_REMOTES_PATH!,
  },

  // Backends are vendor plugin packages: @catamorphic/cloudflare (default)
  // or @catamorphic/daytona. Omit for read-only embeds.
  sandboxProvider: new CloudflareSandboxProvider({
    apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
    apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
  }),
});

// Apply pending migrations — idempotent, schema-scoped, never touches host
// tables. Run in a deploy step (preferred) or at boot.
await catamorphic.migrate();

// Worker startup is host-owned and explicit. Start it once after boot.
export const executionWorker = catamorphic.startExecutionWorker({
  concurrency: 4,
});

// In the host's shutdown hook:
await executionWorker.stop();
await catamorphic.close();
```

### Per request - bind identity, then call resources

```ts
// req.org.id  — host's org id (becomes catamorphic.tenants.id)
// req.user.id — host's user id (used for per-user git working dirs + commit authorship)

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

const workflows = await scoped.workflows.list({
  projectId: project.id,
  ref: "origin/main",
});
const workflow = await scoped.workflows.get({
  projectId: project.id,
  workflowName: "welcomeUser",
});

const run = await scoped.runs.triggerProduction({
  projectId: project.id,
  workflowName: workflow.name,
  input: { email: "ada@example.com" },
});
const detail = await scoped.runs.get({ runId: run.id });
// Every Batch processing scope is retained in workflow step order, including
// failed and canceled attempts, and can be inspected by its attempt id.
for (const scope of detail.batchScopes) {
  await scoped.runs.listItems({
    runId: detail.id,
    workflowStepAttemptId: scope.workflowStepAttemptId,
  });
}
```

### Scoped-client surface

Every method takes one keyed object parameter. `scoped.runs` is the only SDK Run
resource for all Workflows; capabilities determine which controls and item views
apply.

```ts
scoped.projects.create({ name, templateId? })
scoped.projects.list({ limit?, offset? })
scoped.projects.get({ projectId })
scoped.projects.update({ projectId, name? })
scoped.projects.delete({ projectId })

scoped.workflows.list({ projectId, ref? })
scoped.workflows.get({ projectId, workflowName, ref? })

scoped.files.list({ projectId })
scoped.files.read({ projectId, path })
scoped.files.readAll({ projectId })
scoped.files.write({ projectId, path, content, commitMessage? })

scoped.runs.triggerProduction({ projectId, workflowName, input? })
scoped.runs.triggerTest({ projectId, workflowName, input?, files? })
scoped.runs.list({ projectId, workflowName?, mode?, limit?, offset? })
scoped.runs.get({ runId })
scoped.runs.cancel({ runId, reason? })
scoped.runs.pauseProcessing({ runId })
scoped.runs.resumeProcessing({ runId })
scoped.runs.submitInput({ runId, pauseId, idempotencyKey, value })
scoped.runs.listItems({
  runId,
  workflowStepAttemptId,
  status?,
  limit?,
  offset?,
})
scoped.runs.listItemSteps({ runId, workflowStepAttemptId, itemId })
```

Workflow summaries and details match the public HTTP DTOs and intentionally omit
internal parser execution descriptors. Advanced hosts that need execution plans
can access them through `catamorphic.core.workflows`.

`pauseProcessing` and `resumeProcessing` throw `RunCapabilityError` when the
corresponding capability is not currently available. Repeating pause while the
Run is already operator-paused, or resume while that Batch scope is already
running, is idempotent.

Production and test are Run modes within this resource. Exact `"use workflow"`
functions may run against mutable test files. Workflows using
`defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))` have
persisted continuation and currently require an immutable production
deployment.

Plugins, secrets, and git ops (deploy/pull/diff) remain available through `catamorphic.core` or the HTTP surface. Runs are identity-bound on `scoped.runs`; hosts do not pass tenant or user ids into individual calls.

## Identity model

- `tenantId` = host's org id. Auto-upserts `catamorphic.tenants(id)` on first project create, so hosts never need to pre-register orgs.
- `externalUserId` = host's user id. Never persisted in catamorphic's DB; used only for per-user git working directories and commit authorship.

Host can safely `JOIN host.orgs.id = catamorphic.projects.tenant_id` from its own side. Catamorphic never references host tables.

## Observability

Every service call and sandbox operation is instrumented with `@opentelemetry/api` (spans like `workflow.run`, `project.deploy`, `sandbox.exec` with `catamorphic.*` attributes). Register your OpenTelemetry SDK in the host and the spans appear in your traces; without one they're no-ops. Injected sandbox providers are wrapped automatically.

## Lifecycle

- `catamorphic.migrate()` - apply pending schema-scoped migrations.
- `catamorphic.startExecutionWorker(options)` - explicitly start run processing when the host is ready. The returned handle exposes `done` and `stop()`; no worker starts implicitly.
- `catamorphic.redriveExecutionJob({ tenantId, jobId, availableAt? })` - explicitly redrive a failed run job.
- `catamorphic.close()` - stop workers started through this SDK instance and release resources catamorphic created (the pool, when booted from a connection string). Host-owned pools/Kysely instances are never touched.

## Relationship to other packages

- `@catamorphic/core` — pure, non-HTTP service layer. This SDK is the ergonomic facade over `CatamorphicCore` (available as `catamorphic.core`).
- `@catamorphic/fastify-plugin` — mountable Fastify plugin exposing the HTTP API; hand it `catamorphic.core`.
- `@catamorphic/db`, `@catamorphic/git`, `@catamorphic/sandbox` — building blocks, re-exported here for convenience (`createDatabase`, `migrateToLatest`, `FsBackend`, `ProjectManager`, providers).
