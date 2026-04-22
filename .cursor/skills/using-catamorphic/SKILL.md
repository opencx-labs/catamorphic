---
name: using-catamorphic
description: Embed Catamorphic (code-first workflow builder) inside a host app. Use when integrating the @catamorphic/sdk, @catamorphic/db, @catamorphic/api-client, @catamorphic/react, or @catamorphic/ui packages, wiring the CatamorphicProvider, mounting the WorkflowEditor canvas, booting the SDK with Postgres + git + sandbox, or when the user mentions catamorphic, workflow editor, workflow canvas, tenant id, external user id, or embedding catamorphic.
---

# Using Catamorphic

Catamorphic is an **embed-first** code-first workflow builder. The host app owns auth, users, orgs, and (usually) the Postgres database. Catamorphic supplies:

- a **backend SDK** (`@catamorphic/sdk`) for in-process project/workflow/file CRUD
- **headless React bindings** (`@catamorphic/react`) for data hooks + jotai atoms
- a **drop-in editor UI** (`@catamorphic/ui`) rendered with React Flow
- a **typed HTTP client** (`@catamorphic/api-client`) for out-of-process setups
- a **migration CLI + Kysely instance** (`@catamorphic/db`) for the schema

Everything is scoped by a `tenantId` (= host org id) and an `externalUserId` (= host user id). Catamorphic never references host tables.

## Pick an Integration Path

Choose **one** backend integration; the React/UI layer is the same in both.

| Path | Use When | Packages |
| --- | --- | --- |
| **Library-direct (recommended)** | Host is Node/Bun and can import catamorphic in-process | `@catamorphic/sdk` + `@catamorphic/db` + `@catamorphic/git` (+ optional `@catamorphic/sandbox`, `@catamorphic/plugins`) |
| **HTTP sidecar** | Host is non-Node or wants a network boundary | Run `@catamorphic/server` separately; host consumes `@catamorphic/api-client` |
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
pnpm add @catamorphic/sdk @catamorphic/db @catamorphic/git @catamorphic/sandbox @catamorphic/plugins kysely
```

### 1) Run migrations once

```bash
DATABASE_URL=postgres://... \
CATAMORPHIC_DB_SCHEMA=catamorphic \
pnpm exec catamorphic-db migrate
```

The schema defaults to `catamorphic`. Use a distinct schema if the host already has a table with a colliding name.

### 2) Boot the SDK at process start

```ts
import { createDatabase } from "@catamorphic/db";
import { FsBackend, FsRemoteBackend, ProjectManager } from "@catamorphic/git";
import { DaytonaSandboxProvider } from "@catamorphic/sandbox";
import { LocalPluginResolver } from "@catamorphic/plugins";
import { createCatamorphic } from "@catamorphic/sdk";

const db = createDatabase({
  connectionString: process.env.DATABASE_URL!,
  schema: "catamorphic",
});

export const catamorphic = createCatamorphic({
  db,
  projectManager: new ProjectManager(
    new FsBackend(process.env.CATAMORPHIC_PROJECTS_PATH!),
    new FsRemoteBackend(process.env.CATAMORPHIC_REMOTES_PATH!),
  ),
  // Optional — only needed for run execution.
  sandboxProvider: process.env.DAYTONA_API_KEY
    ? new DaytonaSandboxProvider({ apiKey: process.env.DAYTONA_API_KEY })
    : undefined,
  // Optional — only needed for plugin attachment + secrets.
  pluginResolver: process.env.CATAMORPHIC_LOCAL_PLUGINS_DIR
    ? new LocalPluginResolver(process.env.CATAMORPHIC_LOCAL_PLUGINS_DIR)
    : undefined,
});
```

Catamorphic **does not** call `db.destroy()` — the host owns the connection's lifetime.

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

Anything not covered by the SDK v1 surface (runs, plugins, secrets, deploy/pull/diff) is reachable via `catamorphic.core.runs.*`, `catamorphic.core.plugins.*`, `catamorphic.core.deployment.*`, etc. — these take `identity` as their first argument (build it yourself: `{ tenantId, externalUserId }`).

## Backend Path B — HTTP Sidecar

Run `@catamorphic/server` as a separate process wired with the exact same `CatamorphicCore` (see `createApp({ core, standalone: false })` from `@catamorphic/server`). In embedded mode the server requires `X-Catamorphic-Tenant-Id` and `X-External-User-Id` on every request.

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
  // Editor glue
  useOnParse,
  useParseWorkflow,
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
- `onParse` — `OnParseCallback` that turns the current source into `{ graph, layoutedNodes, layoutedEdges }`. Use `useOnParse` unless you need custom parsing.
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

Pre-wired React components (file tree, git panel, runs panel, plugins/secrets settings, projects list, project editor, diff drawer, plus a `CatamorphicAppProvider` wrapper) ship as a shadcn-compatible registry. Items are JSON manifests that inline a single `.tsx` file; the host runs `npx shadcn add <host>/r/<item>.json` and the component lands in `components/catamorphic/`. The component imports from `@catamorphic/react` + `@catamorphic/ui` only — there's no runtime dependency on `@catamorphic/registry` itself.

The registry is **served**, not published to npm. In dev, the playground hosts it at `http://localhost:8501/r/<item>.json` (see `apps/playground/src/app/r/[name]/route.ts`); in production, point the shadcn CLI at whatever URL serves `packages/registry/dist/r/`. Items currently shipped:

