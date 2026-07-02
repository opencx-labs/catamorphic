---
name: using-catamorphic
description: Embed Catamorphic (code-first workflow builder) inside a host app. Use when integrating the @catamorphic/server-sdk, @catamorphic/fastify-plugin, @catamorphic/db, @catamorphic/api-client, @catamorphic/react, or @catamorphic/ui packages, wiring the CatamorphicProvider, mounting the WorkflowEditor canvas, booting the SDK with Postgres + git + sandbox, or when the user mentions catamorphic, workflow editor, workflow canvas, tenant id, external user id, or embedding catamorphic.
---

# Using Catamorphic

Catamorphic is an **embeddable** code-first workflow builder. The host app owns auth, users, orgs, and the Postgres database. Catamorphic supplies:

- a **backend SDK** (`@catamorphic/server-sdk`) for in-process project/workflow/file CRUD + execution
- a **mountable Fastify plugin** (`@catamorphic/fastify-plugin`) exposing the HTTP API
- **headless React bindings** (`@catamorphic/react`) for data hooks + jotai atoms
- a **drop-in editor UI** (`@catamorphic/ui`) rendered with React Flow
- a **typed HTTP client** (`@catamorphic/api-client`) for frontends and non-Node backends
- a **migration CLI + Kysely instance** (`@catamorphic/db`) for the schema

Everything is scoped by a `tenantId` (= host org id) and an `externalUserId` (= host user id). Catamorphic never references host tables.

## Pick an Integration Path

Choose **one** backend integration; the React/UI layer is the same in both.

| Path | Use When | Packages |
| --- | --- | --- |
| **Library-direct (recommended)** | Host is Node/Bun and can import catamorphic in-process | `@catamorphic/server-sdk` (re-exports db/git/sandbox building blocks) |
| **HTTP** | Frontend needs the API, host is non-Node, or wants a network boundary | Register `catamorphicPlugin` from `@catamorphic/fastify-plugin` on the host's Fastify server (or run `createApp` as a sidecar); consume via `@catamorphic/api-client` |
| **DB-only (reporting)** | Host just needs to JOIN against catamorphic tables | `@catamorphic/db` migrations only |

Frontend is always `@catamorphic/react` (+ optionally `@catamorphic/ui`) talking through `@catamorphic/api-client` to whichever backend surface is live.

## Identity Model (Read This First)

Every scoped call needs two ids:

- **`tenantId`** — host's org id. Auto-upserts `catamorphic.tenants(id)` on first use. Host can safely `JOIN host.orgs.id = catamorphic.projects.tenant_id`.
- **`externalUserId`** — host's user id. Never persisted; used only for per-user git working dirs + git commit authorship.

In the SDK this is bound via `cat.forTenant(orgId).forUser(userId)`. Over HTTP it is sent as two headers on **every** request:

- `X-Catamorphic-Tenant-Id`
- `X-External-User-Id`

Never hardcode these; always pull from the host's auth context.

## Backend Path A — Library-Direct SDK

Install (workspace/local — see `Local Dev Linking` below for file: installs):

```bash
pnpm add @catamorphic/server-sdk
```

### 1) Boot the SDK at process start

```ts
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { createCatamorphic, LocalPluginResolver } from "@catamorphic/server-sdk";

export const catamorphic = createCatamorphic({
  // { pool } (host-owned), { connectionString } (catamorphic-owned), or { db }.
  // Tables live in the `catamorphic` schema either way (override with `schema`).
  database: { pool: hostPgPool },
  storage: {
    projectsPath: process.env.CATAMORPHIC_PROJECTS_PATH!,
    remotesPath: process.env.CATAMORPHIC_REMOTES_PATH!,
  },
  // Optional — only needed for run execution. Backends are vendor plugin
  // packages: @catamorphic/cloudflare (default) or @catamorphic/daytona.
  sandboxProvider: new CloudflareSandboxProvider({
    apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
    apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
  }),
  // Optional — only needed for plugin attachment + secrets.
  pluginResolver: process.env.CATAMORPHIC_LOCAL_PLUGINS_DIR
    ? new LocalPluginResolver(process.env.CATAMORPHIC_LOCAL_PLUGINS_DIR)
    : undefined,
});
```

