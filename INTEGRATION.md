# Catamorphic Integration Guide

Catamorphic can run inside another application using that app's Postgres database.
All Catamorphic tables live in one schema (default: `catamorphic`).

## Local Setup (Using a Local Catamorphic Checkout)

Use this when you have both repos on your machine (example: `opencx` + local `catamorphic`).

### 1) Add local dependency in host backend

From host repo root:

```bash
pnpm -C backend add @catamorphic/db@file:/Users/omarramadan/Workspace/catamorphic/packages/db
```

### 2) Build the local catamorphic db package once

The CLI binary points to `dist/cli.js`, so you must build locally:

```bash
cd /Users/omarramadan/Workspace/catamorphic
bun run --filter @catamorphic/db build
```

### 3) Run migrations in host app

```bash
cd /Users/omarramadan/Workspace/opencx
DATABASE_URL=postgres://postgres:postgres@localhost:5432/opencx \
CATAMORPHIC_DB_SCHEMA=catamorphic \
pnpm -C backend exec catamorphic-db migrate
```

### 4) Verify migration state

```bash
cd /Users/omarramadan/Workspace/opencx
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
   cd /Users/omarramadan/Workspace/catamorphic
   bun run --filter @catamorphic/db build
   ```
2. Refresh the dependency in host backend:
   ```bash
   cd /Users/omarramadan/Workspace/opencx
   pnpm -C backend add @catamorphic/db@file:/Users/omarramadan/Workspace/catamorphic/packages/db
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

Catamorphic attaches external packages — things like `@opencx/workflow-sdk` —
to a project so workflows can `import` their triggers and actions.

v1 resolves plugins from a local directory on the host (root `.env`, not
`packages/server/.env` — `bun dev` loads env from the monorepo root):

```bash
CATAMORPHIC_LOCAL_PLUGINS_DIR=/Users/you/Workspace/opencx/dashboard/packages
```

At run time the server:

1. Loads the project's attached plugins from `project_plugins`.
2. Reads every file from each plugin's directory (skipping `src/`,
   `node_modules/`, `.git`, `.turbo`, `__tests__/`).
3. Uploads them into `<workspaceRoot>/project/node_modules/<packageName>/`
   inside the sandbox before invoking `bun run harness.ts`.
4. Merges the project's saved secrets (from `project_secrets`) into the
   harness env so the SDK can read `process.env.OPENCX_API_KEY` etc.

The coding agent and the workflow-builder LLM both receive the plugin's
README + `dist/index.d.ts` in their system prompt so they stop
hallucinating SDK calls.

The full reference — manifest contract, DB schema, REST API, runtime flow,
agent context injection, troubleshooting (scoped-package URL encoding,
`OPENCX_API_URL` base URL, CORS, etc.), and the plan for npm / git
resolvers — lives in
[`packages/plugins/README.md`](packages/plugins/README.md). Read that first
when touching anything plugin-related.

## Operational Notes

- Do not auto-run migrations on every app boot; run them in CI/deploy or a one-shot job.
- You do not need to run a separate Catamorphic server process for this DB integration.
- Catamorphic uses strict `search_path = "catamorphic"` on its own DB connections and migration transactions.
- Unqualified names from Catamorphic cannot fall through to `public`; use explicit schema qualification when cross-schema access is intentional.
