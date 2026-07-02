# @catamorphic/server-sdk

The core SDK for embedding Catamorphic inside a host application's Node/Bun backend.

The host hands it a Postgres connection (or `pg.Pool`) and a storage location; catamorphic manages its own tables inside a dedicated schema (default `catamorphic`) and exposes projects, workflows, files, and execution. All identity (host org id, host user id) is scoped per request via `catamorphic.forTenant(orgId).forUser(userId)` — no sidecar HTTP server required.

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
```

### Per request — bind identity, then call resources

```ts
// req.org.id  — host's org id (becomes catamorphic.tenants.id)
// req.user.id — host's user id (used for per-user git working dirs + commit authorship)

const scoped = catamorphic
  .forTenant(req.org.id)
  .forUser(req.user.id);

const project = await scoped.projects.create({ name: "onboarding" });

await scoped.files.write(project.id, "src/welcome.ts", {
  content: welcomeTs,
  commitMessage: "Add welcome workflow",
});

const workflows = await scoped.workflows.list(project.id);
const graph = await scoped.workflows.get(project.id, "welcomeUser");
```

### Scoped-client surface

```ts
scoped.projects.create({ name, templateId? })
scoped.projects.list({ limit?, offset? })
scoped.projects.get(projectId)
scoped.projects.update(projectId, { name? })
scoped.projects.delete(projectId)

scoped.workflows.list(projectId)
scoped.workflows.get(projectId, workflowName, { ref? })

scoped.files.list(projectId)
scoped.files.read(projectId, path)
scoped.files.readAll(projectId)
scoped.files.write(projectId, path, { content, commitMessage? })
```

Runs, plugins, secrets, and git ops (deploy/pull/diff) are not on the scoped client yet. Hosts that need them today either (a) call `catamorphic.core.runs.*` / `catamorphic.core.plugins.*` directly or (b) mount `@catamorphic/fastify-plugin` and use `@catamorphic/api-client` — the HTTP surface covers everything.

## Identity model

- `tenantId` = host's org id. Auto-upserts `catamorphic.tenants(id)` on first project create, so hosts never need to pre-register orgs.
- `externalUserId` = host's user id. Never persisted in catamorphic's DB; used only for per-user git working directories and commit authorship.

Host can safely `JOIN host.orgs.id = catamorphic.projects.tenant_id` from its own side. Catamorphic never references host tables.

## Observability

Every service call and sandbox operation is instrumented with `@opentelemetry/api` (spans like `workflow.run`, `project.deploy`, `sandbox.exec` with `catamorphic.*` attributes). Register your OpenTelemetry SDK in the host and the spans appear in your traces; without one they're no-ops. Injected sandbox providers are wrapped automatically.

## Lifecycle

- `catamorphic.migrate()` — apply pending schema-scoped migrations.
- `catamorphic.close()` — release resources catamorphic created (the pool, when booted from a connection string). Host-owned pools/Kysely instances are never touched.

## Relationship to other packages

- `@catamorphic/core` — pure, non-HTTP service layer. This SDK is the ergonomic facade over `CatamorphicCore` (available as `catamorphic.core`).
- `@catamorphic/fastify-plugin` — mountable Fastify plugin exposing the HTTP API; hand it `catamorphic.core`.
- `@catamorphic/db`, `@catamorphic/git`, `@catamorphic/sandbox` — building blocks, re-exported here for convenience (`createDatabase`, `migrateToLatest`, `FsBackend`, `ProjectManager`, providers).