- `catamorphic-provider` — `<CatamorphicAppProvider baseUrl getTenantId getExternalUserId>` that wires `CatamorphicProvider` + `QueryClientProvider`. Always install this first.
- `projects-list` — table + create-project dialog (`useProjects` + `useCreateProject` + `useTemplates`).
- `project-editor` — three-pane scaffold with `renderEditor` (plug in monaco/codemirror), `renderSidebar`, and `renderGitPanel` slots.
- `file-explorer` — pure file tree.
- `git-panel` — branch / dirty / commits / deploy panel (`useProjectGit` + `useProjectCommits` + `useDeployProject`).
- `diff-drawer` — side drawer with a `renderDiff` slot for monaco-diff or codemirror-merge.
- `runs-panel` — list runs + trigger new ones (`useWorkflowRuns` + `useTriggerWorkflowRun`).
- `plugins-settings` — attach/detach plugins + edit secrets.

Pick what you want, drop it into your repo, then customize the JSX/tailwind freely — they're meant to be edited.

### 7) Parsing workflows on the client

Call `parseWorkflow` / `parseProject` directly from `@catamorphic/parser` if you need the `WorkflowGraph` without the editor — it uses `ts-morph` and runs in the browser.

```ts
import { parseWorkflow } from "@catamorphic/parser";
const graph = parseWorkflow(source, { workflowName: "welcomeUser" });
```

## Package Cheatsheet

| Package | Use In | Key Exports |
| --- | --- | --- |
| `@catamorphic/sdk` | Node/Bun backend | `createCatamorphic`, `Catamorphic`, `ScopedClient`, `TenantScopedClient` |
| `@catamorphic/core` | Advanced backend | `CatamorphicCore`, `createCatamorphicCore`, service classes + identity helpers |
| `@catamorphic/db` | Backend + migrations | `createDatabase`, `DB` (Kysely types), `catamorphic-db` CLI (`migrate`, `status`, `reset`) |
| `@catamorphic/git` | Backend | `ProjectManager`, `FsBackend`, `FsRemoteBackend`, `DaytonaBackend` |
| `@catamorphic/sandbox` | Backend (optional) | `DaytonaSandboxProvider`, `CloudflareSandboxProvider`, `SandboxManagerImpl`, `RunExecutorImpl`, `CodexAgent` |
| `@catamorphic/plugins` | Backend (optional) | `LocalPluginResolver`, `PluginManifestSchema`, `PluginResolver` |
| `@catamorphic/server` | Backend (HTTP path) | `createApp({ core, standalone })` — Fastify app factory |
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
- `DAYTONA_API_KEY` — optional, enables sandboxed run execution
- `CATAMORPHIC_LOCAL_PLUGINS_DIR` — optional, enables local plugin resolution

Frontend (HTTP path):

- `NEXT_PUBLIC_CATAMORPHIC_URL` (or equivalent) — base URL of `@catamorphic/server`

## Common Pitfalls

- **Missing `X-Catamorphic-Tenant-Id` / `X-External-User-Id`**. Embedded `@catamorphic/server` returns 400. Set both on *every* request via a `fetch` wrapper — don't set them per-call.
- **`Content-Type: application/json` stripped by `fetch` wrapper.** openapi-fetch passes a built `Request` as `input`; always seed `new Headers(input instanceof Request ? input.headers : init?.headers)` before overriding.
- **Using `@catamorphic/ui` without the stylesheet.** Import `@catamorphic/ui/styles.css` once at the root — class names use the `.catamorphic-*` prefix so host CSS doesn't clash.
- **Double `QueryClientProvider`.** `CatamorphicProvider` mounts its own if you don't pass `queryClient`. In hosts that already have one, pass it explicitly so queries share a cache.
- **Running migrations on every boot.** Run `catamorphic-db migrate` in CI/deploy, not in app startup.
- **Forgetting the search_path.** `createDatabase({ schema })` sets `search_path` on each connection. Do not share a `pg.Pool` with host code that expects `public`.
- **Calling hooks outside the provider.** `useCatamorphic must be used within a <CatamorphicProvider>` means the tree is missing the provider (or there are two React copies; check peer dep resolution).
- **Branching on `error.message`.** All hooks reject with `CatamorphicError`; switch on `err.code` (use `isCatamorphicError(err)` first). `message` is for humans; `details` carries the typed payload (e.g. conflict files).
- **Re-declaring server shapes.** Don't `interface Run {…}` in your own files — import from `@catamorphic/react/types` so you get whatever the OpenAPI schema says today.
- **Empty workflow canvas.** `<WorkflowEditor>` has no default parser — if `onParse` is omitted the canvas stays blank. Pass `useOnParse({ files, workflowName, preferredFilePath })` (or the raw `useParseWorkflow` + `layoutGraph({ nodes, edges })` glue) so the editor can turn `code` into a graph.

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