Catamorphic never destroys host-owned pools/Kysely instances; `catamorphic.close()` only closes what it created.

### 2) Run migrations

Idempotent and schema-scoped. Programmatically:

```ts
await catamorphic.migrate();
```

Or via CLI in a deploy step:

```bash
DATABASE_URL=postgres://... \
CATAMORPHIC_DB_SCHEMA=catamorphic \
pnpm exec catamorphic-db migrate
```

### 3) Per-request: bind identity, call resources

```ts
const scoped = catamorphic.forTenant(req.org.id).forUser(req.user.id);

// Projects
await scoped.projects.create({ name: "onboarding" });
await scoped.projects.list({ limit: 20 });
await scoped.projects.get(projectId);
await scoped.projects.update(projectId, { name: "renamed" });
await scoped.projects.delete(projectId);

// Files (content-addressed, commit-on-write)
await scoped.files.list(projectId);
await scoped.files.read(projectId, "src/welcome.ts");
await scoped.files.readAll(projectId);
await scoped.files.write(projectId, "src/welcome.ts", {
  content: source,
  commitMessage: "Add welcome workflow",
});

// Workflows (parsed on read from project source)
await scoped.workflows.list(projectId);
await scoped.workflows.get(projectId, "welcomeUser", { ref: "HEAD" });
```

Anything not covered by the scoped-client surface (runs, plugins, secrets, deploy/pull/diff) is reachable via `catamorphic.core.runs.*`, `catamorphic.core.plugins.*`, `catamorphic.core.deployment.*`, etc. — these take `identity` as their first argument (build it yourself: `{ tenantId, externalUserId }`).

### 4) Triggering runs

`core.runs.trigger(identity, projectId, workflowName, { triggerData })` is the one entry point that actually executes a workflow. It:

1. Resolves the project for `identity.tenantId`.
2. Opens the per-user dev working copy, calls `readAllFiles()` + `resolveRef("HEAD")`, then disposes.
3. Loads attached plugin payloads + project secrets via `runPluginsLoader` (only if `pluginResolver` was wired at boot).
4. Inserts a `workflow_runs` row (`status: 'running'`, `commit_sha: headSha`, `is_test: false`).
5. Hands off to `PlaygroundExecutor` which spawns a sandbox, uploads files + plugins, runs `bun run harness.ts`, and parses the `CATAMORPHIC_REPORT:` line.
6. Updates the run row and bulk-inserts `workflow_run_steps`, then returns the mapped `Run`.

It requires `sandboxProvider` at boot — without it the method throws `SandboxProviderNotConfiguredError`. Other typed errors: `ProjectNotFoundError`, `WorkflowNotFoundError` (pre-flight check on files), `PluginSecretsMissingError` (when attached plugins declare required secrets the project hasn't set).

Over HTTP the same path is `POST /api/projects/:projectId/workflows/:name/runs` with body `{ triggerData?: Record<string, unknown> }`, which `useTriggerWorkflowRun` (and the `runs-panel` registry item) already calls.

## Backend Path B — HTTP via the Fastify plugin

Register `catamorphicPlugin` on the host's own Fastify server with the exact same `CatamorphicCore`:

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, {
  core: catamorphic.core,
  prefix: "/api", // the generated api-client expects /api
});
```

The plugin is encapsulated (its Zod compilers + error handler don't leak) and registers no CORS — the host owns cross-origin policy. For a sidecar process, `createApp({ core })` returns a complete Fastify app (CORS + Swagger UI at `/docs`, plugin at `/api`):

```ts
import { createApp } from "@catamorphic/fastify-plugin";

const app = createApp({ core: catamorphic.core });
await app.listen({ port: 8500, host: "0.0.0.0" });
```

Every route requires `X-Catamorphic-Tenant-Id` and `X-External-User-Id` — there are no defaults. Set them server-side from the host's verified auth context.

The host consumes the server via the generated client:

```ts
import { createApiClient } from "@catamorphic/api-client";

