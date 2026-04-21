# Catamorphic Integration Guide

Catamorphic is **embed-first**. A host application (for example OpenCX) runs catamorphic services in-process against its own Postgres instance — all catamorphic tables live in one schema (default: `catamorphic`). Three integration surfaces are available, in increasing order of coupling:

1. **`@catamorphic/db` only** — run the migrations, let the host join against `catamorphic.projects` / `catamorphic.workflow_runs`. Read-only relationship. Useful for reporting / BI.
2. **`@catamorphic/sdk` (library-direct, recommended)** — host imports `createCatamorphic(...)` and calls resources in-process. Identity is bound per request via `cat.forTenant(orgId).forUser(userId)`. No sidecar process.
3. **`@catamorphic/server` + `@catamorphic/api-client`** — host runs the Fastify server out of process and talks to it over HTTP. Same backing services; useful when the host is non-Node or wants a network boundary.

The rest of this guide is organized: library-direct SDK first (most hosts want this), then the DB-only setup, then the HTTP path.

## Library-direct SDK

See [`packages/sdk/README.md`](packages/sdk/README.md) for the full usage guide. The short version:

```ts
// Boot, once per process
import { createDatabase } from "@catamorphic/db";
import { ProjectManager, FsBackend, FsRemoteBackend } from "@catamorphic/git";
import { DaytonaSandboxProvider } from "@catamorphic/sandbox";
import { createCatamorphic } from "@catamorphic/sdk";

export const catamorphic = createCatamorphic({
  db: createDatabase({
    connectionString: process.env.DATABASE_URL!,
    schema: "catamorphic",
  }),
  projectManager: new ProjectManager(
    new FsBackend(process.env.CATAMORPHIC_PROJECTS_PATH!),
    new FsRemoteBackend(process.env.CATAMORPHIC_REMOTES_PATH!),
  ),
  sandboxProvider: process.env.DAYTONA_API_KEY
    ? new DaytonaSandboxProvider({ apiKey: process.env.DAYTONA_API_KEY })
    : undefined,
});

// Per request
const scoped = catamorphic.forTenant(req.org.id).forUser(req.user.id);
const project = await scoped.projects.create({ name: "onboarding" });
await scoped.files.write(project.id, "src/welcome.ts", {
  content: welcomeTs,
  commitMessage: "Add welcome workflow",
});
```

### Identity mapping

- `tenantId` = host's org id. Maps 1:1 to `catamorphic.tenants(id)` and is upserted on first use — hosts never need to pre-register orgs with catamorphic.
- `externalUserId` = host's user id. Never persisted in catamorphic's DB; used only for (a) per-user git working directories via the `ProjectManager` and (b) git commit authorship.
- The host can freely `JOIN host.orgs.id = catamorphic.projects.tenant_id` for reports, analytics, cascading deletes, etc. Catamorphic never references host tables.

### v1 surface

Covered: project CRUD, workflow listing/fetching (parsed from project source), and file read/write (with optional commit). Not yet covered by the SDK: triggering runs, plugin + secret management, and git ops (deploy, pull, diff, conflict resolution) — those live on `cat.core.*` today and will land as SDK resources in phase 2.

## Database-only setup (just run the migrations)

Use the DB-only path when the host just wants to reach into catamorphic's schema (reporting, migrations) without running catamorphic services in-process or over HTTP.

### Local Setup (Using a Local Catamorphic Checkout)

Use this when you have both repos on your machine (example: `opencx` + local `catamorphic`).

### 1) Add local dependency in host backend

From host repo root:

```bash
pnpm -C backend add @catamorphic/db@file:/Users/you/workspace/catamorphic/packages/db
```

### 2) Build the local catamorphic db package once

The CLI binary points to `dist/cli.js`, so you must build locally:

```bash
cd /Users/you/workspace/catamorphic
bun run --filter @catamorphic/db build
```

### 3) Run migrations in host app

```bash
cd /Users/you/workspace/opencx
DATABASE_URL=postgres://postgres:postgres@localhost:5432/opencx \
CATAMORPHIC_DB_SCHEMA=catamorphic \
pnpm -C backend exec catamorphic-db migrate
```

### 4) Verify migration state

```bash
cd /Users/you/workspace/opencx
DATABASE_URL=postgres://postgres:postgres@localhost:5432/opencx \
CATAMORPHIC_DB_SCHEMA=catamorphic \
pnpm -C backend exec catamorphic-db status
```

