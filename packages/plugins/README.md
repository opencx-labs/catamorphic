# @catamorphic/plugins

Manifest contract + resolver backends for **plugin packages** that Catamorphic
attaches to a project. Today that's only `@opencx/workflow-sdk`, but any npm
package can play as long as it ships the `catamorphic` manifest below.

Plugin SDKs may depend on `@catamorphic/workflow` and re-export only the
authoring primitives their host wants projects to use. Projects importing that
wrapper do not need a direct `@catamorphic/workflow` dependency.

This README is the authoritative reference for the whole plugin subsystem —
manifest format, DB schema, runtime plumbing, agent context injection, and the
troubleshooting scars we've collected so far. Update this file when anything
about the contract, the data flow, or the operational gotchas changes.

---

## Table of contents

1. [Goals and constraints](#goals-and-constraints)
2. [Architecture overview](#architecture-overview)
3. [Manifest contract](#manifest-contract)
4. [Database schema](#database-schema)
5. [Server services](#server-services)
6. [REST API](#rest-api)
7. [Sandbox runtime integration](#sandbox-runtime-integration)
8. [Agent context injection](#agent-context-injection)
9. [Playground UI](#playground-ui)
10. [Setup — local dev walkthrough](#setup--local-dev-walkthrough)
11. [Known issues & fixes](#known-issues--fixes)
12. [Future sources (npm / git)](#future-sources-npm--git)
13. [Related files](#related-files)

---

## Goals and constraints

- **Declarative.** A package opts in by adding a `catamorphic` field to its own
  `package.json`. No code changes in Catamorphic per plugin. No convention
  sniffing.
- **Isolated.** Plugin files live under the project's `node_modules/` inside
  the sandbox. Their env-var secrets are injected only into the run's process.
- **Source-agnostic.** v1 ships only `LocalPluginResolver`, but the
  `PluginResolver` interface is the seam for future `NpmPluginResolver` and
  `GitPluginResolver` backends. The DB `source` column is already widened to
  `'local' | 'npm' | 'git'` at the Zod layer.
- **LLM-aware.** The workflow builder model and the coding agent both see the
  attached plugin's README + `d.ts` so they don't hallucinate imports.

---

## Architecture overview

```
┌─────────────────────┐      catalog / attach / secrets      ┌──────────────────┐
│ Host frontend       │ ───────────────────────────────────▶ │  Fastify server  │
│  plugins-settings   │                                      │  (host-mounted)  │
└──────────┬──────────┘                                      │  plugin routes   │
           │ generateWorkflowCode(projectId)                 │  agent-context   │
           ▼                                                 │  run routes      │
┌─────────────────────┐    GET /api/projects/:id/agent-      │                  │
│ OpenAI (workflow    │ ◀────  context (prompt suffix)  ──── │                  │
│  builder prompt)    │                                      │                  │
└─────────────────────┘                                      └─────┬────────────┘
                                                                   │
                    Plugins + secrets per run                      │
                                                                   ▼
                                          ┌──────────────────────────────────────┐
                                          │ RunPluginsLoader                     │
                                          │  ├─ PluginsService  (DB ⇄ resolver)  │
                                          │  ├─ SecretsService  (DB, validation) │
                                          │  └─ LocalPluginResolver (disk)       │
                                          └────────┬─────────────────────────────┘
                                                   │ RunPluginPayload[] + env map
                                                   ▼
                           ┌─────────────────────────────────────────────────┐
                           │ RunExecutorImpl                                 │
                           │  uploadPluginPayloads → uploadFiles per plugin  │
                           │  merges secrets into `bun run harness.ts` env   │
                           └────────┬────────────────────────────────────────┘
                                    ▼
                           ┌─────────────────────────────────────────────────┐
                           │ Cloudflare / Daytona sandbox                    │
                           │   /workspace/project/                           │
                           │     harness.ts                                  │
                           │     src/untitled-workflow.ts                    │
                           │     node_modules/@opencx/workflow-sdk/…         │
                           └─────────────────────────────────────────────────┘
```

Two ways plugins flow into a run:

- **Files** — each plugin's `listPluginFiles()` result (manifest, `dist/`,
  `README.md`, ...) is mirrored into
  `<workspaceRoot>/project/node_modules/<packageName>/` inside the sandbox
  **before** the harness starts.
- **Secrets** — the project's saved secret values are merged into the env map
  passed to `bun run harness.ts`, where workflow code reads them via
  `process.env`.

The coding agent (Codex) gets a separate, persistent view of the same plugins:
docs are staged under `_plugins/<slug>/` in the dev sandbox and a preamble is
prepended to the initial system prompt.

---

## Manifest contract

Every plugin package declares itself via a reserved `catamorphic` field in its
own `package.json`. Catamorphic reads this field and **nothing else** — no
README scraping, no convention sniffing.

```jsonc
{
  "name": "@opencx/workflow-sdk",
  "version": "0.0.1",
  "catamorphic": {
    "displayName": "OpenCX",
    "description": "Trigger payloads and actions for OpenCX workflows.",
    "secrets": [
      {
        "name": "OPENCX_API_KEY",
        "label": "OpenCX API Key",
        "description": "Bearer token from the OpenCX dashboard (Settings > API Tokens).",
        "required": true
      },
      {
        "name": "OPENCX_API_URL",
        "label": "OpenCX API URL",
        "description": "Override the default base URL (https://api.open.cx).",
        "required": false,
        "default": "https://api.open.cx"
      }
    ],
    "docs": {
      "readme": "README.md",
      "types": "dist/index.d.ts"
    }
  }
}
```

Zod schema lives in `src/manifest.ts` — it is the single source of truth,
shared by the server (route validation) and resolver (manifest parsing).

### Fields

- `displayName` / `description` — what the dashboard shows in the attach
  picker and on the project plugin card.
- `secrets[]` — each entry renders as a password field on the project
  settings page.
  - `name` must be `SCREAMING_SNAKE_CASE` (it becomes an env var inside the
    sandbox).
  - `default` backs a secret when the user hasn't set one and `required` is
    `false`.
  - A run is blocked with `400 Missing required plugin secrets: …` if any
    `required: true` secret has no stored value.
- `docs.readme` / `docs.types` — paths **inside the package** that the coding
  agent stages into `_plugins/<pkg>/` in the dev sandbox and that
  `AgentContextService` inlines into the workflow-builder system prompt.
- `batch` — optional versioned source/sink capability metadata.
  `contractVersion` is currently `1`. Sources declare a stable ID, export name,
  host-or-sandbox execution location, supported consistency modes, and paths to
  config/item/cursor/snapshot JSON Schemas. Sinks declare the same identity and
  execution metadata plus result/state/artifact schema paths. These declarations
  extend the existing plugin flow; they do not create a separate registry or
  allow arbitrary workflow code to receive host credentials.

---

## Database schema

Migration `packages/db/migrations/007_plugins_and_secrets.sql`:

```sql
CREATE TABLE project_plugins (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  package_name  varchar(255) NOT NULL,
  source        varchar(20) NOT NULL DEFAULT 'local',
  created_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, package_name),
  CONSTRAINT chk_plugin_source CHECK (source IN ('local'))
);
CREATE INDEX idx_project_plugins_project ON project_plugins(project_id);

CREATE TABLE project_secrets (
  project_id    uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          varchar(255) NOT NULL,
  value         text NOT NULL,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (project_id, name)
);
CREATE INDEX idx_project_secrets_project ON project_secrets(project_id);
```

Notes:

- `source` is a CHECK-constrained string today but the Zod schema accepts
  `'local' | 'npm' | 'git'`. Widen the CHECK when a new resolver lands.
- Values in `project_secrets.value` are **plaintext** for v1. Encryption at
  rest is a follow-up; wrap `SecretsService.upsert()` / `list()` when that
  lands.
- Secret names are validated against the attached plugin's manifest in the
  application layer (`SecretsService.upsert()` rejects undeclared names with
  `UndeclaredSecretError`). The DB has no FK to enforce this.

---

## Server services

Everything lives in `packages/core/src/services/`.

### `PluginsService`

Bridges `PluginResolver` (disk / registry / …) with the `project_plugins`
table.

- `listCatalog()` — `resolver.list()` mapped to `PluginInfo[]` (manifest
  fields + `packageName`, `version`, `source`). Used by the catalog picker.
- `listAttached(projectId)` — DB rows joined with fresh resolver metadata.
  Drops rows whose package can no longer be resolved (disk removed, etc.).
- `attach(projectId, packageName)` — validates the package is resolvable,
  inserts into `project_plugins`, returns the manifest.
- `detach(projectId, packageName)` — deletes the row.
- `loadAttachedResolved(projectId)` — returns `ResolvedPlugin[]` (not just
  `PluginInfo`) so callers that need to read files get the `rootDir`
  too. Used by `RunPluginsLoader` and `AgentContextService`.
- `getDeclaredSecrets(projectId)` — union of every attached plugin's
  declared secrets; `SecretsService` uses this to reject undeclared names.

### `SecretsService`

Owns `project_secrets`.

- `list(projectId)` — returns `SecretStatus[]`:
  `{ name, declaredBy, label, description, required, default, hasValue }`.
  Never returns the plaintext value.
- `upsert(projectId, name, value)` — validates `name` is declared by at least
  one attached plugin, then `ON CONFLICT (project_id, name) DO UPDATE`.
- `delete(projectId, name)` — drops the row.
- `loadForRun(projectId)` — resolves every declared secret, applying
  `default` when the row is missing. Returns
  `{ values: Record<string, string>, missingRequired: string[] }`. The
  playground route 400s on any missing required.

### `RunPluginsLoader`

Produces the payload snapshot for a single run.

```ts
class RunPluginsLoader {
  async load(projectId: string): Promise<{
    plugins: RunPluginPayload[];       // packageName + files map
    secrets: Record<string, string>;
    missingRequiredSecrets: string[];
  }>;
}
```

Composes `PluginsService.loadAttachedResolved()` + `resolver.listPluginFiles()`
+ `SecretsService.loadForRun()`. The executor is kept ignorant of
`PluginResolver` / DB so it can be unit-tested with a fake provider.

### `AgentContextService`

Builds the LLM-ready system prompt suffix for the workflow-builder.

```ts
await agentContextService.buildPrompt(projectId);
// →
// <attached_packages>
// The following NPM packages are attached to this project and installed at
// runtime. They are available to import from workflows and steps. Use their
// exported functions and types; do NOT invent new names.
//
// ## @opencx/workflow-sdk (OpenCX)
// Trigger payloads and actions for OpenCX workflows.
//
// ### README
// <full README.md body>
//
// ### Types (dist/index.d.ts)
// ```typescript
// <full d.ts>
// ```
// </attached_packages>
```

No truncation in v1; workflow SDKs are expected to ship a curated surface.
Revisit if a plugin ships a 100 KB d.ts.

---

## REST API

All routes are registered by `registerPluginRoutes()` in
`packages/fastify-plugin/src/routes/plugins.ts` and gated by the presence of the
`PluginsService` / `SecretsService` / `AgentContextService` in `AppConfig`
(missing service → `503 Plugins not configured`).

| Method | URL                                                 | Purpose                                  |
|--------|-----------------------------------------------------|------------------------------------------|
| GET    | `/api/plugins/catalog`                              | All plugins visible to the host         |
| GET    | `/api/projects/:projectId/plugins`                  | Attached plugins (+ fresh manifest)      |
| POST   | `/api/projects/:projectId/plugins`                  | Attach `{ packageName }`                 |
| DELETE | `/api/projects/:projectId/plugins/:packageName`     | Detach                                   |
| GET    | `/api/projects/:projectId/secrets`                  | Declared secrets + `hasValue`            |
| PUT    | `/api/projects/:projectId/secrets/:name`            | Upsert `{ value }`                       |
| DELETE | `/api/projects/:projectId/secrets/:name`            | Clear a stored value                     |
| GET    | `/api/projects/:projectId/agent-context`            | `{ systemPromptSuffix: string }`         |

`fastifyCors` is configured with an explicit method list
(`GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS`) — the default reflect logic
was leaving `PUT` and `DELETE` off the preflight response and breaking the
secrets UI.

---

## Sandbox runtime integration

### Upload layout

For every attached plugin, the server builds a `RunPluginPayload`:

```ts
interface RunPluginPayload {
  packageName: string;                     // "@opencx/workflow-sdk"
  files: Record<string, string>;           // relative path → utf8 contents
}
```

`uploadPluginPayloads()` in `packages/sandbox/src/run-executor.ts` mirrors
each payload under:

```
<provider.workspaceRoot>/project/node_modules/<packageName>/
```

For `@opencx/workflow-sdk` on the Cloudflare provider that's
`/workspace/project/node_modules/@opencx/workflow-sdk/`.

`listPluginFiles()` skips `node_modules`, `.git`, `.turbo`, `src`, and
`__tests__` — we upload the built artifacts (`dist/`, `package.json`,
`README.md`, ...), not the source. If `dist/` isn't present the plugin is
unusable; building on the host before attach is the operator's job.

### Secret injection

`ExecuteRunOpts.secrets` is merged with the built-in `CATAMORPHIC_*` env vars
and passed through `SandboxProvider.executeCommand` environment options:

```ts
const env = {
  CATAMORPHIC_RUN_ID,
  CATAMORPHIC_WORKFLOW_NAME,
  CATAMORPHIC_WORKFLOW_FILE,
  CATAMORPHIC_TRIGGER_DATA,
  ...opts.secrets,          // OPENCX_API_KEY, OPENCX_API_URL, …
};
```

Secret declarations may not use the reserved `CATAMORPHIC_` prefix. Test and
production secret values are stored separately and the executor receives only
the values for the run's mode.

### Execution flow

`RunExecutorImpl.executeRun()`:

1. Receives a prepared production sandbox or disposable test directory.
2. Uploads the canonical runtime harness.
3. `uploadPluginPayloads()` writes individual plugin files under
   `node_modules/<pkg>/`.
4. Calls `executeCommand("bun run harness.ts", { cwd, env, timeout })`.
5. Parses the `CATAMORPHIC_REPORT:` marker from stdout.
6. Core transactionally persists terminal state and awaits cleanup.

---

## Agent context injection

Two LLMs need to know what's attached:

### 1. Workflow-builder (host-side OpenAI call)

The host app owns the workflow-builder prompt. Its flow:

- Hits `GET /api/projects/:projectId/agent-context` on the mounted
  `@catamorphic/fastify-plugin` (via `@catamorphic/api-client`).
- Concatenates the returned `systemPromptSuffix` after the base builder
  prompt. If the fetch fails or returns empty the call continues without
  context (the agent is still usable, just blind to attached packages).

Before this wiring the builder was a pure OpenAI call with a hardcoded
system prompt, which is exactly why early demos hallucinated SDK calls.

### 2. Coding agent (`CodingAgentProvider` implementations - `@catamorphic/ai-sdk`, `@catamorphic/codex`)

`startSession({ attachedPlugins })` on every provider:

- The shared staging helpers (`stagedPluginFiles` / `stagePluginDocs` in
  `packages/sandbox/src/coding-agent/plugin-staging.ts`) write each plugin's
  README + d.ts into `<workingDirectory>/_plugins/<slug>/` inside the dev
  sandbox, where the agent can read them directly.
- `buildPluginsPreamble()` generates a Markdown block listing each plugin
  and the absolute on-disk path of its staged docs.
- The preamble is prepended to the first message passed to
  `thread.runStreamed()`.

---

## Host UI

The shadcn registry item `plugins-settings` (installed into the host via
`npx shadcn add ./node_modules/@catamorphic/registry/dist/r/plugins-settings.json`)
renders:

- **Catalog list** — fetched once via `GET /api/plugins/catalog`. "Add"
  button POSTs to `/api/projects/:id/plugins`.
- **Attached list** — for each attached plugin, an `AttachedPluginCard`
  with:
  - Detach button.
  - One `SecretField` per declared secret. Each field shows `hasValue`
    state, and on save PUTs to `/api/projects/:id/secrets/:name`.

Mounted inside the host's project page.

---

## Setup — local dev walkthrough

End-to-end steps to go from zero to a workflow that calls the OpenCX API.

### 1. Env vars (root `.env` of catamorphic)

```bash
# Enables the local plugin resolver. Point at any directory whose immediate
# subdirectories are plugin packages (each with a `package.json` that carries
# a `catamorphic` field).
CATAMORPHIC_LOCAL_PLUGINS_DIR=/Users/you/Workspace/opencx/dashboard/packages

# Cloudflare sandbox (production bridge or local wrangler)
CLOUDFLARE_SANDBOX_API_URL=https://catamorphic-sandbox-bridge-dev.opencx.workers.dev
CLOUDFLARE_SANDBOX_API_KEY=…

# OpenAI for the workflow builder
OPENAI_API_KEY=…
```

The host process (e.g. OpenCX's backend) owns the env. `CATAMORPHIC_LOCAL_PLUGINS_DIR`
must be set in the host's `.env`, not inside the catamorphic repo — catamorphic is
embed-only and has no dev server of its own.

### 2. Build the plugin package

`LocalPluginResolver` does not run a build for you. For `@opencx/workflow-sdk`:

```bash
cd opencx/dashboard/packages/workflow-sdk
pnpm build        # produces dist/index.cjs, .mjs, .d.ts
```

### 3. Run migrations for `project_plugins` + `project_secrets`

```bash
cd catamorphic
bun run --filter @catamorphic/db build
pnpm -C backend exec catamorphic-db migrate   # from the host repo
```

### 4. Start the host

Boot the host app with `CATAMORPHIC_ENABLED=true` + the env vars above so
`@catamorphic/fastify-plugin` mounts inside it. For OpenCX: `cd opencx/backend && pnpm ddev`.

### 5. Attach the plugin and set secrets

1. Open a project in the host's Catamorphic UI.
2. Scroll to **Plugins**. `@opencx/workflow-sdk` shows up in the catalog.
3. Click **Add**.
4. Expand the attached card. Enter `OPENCX_API_KEY` (a real bearer from
   `Settings → API Tokens` in the OpenCX dashboard).
5. For local development, override `OPENCX_API_URL` — see below.

### 6. Point the SDK at the right backend

`@opencx/workflow-sdk` defaults to `https://api.open.cx`. That host is
OpenCX's production gateway and does **not** expose the `/contacts/:id`
public route (you'll get `404 Route GET:/contacts/… not found`).

For local development you want your own backend. Options:

- **Cloudflare sandbox → your machine.** The workflow runs inside a
  Cloudflare Worker and can't reach `localhost`. Run a tunnel:

  ```bash
  cloudflared tunnel --url http://localhost:8080
  # or: ngrok http 8080
  ```

  Set `OPENCX_API_URL` in the project's secrets to the tunnel URL (no
  trailing slash).

- **Staging.** Point `OPENCX_API_URL` at a staging backend that actually
  serves the public API.

Sanity check the URL from your machine before trusting it:

```bash
curl -s -H "Authorization: Bearer $OPENCX_API_KEY" \
  "$OPENCX_API_URL/contacts/<uuid>" | jq .
```

### 7. Run the workflow

Ask the workflow builder to generate code. It has the SDK's README + d.ts in
its system prompt, so it should import symbols that actually exist:

```ts
const { getContactDetails } = await import("@opencx/workflow-sdk");
const contact = await getContactDetails({ contactId });
```

Hit **▶ Run**. Expected path:

```
POST /api/projects/:id/workflows/:name/test-runs
  (RunPluginsLoader builds test payloads + env)
  ↓
Cloudflare sandbox
  /workspace/project/node_modules/@opencx/workflow-sdk/dist/index.mjs
  /workspace/project/src/untitled-workflow.ts
  bun run harness.ts   OPENCX_API_KEY=… OPENCX_API_URL=…
    → fetch(`${OPENCX_API_URL}/contacts/<uuid>`, { headers: { authorization } })
```

---

## Known issues & fixes

### 1. `%40` scoped packages in the Cloudflare sandbox

**Symptom.** Workflow throws
`ResolveMessage: Cannot find module '@opencx/workflow-sdk' from '/workspace/project/src/…'`
even though upload returned `200 OK`.

**Root cause.** `CloudflareSandboxProvider.buildFileRoute()` used to run
each path segment through `encodeURIComponent`, which turns `@opencx` into
`%40opencx`. The bridge writes the decoded URL segment to disk verbatim
and does **not** URL-decode, so the directory actually created on disk was
`node_modules/%40opencx/workflow-sdk/`. Bun's resolver walks up looking for
`@opencx` and never finds it.

Reproduced by uploading a scoped package and `ls -la node_modules/` — the
dir name was literally `%40opencx`.

**Fix.** `encodePathSegment()` now decodes `%40` back to `@` after running
`encodeURIComponent`. `@` is a valid `pchar` per RFC 3986 so the URL stays
well-formed. See `packages/cloudflare/src/sandbox-provider.ts` and the
"keeps `@` un-encoded for scoped package paths" test in
`sandbox-provider.test.ts`.

### 2. Production base URL 404s

**Symptom.** `OpenCX GET /contacts/<uuid> failed (404): Route GET:/contacts/… not found`.

**Root cause.** SDK defaults to `https://api.open.cx`, which is OpenCX's
production gateway and doesn't mount the public API used by `getContactDetails`
(or at least not at the path the SDK expects).

**Fix.** Override `OPENCX_API_URL` in the project's secrets. For local dev
tunnel your local `:8080` and point the var at the tunnel URL. See
[Setup step 6](#6-point-the-sdk-at-the-right-backend).

### 3. CORS preflight dropped PUT / DELETE

**Symptom.** Saving a secret in the UI printed `Failed to fetch`; server
log showed the preflight `OPTIONS` at 200 but never a `PUT`.

**Root cause.** `fastifyCors`'s default reflected the request's
`Access-Control-Request-Method` but didn't list `PUT` / `DELETE` in
`Access-Control-Allow-Methods` for the browser.

**Fix.** Explicit method list in `packages/fastify-plugin/src/app.ts`:

```ts
app.register(fastifyCors, {
  origin: true,
  methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
});
```

### 4. `.env` location for `bun --env-file`

**Symptom.** After setting `CATAMORPHIC_LOCAL_PLUGINS_DIR=...` the Plugins
panel kept returning `503 Plugins not configured`.

**Root cause.** The env var wasn't present in the **host process's**
environment — catamorphic runs in-process inside the host, so only the host's
env matters.

**Fix.** Put the env var in the host's `.env`, restart the host.

### 5. Workflow builder hallucinating SDK calls

**Symptom.** AI-generated workflow invented functions like
`opencx.getContactByUUID()` that don't exist.

**Root cause.** `generateWorkflowCode` was a standalone OpenAI call from
the Next.js server action, completely bypassing `CodexAgent`'s plugin
context. The model had never seen the SDK's d.ts.

**Fix.** New `AgentContextService` + `GET /api/projects/:id/agent-context`
endpoint. Server action fetches the suffix and prepends it to the system
prompt. See [Agent context injection](#agent-context-injection).

---

## Future sources (npm / git)

`LocalPluginResolver` implements the `PluginResolver` interface. The same
interface is the hook for upcoming backends:

- **`NpmPluginResolver`** — fetch tarballs from npmjs.com (or a private
  registry), cache them on disk, read the `catamorphic` field from the
  unpacked `package.json`. Enables production use where the operator
  can't mount a filesystem.
- **`GitPluginResolver`** — clone / pull from a Git URL, optionally
  pinning to a ref. Useful for internal packages that aren't published.

When we add either:

1. Widen the `chk_plugin_source` CHECK constraint in migration
   `007_plugins_and_secrets.sql`.
2. Update the `source` column on `project_plugins` write paths
   (`PluginsService.attach`).
3. Pick the right resolver in the host's boot code based on env
   (`CATAMORPHIC_PLUGIN_SOURCE=local|npm|git`) or run a
   `CompositeResolver` that tries multiple backends in order.

---

## Related files

Quick index — every file that participates in the plugin subsystem.

**Plugin package (this):**
- `packages/plugins/src/manifest.ts` — Zod schemas.
- `packages/plugins/src/resolver.ts` — `LocalPluginResolver`.
- `packages/plugins/src/index.ts` — public re-exports.
- `packages/plugins/src/__tests__/` — unit tests.

**Server:**
- `packages/core/src/services/plugins-service.ts` — DB ⇄ resolver bridge.
- `packages/core/src/services/secrets-service.ts` — per-project secret store.
- `packages/core/src/services/run-plugins-loader.ts` — per-run snapshot.
- `packages/core/src/services/agent-context-service.ts` — LLM prompt builder.
- `packages/fastify-plugin/src/routes/plugins.ts` — REST routes.
- `packages/fastify-plugin/src/routes/playground.ts` — calls `RunPluginsLoader`.
- `packages/fastify-plugin/src/app.ts` — CORS + route registration.
- `packages/fastify-plugin/src/schemas.ts` — shared Zod DTOs.
- Host boot code (e.g. OpenCX's `backend/src/catamorphic/boot.ts`) — wires resolver + services from env.

**Sandbox:**
- `packages/sandbox/src/run-executor.ts` — `uploadPluginPayloads`, env merge.
- `packages/cloudflare/src/sandbox-provider.ts` — scoped-package upload fix.
- `packages/sandbox/src/coding-agent/codex-agent.ts` — staging + preamble.
- `packages/sandbox/src/coding-agent/types.ts` — `AttachedPluginForAgent`.
- `packages/sandbox/src/__tests__/run-executor.test.ts` — upload + env tests.
- `packages/sandbox/src/__tests__/codex-agent-plugins.test.ts` — preamble tests.
- `packages/cloudflare/src/__tests__/sandbox-provider.test.ts` — `@` encoding test.

**Database:**
- `packages/db/migrations/007_plugins_and_secrets.sql` — tables.
- `packages/db/src/generated/db.ts` — generated Kysely types.

**Host UI (shadcn registry items):**
- `packages/registry/src/plugins-settings/plugins-settings.tsx` — settings
  UI, installed into the host via `shadcn add`. Consumes hooks from
  `@catamorphic/react` and talks to `@catamorphic/fastify-plugin` through
  `@catamorphic/api-client`.

**Plugin example (outside this repo):**
- `opencx/dashboard/packages/workflow-sdk/package.json` — `catamorphic` field.
- `opencx/dashboard/packages/workflow-sdk/src/actions/` — step functions the
  SDK exposes.
- `opencx/dashboard/packages/workflow-sdk/src/client.ts` — `rpc()` wrapper
  that reads `OPENCX_API_KEY` / `OPENCX_API_URL` from `process.env`.