export const apiClient = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_CATAMORPHIC_URL!,
  fetch: async (input, init) => {
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    headers.set("X-Catamorphic-Tenant-Id", currentOrgId());
    headers.set("X-External-User-Id", currentUserId());
    return fetch(input, { ...init, headers });
  },
});
```

**Important**: when `input` is a `Request` (as produced by openapi-fetch), seed the `Headers` from `input.headers` before overriding — otherwise `Content-Type: application/json` is dropped and Fastify returns 415.

Type-safe calls go through `apiClient.GET("/projects", …)` etc. For paths openapi-fetch can't template (Fastify wildcards), use `apiClient.fetch(apiClient.baseUrl + "/…")`.

## Frontend — `@catamorphic/react` + `@catamorphic/ui`

Peer deps: `react ^18.2 || ^19`, `react-dom ^18.2 || ^19`, `@tanstack/react-query ^5`.

### 1) Mount `CatamorphicProvider` at the root

```tsx
"use client";
import { createApiClient } from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { staleTime: 5_000, refetchOnWindowFocus: false },
  },
});

const apiClient = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_CATAMORPHIC_URL!,
  fetch: async (input, init) => {
    const headers = new Headers(
      input instanceof Request ? input.headers : init?.headers,
    );
    headers.set("X-Catamorphic-Tenant-Id", orgId);
    headers.set("X-External-User-Id", userId);
    return fetch(input, { ...init, headers });
  },
});

export function Providers({ children }) {
  return (
    <CatamorphicProvider apiClient={apiClient} queryClient={queryClient}>
      {children}
    </CatamorphicProvider>
  );
}
```

The provider is the **only** thing the React hooks depend on. If `queryClient` is omitted the provider creates one internally (fine for isolated demos; share one in real apps).

### 2) Data hooks — `@catamorphic/react`

All hooks are TanStack Query wrappers over `@catamorphic/api-client`. They throw if used outside `CatamorphicProvider`. Errors are surfaced as a typed `CatamorphicError` (see "Error handling" below).

```tsx
import {
  // Projects + workflows + files
  useCreateProject,
  useDeleteProject,
  useProject,
  useProjectFile,
  useProjectFiles,
  useProjects,
  useTemplates,
  useUpdateProject,
  useWorkflow,
  useWorkflows,
  useWriteProjectFile,
  // Runs
  useWorkflowRuns,
  useWorkflowRun,
  useTriggerWorkflowRun,
  useCancelWorkflowRun,
  // Git
  useProjectGit,
  useProjectBranches,
  useProjectCommits,
  useProjectConflicts,
  useCreateBranch,
  useCheckoutBranch,
  useCommitChanges,
  useDeployProject,
  useProjectGitState, // composite hook for multi-branch draft persistence
  // Plugins
  usePluginCatalog,
  useProjectPlugins,
  useAttachPlugin,
  useDetachPlugin,
  // Secrets
  useProjectSecrets,
  useUpsertProjectSecret,
  useDeleteProjectSecret,
  // Agent (coding sessions)
  useAgentSessions,
  useAgentSession,
  useCreateAgentSession,
  useSendAgentMessage,
  // Parsing (for `<WorkflowEditor onParse={...}>`)
  useOnParse, // ready-made onParse callback — prefer this
  useParseWorkflow, // raw mutation over POST /api/playground/parse, for custom assembly
} from "@catamorphic/react";
```

OpenAPI-derived domain types live behind a single barrel — import them once and you're guaranteed shape parity with the server:

```ts
import type {
  Project,
  ProjectSummary,
  Run,
  RunDetail,
  RepoStatus,
  BranchInfo,
  CommitInfo,
  ConflictEntry,
  PluginInfo,
  Secret,
  AgentSession,
} from "@catamorphic/react/types";
```

#### Error handling

All hooks reject with `CatamorphicError`, a discriminated envelope keyed off `error.code` instead of fragile substring matching of `error.message`:

```ts
import {
  CatamorphicError,
  isCatamorphicError,
} from "@catamorphic/react";

