# Catamorphic Integration Guide

Catamorphic can run inside another application using that app's Postgres database.
All Catamorphic tables live in one schema (default: `catamorphic`).

## Local Setup (Using a Local Catamorphic Checkout)

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

## Production Setup (Published Package)

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