### 5) Add helper scripts in host `backend/package.json`

```json
{
  "scripts": {
    "catamorphic:migrate": "cross-env DATABASE_URL=postgres://postgres:postgres@localhost:5432/opencx CATAMORPHIC_DB_SCHEMA=catamorphic catamorphic-db migrate",
    "catamorphic:status": "cross-env DATABASE_URL=postgres://postgres:postgres@localhost:5432/opencx CATAMORPHIC_DB_SCHEMA=catamorphic catamorphic-db status"
  }
}
```

Then you can run:

```bash
pnpm -C backend catamorphic:migrate
pnpm -C backend catamorphic:status
```

### Local update loop (after each catamorphic change)

When `@catamorphic/db` is installed via local `file:` dependency, run this every time you change catamorphic code:

1. Rebuild catamorphic db package:
   ```bash
   cd /Users/you/workspace/catamorphic
   bun run --filter @catamorphic/db build
   ```
2. Refresh the dependency in host backend:
   ```bash
   cd /Users/you/workspace/opencx
   pnpm -C backend add @catamorphic/db@file:/Users/you/workspace/catamorphic/packages/db
   ```
3. Restart host backend process.
4. If SQL migrations changed, run:
   ```bash
   pnpm -C backend catamorphic:migrate
   pnpm -C backend catamorphic:status
   ```

### Production Setup (Published Package)

Use this once `@catamorphic/db` is publicly published.

### 1) Install package in host backend

```bash
pnpm -C backend add @catamorphic/db
```

### 2) Set env vars in runtime/deploy environment

```bash
DATABASE_URL=postgres://<user>:<password>@<host>:5432/<database>
CATAMORPHIC_DB_SCHEMA=catamorphic
```

### 3) Run migrations as a one-time deploy step

```bash
DATABASE_URL="$DATABASE_URL" \
CATAMORPHIC_DB_SCHEMA="${CATAMORPHIC_DB_SCHEMA:-catamorphic}" \
pnpm -C backend exec catamorphic-db migrate
```

### 4) Optional gate/check

```bash
DATABASE_URL="$DATABASE_URL" \
CATAMORPHIC_DB_SCHEMA="${CATAMORPHIC_DB_SCHEMA:-catamorphic}" \
pnpm -C backend exec catamorphic-db status
```

## HTTP path — `@catamorphic/server` as a sidecar

When library-direct isn't possible (non-Node host, strict network boundary), run `@catamorphic/server` as a separate process. It accepts the same `CatamorphicCore` — wire it exactly like the SDK path and hand it to `createApp({ core, standalone: false })`. In embedded mode the server expects two headers on every request:

- `X-Catamorphic-Tenant-Id` — host org id
- `X-External-User-Id` — host user id

In standalone mode (`createApp({ core, standalone: true })`, what `packages/server/src/server.ts` uses for the local playground) missing headers fall back to built-in defaults.

The generated HTTP client lives in `@catamorphic/api-client`; construct it with `createCatamorphicClient({ baseUrl, fetch })` and set the headers on each call (or wrap `fetch` to inject them from your auth context).

## Plugin packages (workflow SDKs)

Catamorphic can attach external packages (for example workflow SDKs) to a project so workflows can `import` plugin exports.

In v1, plugins are resolved from a local directory configured in root `.env`:

```bash
CATAMORPHIC_LOCAL_PLUGINS_DIR=/Users/you/workspace/host-app/packages
```

Runtime summary:

1. Server loads attached plugins and secret values for the project.
2. Plugin files are mirrored into sandbox `node_modules/<packageName>/`.
3. Secrets are injected into the harness env for plugin runtime usage.
4. Agent and workflow-builder context include plugin README + d.ts.

For full details (manifest contract, REST API, service internals, runtime flow, troubleshooting, and resolver roadmap), use [`packages/plugins/README.md`](packages/plugins/README.md) as the canonical source.

## Operational Notes

- Do not auto-run migrations on every app boot; run them in CI/deploy or a one-shot job.
- You do not need to run a separate Catamorphic server process for this DB integration.
- Catamorphic uses strict `search_path = "catamorphic"` on its own DB connections and migration transactions.
- Unqualified names from Catamorphic cannot fall through to `public`; use explicit schema qualification when cross-schema access is intentional.