try {
  await deploy.mutateAsync();
} catch (err) {
  if (isCatamorphicError(err)) {
    switch (err.code) {
      case "conflict":
        return showConflictResolver(err.details); // typed payload
      case "unauthorized":
        return redirectToLogin();
      case "not_found":
      case "validation":
      case "server_error":
      case "network":
      case "unknown":
        return toast(err.message);
    }
  }
  throw err;
}
```

Never branch on `err.message.includes(...)` — `code` is the contract, `message` is the human-readable summary, and `details` carries the typed payload (e.g. conflict files, validation issues).

### 3) Canvas + panel state (jotai atoms)

`@catamorphic/react` exposes every canvas atom so the editor and host UI share one store. Import atoms directly if you are composing your own layout:

```tsx
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import {
  codeAtom,
  graphAtom,
  executionStateAtom,
  historySidebarOpenAtom,
  panelVisibilityAtom,
  runsAtom,
  selectedNodeAtom,
  selectedNodeIdAtom,
  useSelectedNode,
  useWorkflowGraph,
} from "@catamorphic/react";
```

### 4) Pure workflow-authoring helpers (server-safe)

Non-React helpers live under the `/workflow-helpers` subpath so Next.js server components / actions can import them without pulling client-only code:

```ts
import {
  buildUntitledWorkflowName,
  displayNameFromWorkflowName,
  ensurePrimaryWorkflowExportName,
  findWorkflowDefinitions,
  readWorkflowDisplayName,
  starterCodeForWorkflow,
  upsertWorkflowDisplayName,
  workflowFilePathFromName,
} from "@catamorphic/react/workflow-helpers";
```

### 5) Drop-in editor — `@catamorphic/ui`

```tsx
import { useOnParse } from "@catamorphic/react";
import { WorkflowEditor } from "@catamorphic/ui";
import "@catamorphic/ui/styles.css";

export function WorkflowScreen({
  projectFiles,
  workflowName,
  workflowFilePath,
  code,
  setCode,
  triggerParameters,
  onRun,
}) {
  const onParse = useOnParse({
    files: projectFiles,
    workflowName,
    preferredFilePath: workflowFilePath,
  });
  return (
    <WorkflowEditor
      code={code}
      onCodeChange={setCode}
      onParse={onParse}
      triggerParameters={triggerParameters}
      onRun={onRun}
      showCodeEditor
      showMinimap
      aiEnabled
      onAIPrompt={async (prompt) => callHostAI(prompt, code)}
      renderCodeEditor={(props) => <MonacoHost {...props} />}
    />
  );
}
```

`onParse` is required: without it, `<WorkflowEditor>` has nothing to turn `code` into a graph and the canvas stays empty. Always mount `useOnParse` (or a hand-rolled equivalent); it wraps `useParseWorkflow` + `@catamorphic/parser/layout` into a stable callback that's safe to pass to the editor even as the host's `files` map churns on every keystroke.

Key props (see `WorkflowEditorProps` in `@catamorphic/ui`):

- `code` / `onCodeChange` — controlled source string (required)
- `onParse` — `OnParseCallback` that turns the current source into `{ graph, layoutedNodes, layoutedEdges }`. Use `useOnParse` unless you need custom parsing (different endpoint, project-git draft files, etc.) — in that case import `layoutGraph` from `@catamorphic/parser/layout`, **never** from the `@catamorphic/parser` barrel (it pulls `ts-morph` → `node:fs` into the client bundle).
- `renderCodeEditor` — slot to plug in your own code editor (Monaco, CodeMirror, …)
- `nodeRenderers` — partial map of `WorkflowNodeType` → component, overrides node visuals
- `executionState` — `Record<nodeId, "running" | "completed" | "failed">` overlay
- `onRun(triggerData) => Promise<{ runId, status, steps, startedAt, completedAt, … }>` — wires the Run dialog + history sidebar
- `triggerParameters` — `ParameterInfo[]` from `@catamorphic/parser` for the Run dialog form
- `onLoadMoreRuns`, `initialRuns` — history pagination
- `renderVersionsPanel`, `renderBanner`, `renderToolbarCenter` — slots for host-owned chrome
- `readOnly` — disables the code editor
- `runDialogRequestKey` — **deprecated**. Bumping a number used to be the only way to open the Run dialog from outside the editor; now wrap your chrome in `<WorkflowEditorScope>` and call `useSetAtom(showRunDialogAtom)(true)` (or the `openDialog` from `useWorkflowRunController`) directly. The prop is still honored for backwards compatibility.

Atoms (`codeAtom`, `graphAtom`, `selectedNodeIdAtom`, `selectedNodeAtom`, `panelVisibilityAtom`, `runsAtom`, `showRunDialogAtom`, …) live in `@catamorphic/react`. The editor's store is scoped by `<WorkflowEditorScope>` — to read or write atoms from host chrome, wrap the editor + your chrome in a shared scope:

```tsx
import { WorkflowEditor, WorkflowEditorScope } from "@catamorphic/ui";
import { selectedNodeAtom } from "@catamorphic/react";
import { useAtomValue } from "jotai";

function Inspector() {
  const selected = useAtomValue(selectedNodeAtom);
  return selected ? <aside>{selected.label}</aside> : null;
}

<WorkflowEditorScope>
  <WorkflowEditor {...props} />
  <Inspector />
</WorkflowEditorScope>
```

Lower-level pieces — `WorkflowCanvas`, `DetailPanel`, `HistorySidebar`, `Toolbar`, `AIBar`, plus `WorkflowEditorChrome` (the inner editor without the scope wrapper) — are exported too if you want to assemble a custom layout.

### 6) Component registry — `@catamorphic/registry` (copy-paste UI)

Pre-wired React components (file tree, git panel, runs panel, plugins/secrets settings, projects list, project editor, diff drawer, plus a `CatamorphicAppProvider` wrapper) ship as a shadcn-compatible registry. Items are JSON manifests that inline a single `.tsx` file; the component lands in `components/catamorphic/` once installed, and from there imports from `@catamorphic/react` + `@catamorphic/ui` only — there's no runtime dependency on `@catamorphic/registry` itself.

The registry is **served by the host**, not by catamorphic. The built JSON manifests live at `packages/registry/dist/r/<item>.json` after `bun run --filter @catamorphic/registry build`. Install options:

- **Direct file path** (simplest for local dev): `npx shadcn add /abs/path/to/catamorphic/packages/registry/dist/r/projects-list.json`.
- **From `node_modules`** (once the host has `@catamorphic/registry` installed via `file:` or npm): `npx shadcn add ./node_modules/@catamorphic/registry/dist/r/projects-list.json`, or wire the directory as a named registry in the host's `components.json`.
- **Host-served URL** (production): the host serves `packages/registry/dist/r/` from its own static-asset pipeline and points shadcn at that URL.

Items currently shipped:

- `catamorphic-provider` — `<CatamorphicAppProvider baseUrl getTenantId getExternalUserId>` that wires `CatamorphicProvider` + `QueryClientProvider`. Always install this first.
- `projects-list` — table + create-project dialog (`useProjects` + `useCreateProject` + `useTemplates`).
- `project-editor` — three-pane scaffold with `renderEditor` (plug in monaco/codemirror), `renderSidebar`, and `renderGitPanel` slots.
- `file-explorer` — pure file tree.
- `git-panel` — branch / dirty / commits / deploy panel (`useProjectGit` + `useProjectCommits` + `useDeployProject`).
- `diff-drawer` — side drawer with a `renderDiff` slot for monaco-diff or codemirror-merge.
- `runs-panel` — list runs + trigger new ones (`useWorkflowRuns` + `useTriggerWorkflowRun`).
- `plugins-settings` — attach/detach plugins + edit secrets.

Pick what you want, drop it into your repo, then customize the JSX/tailwind freely — they're meant to be edited.

### 7) Parsing workflows

`parseWorkflow` / `parseProject` (exported from `@catamorphic/parser`'s main entry) use `ts-morph`, which pulls in `node:fs` and **will not bundle for the browser**. Importing _anything_ from the `@catamorphic/parser` barrel in client code throws `Cannot find module 'node:fs': Unsupported external type Url for commonjs reference` at module-evaluation time (the barrel re-exports the parser side-effectfully, so Next/Turbopack can't tree-shake it even if you only reach for `layoutGraph`).

Use cases:

- **Server / Node**: `import { parseWorkflow } from "@catamorphic/parser"` — fine.
- **Client** (code that runs in the browser): only ever import from the dedicated subpath:

  ```ts
  import { layoutGraph } from "@catamorphic/parser/layout";
  ```

  This subpath is `dagre`-only and has no Node built-in deps. For any actual parsing, call `useParseWorkflow()` and let the sidecar do it (see `onParse` above).

## Package Cheatsheet

| Package | Use In | Key Exports |
| --- | --- | --- |
| `@catamorphic/server-sdk` | Node/Bun backend | `createCatamorphic`, `Catamorphic` (`migrate()`, `close()`, `forTenant`), `ScopedClient`, re-exports of db/git/sandbox/plugins building blocks |
| `@catamorphic/core` | Advanced backend | `CatamorphicCore`, `createCatamorphicCore`, service classes + identity helpers |
| `@catamorphic/db` | Backend + migrations | `createDatabase` (pool or connection string), `migrateToLatest`, `DB` (Kysely types), `catamorphic-db` CLI (`migrate`, `status`, `reset`) |
| `@catamorphic/git` | Backend | `ProjectManager`, `FsBackend`, `FsRemoteBackend`, `FsOriginRepo` |
| `@catamorphic/sandbox` | Backend (optional) | `SandboxProvider` + `CodingAgentProvider` contracts, `instrumentSandboxProvider`, `SandboxManagerImpl`, `RunExecutorImpl` |
| `@catamorphic/cloudflare` | Backend (plugin) | `CloudflareSandboxProvider`, `ArtifactsClient`, `ArtifactsRemoteBackend` |
| `@catamorphic/daytona` | Backend (plugin) | `DaytonaSandboxProvider`, `DaytonaBackend`, `DaytonaProjectRepo` |
| `@catamorphic/flue` | Backend (plugin) | `FlueCodingAgent` (flagship coding agent, server-side Flue harness), `catamorphicSandbox`, `defineSkill`, `defineTool`, `registerProvider` |
| `@catamorphic/codex` | Backend (plugin) | `CodexAgent` (Codex SDK coding agent) |
| `@catamorphic/plugins` | Backend (optional) | `LocalPluginResolver`, `PluginManifestSchema`, `PluginResolver` |
| `@catamorphic/fastify-plugin` | Backend (HTTP path) | `catamorphicPlugin` (mountable, encapsulated), `createApp({ core })` app factory |
| `@catamorphic/otel` | Backend libraries | `getTracer`, `withSpan` — `@opentelemetry/api` helpers; host owns the OTel SDK |
| `@catamorphic/api-client` | Frontend or non-Node backend | `createApiClient`, `CatamorphicApiClient`, `paths` (OpenAPI) |
| `@catamorphic/react` | Frontend | `CatamorphicProvider`, `useCatamorphic`, data hooks (projects/runs/git/plugins/secrets/agent), atoms, `useWorkflowGraph`, `useSelectedNode`, `useProjectGitState`, `useOnParse`/`useParseWorkflow`, `CatamorphicError`, `isCatamorphicError` |
| `@catamorphic/react/types` | Frontend | OpenAPI-derived domain types (`Project`, `Run`, `RepoStatus`, `BranchInfo`, `ConflictEntry`, `PluginInfo`, `Secret`, `AgentSession`, …) |
| `@catamorphic/react/workflow-helpers` | Frontend (server-safe) | Pure authoring helpers, no React |
| `@catamorphic/ui` | Frontend | `WorkflowEditor`, `WorkflowEditorChrome`, `WorkflowEditorScope`, `WorkflowCanvas`, `DetailPanel`, `HistorySidebar`, `Toolbar`, `AIBar`, plus `@catamorphic/ui/styles.css` |
| `@catamorphic/registry` | Frontend (copy-paste) | shadcn-style registry of pre-wired components (`catamorphic-provider`, `projects-list`, `project-editor`, `file-explorer`, `git-panel`, `diff-drawer`, `runs-panel`, `plugins-settings`) — install with `npx shadcn add <registry-host>/r/<item>.json` |
| `@catamorphic/parser` | Either | `parseWorkflow`, `parseProject`, `layoutGraph`, `WorkflowGraph` types |

## Environment Variables

Backend (SDK):

- `DATABASE_URL` — Postgres connection string
- `CATAMORPHIC_DB_SCHEMA` — schema name (default `catamorphic`)
- `CATAMORPHIC_PROJECTS_PATH` — fs path for per-user git working trees
- `CATAMORPHIC_REMOTES_PATH` — fs path for bare git remotes
- `CLOUDFLARE_SANDBOX_API_URL` + `CLOUDFLARE_SANDBOX_API_KEY` — default sandbox provider (Bridge Worker; see `CLOUDFLARE.md`)
- `DAYTONA_API_KEY` — alternate sandbox provider (used when Cloudflare vars unset)
- `CATAMORPHIC_LOCAL_PLUGINS_DIR` — optional, enables local plugin resolution

Frontend (HTTP path):

- `NEXT_PUBLIC_CATAMORPHIC_URL` (or equivalent) — base URL where the host mounts `@catamorphic/fastify-plugin`

## Common Pitfalls

- **Missing `X-Catamorphic-Tenant-Id` / `X-External-User-Id`**. `@catamorphic/fastify-plugin` returns 400 on every route that needs identity — both headers are mandatory (no standalone fallback). Set them on *every* request via a `fetch` wrapper — don't set them per-call.
- **`Content-Type: application/json` stripped by `fetch` wrapper.** openapi-fetch passes a built `Request` as `input`; always seed `new Headers(input instanceof Request ? input.headers : init?.headers)` before overriding.
- **Using `@catamorphic/ui` without the stylesheet.** Import `@catamorphic/ui/styles.css` once at the root — class names use the `.catamorphic-*` prefix so host CSS doesn't clash.
- **Double `QueryClientProvider`.** `CatamorphicProvider` mounts its own if you don't pass `queryClient`. In hosts that already have one, pass it explicitly so queries share a cache.
- **Migrations.** `catamorphic.migrate()` / `catamorphic-db migrate` are idempotent and schema-scoped; prefer running them in CI/deploy.
- **Schema scoping with shared pools.** `createDatabase({ connectionString, schema })` sets `search_path` on connections it creates — don't hand that pool to host code expecting `public`. Host-owned pools passed as `{ pool }` are safe: catamorphic schema-qualifies its queries via Kysely's `WithSchemaPlugin` and leaves the pool's `search_path` alone.
- **Calling hooks outside the provider.** `useCatamorphic must be used within a <CatamorphicProvider>` means the tree is missing the provider (or there are two React copies; check peer dep resolution).
- **Branching on `error.message`.** All hooks reject with `CatamorphicError`; switch on `err.code` (use `isCatamorphicError(err)` first). `message` is for humans; `details` carries the typed payload (e.g. conflict files).
- **Re-declaring server shapes.** Don't `interface Run {…}` in your own files — import from `@catamorphic/react/types` so you get whatever the OpenAPI schema says today.
- **Empty workflow canvas.** `<WorkflowEditor>` has no default parser — if `onParse` is omitted the canvas stays blank. Pass `useOnParse({ files, workflowName, preferredFilePath })` (or the raw `useParseWorkflow` + `layoutGraph({ nodes, edges })` glue) so the editor can turn `code` into a graph.
- **Importing `@catamorphic/parser` in client code.** The barrel re-exports `parseWorkflow` side-effectfully and drags `ts-morph` → `node:fs` into the bundle; Next/Turbopack throws `Cannot find module 'node:fs'` at module-evaluation. Client bundles must only import from `@catamorphic/parser/layout`; let the sidecar handle actual parsing via `useParseWorkflow`.

## Local Dev Linking (Host ↔ Local Catamorphic Checkout)

When iterating on catamorphic alongside the host:

```bash
# In catamorphic
bun run --filter '@catamorphic/*' build

# In host
pnpm -C backend add @catamorphic/db@file:/abs/path/to/catamorphic/packages/db
pnpm -C frontend add \
  @catamorphic/api-client@file:/abs/path/to/catamorphic/packages/api-client \
  @catamorphic/react@file:/abs/path/to/catamorphic/packages/react \
  @catamorphic/ui@file:/abs/path/to/catamorphic/packages/ui \
  @catamorphic/parser@file:/abs/path/to/catamorphic/packages/parser
```

After any catamorphic change: rebuild the affected packages, then re-run the `pnpm add …@file:` commands so pnpm refreshes the dependency, then restart the host process. If SQL migrations changed, run `catamorphic-db migrate` again.
