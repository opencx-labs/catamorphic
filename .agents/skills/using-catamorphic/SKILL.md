---
name: using-catamorphic
description: Embed Catamorphic's agentic work environment libraries inside a host app. Use when integrating its server SDK, Fastify plugin, database, generated API client, headless React bindings, composable UI, projects, agents, apps, or workflows.
---

# Using Catamorphic

Catamorphic is an **embeddable framework for agentic work environments**. The
host app owns auth, users, organizations, database, deployment, and product
identity. Catamorphic supplies co-equal project, git, agent, workflow, app,
API, and UI primitives:

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
- **`externalUserId`**: host's stable user id. Catamorphic persists it where
  durable ownership, membership, or audit attribution requires it, but never
  references the host's user table.

In the SDK this is bound via `cat.forTenant({ tenantId }).forUser({ externalUserId, scope? })`. Over HTTP the fastify-plugin's **required `identity` resolver** turns each request (your session cookie, JWT, …) into an identity — there is no default and no headers are read unless you pass the stock `identityFromHeaders()` behind your own gateway.

An identity with no `scope` is **root** host authority across the tenant. A
project builder is scoped with `{ kind: "project", projectId }`; members get
only exact app, workflow, agent, and document refs. Builder access does not
implicitly grant project-store paths, managed Environments, connection
aliases, or administrative permissions. Which users receive those refs is
host policy; Catamorphic enforces the resolved result. Never hardcode ids or
use missing scope as an ordinary builder shortcut.

For company-brain hosts, commit reusable access policy as
`roles/<slug>.json`. A role grants workflow names, project-agent slugs,
Environment names, provider-neutral connection aliases, document paths, and
namespaced project permissions. Catamorphic reserves `memberships:manage` and
`roles:manage`; embedders may interpret additional names in their own services
and presentation. The host owns membership assignment. Unattended triggers do
not run from those grants alone:
each member creates a consent-bound workflow enablement, usually through the
desktop's **Automate** and **Enable for me** flow. The final connection auth may
complete an already-started enablement; account connection by itself never
bulk-enables workflows.

Project-authored presentation targets resolved authority, never role names.
The desktop understands `when: { builder?, permissions? }` on shared sidebar
sections/items and on up to six `.catamorphic/project.json` `startingActions`.
Every condition must match; invalid conditions fail closed; absent config
leaves no trace. Treat this as reference-host behavior, not a framework JSON
contract that embedders must adopt.

## Backend Path A — Library-Direct SDK

Install (workspace/local — see `Local Dev Linking` below for file: installs):

```bash
pnpm add @catamorphic/server-sdk
```

### 1) Boot the SDK at process start

```ts
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import {
  createCatamorphic,
  defineStaticEnvironments,
  LocalPluginResolver,
} from "@catamorphic/server-sdk";

const sandboxProvider = new CloudflareSandboxProvider({
  apiUrl: process.env.CLOUDFLARE_SANDBOX_API_URL!,
  apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
});
const environmentProvider = defineStaticEnvironments([
  {
    descriptor: {
      id: "local",
      label: "Managed execution",
      trust: "managed",
      isolation: "sandbox",
      workloads: ["agent", "workflow"],
      agentTopologies: ["controller"],
      capabilities: ["network.egress"],
      resources: {},
    },
    sandboxProvider,
  },
]);

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
  sandboxProvider,
  // Required. This binding matches the default project environment.
  // Multi-pool hosts can inject a dynamic EnvironmentProvider instead.
  environmentProvider,
  // Optional — only needed for plugin attachment + secrets.
  pluginResolver: process.env.CATAMORPHIC_LOCAL_PLUGINS_DIR
    ? new LocalPluginResolver(process.env.CATAMORPHIC_LOCAL_PLUGINS_DIR)
    : undefined,
});
```

Catamorphic never destroys host-owned pools/Kysely instances; `catamorphic.close()` only closes what it created.

For agent sessions, `codingAgent` accepts either one
`CodingAgentProvider` or a `CodingAgentRegistry`. A registry is the normal
shape for multiple named agents: each entry owns its provider, execution
topology, privilege ceiling, defaults, connection requirements, and delegation
routes. Agent sessions also require `hostId` and `sandboxProvider`; entries
with `topology: "native"` additionally require `nativeAgentCheckout`.

### 2) Run migrations

Idempotent and schema-scoped. Programmatically:

```ts
await catamorphic.migrate();
```

Worker startup is explicit and host-owned. Start a handle once in every process
that should claim queued production work, then stop it during shutdown:

```ts
const executionWorker = catamorphic.startExecutionWorker({ concurrency: 4 });
// Later: await executionWorker.stop();
```

Or via CLI in a deploy step:

```bash
DATABASE_URL=postgres://... \
CATAMORPHIC_DB_SCHEMA=catamorphic \
pnpm exec catamorphic-db migrate
```

### 3) Per-request: bind identity, call resources

```ts
const scoped = catamorphic
  .forTenant({ tenantId: req.org.id })
  .forUser({ externalUserId: req.user.id, scope: entitlements });

// Projects
await scoped.projects.create({ name: "onboarding" });
await scoped.projects.list({ limit: 20 });
await scoped.projects.get({ projectId });
await scoped.projects.update({ projectId, name: "renamed" });
await scoped.projects.delete({ projectId });

// Files (content-addressed, commit-on-write)
await scoped.files.list({ projectId });
await scoped.files.read({ projectId, path: "src/welcome.ts" });
await scoped.files.readAll({ projectId });
await scoped.files.write({
  projectId,
  path: "src/welcome.ts",
  content: source,
  commitMessage: "Add welcome workflow",
});

// Workflows (parsed on read from project source)
await scoped.workflows.list({ projectId });
await scoped.workflows.get({ projectId, workflowName: "welcomeUser", ref: "HEAD" });
```

Runs are also identity-bound on `scoped.runs`. Plugins, secrets, and git
operations such as deploy/pull/diff remain available through
`catamorphic.core.*` or the HTTP surface.

### 4) Triggering runs

Use the one `scoped.runs` resource:

- `scoped.runs.triggerProduction({ projectId, workflowName, input? })` resolves
  the deployed `origin/main` artifact, enqueues the Run, and records its SHA.

It returns a canonical Run. Every run executes a deployed commit — there is no
mutable-source or test mode. Execution continues through the explicit host
worker; the synchronous trigger-firing path runs a workflow inline until its
first durable wait, so a workflow that cannot suspend settles in the request.

It requires `sandboxProvider` at boot — without it the method throws `SandboxProviderNotConfiguredError`. Other typed errors: `ProjectNotFoundError`, `WorkflowNotFoundError` (pre-flight check on files), `PluginSecretsMissingError` (when attached plugins declare required secrets the project hasn't set).

Over HTTP, triggering uses
`POST /api/projects/:projectId/workflows/:name/runs`. React exposes
`useTriggerRun`; list, detail, controls, and item
inspection use `useRuns`, `useRun`, and the other `useRun*` hooks.

### 5) Workflow authoring model

There is one Workflow model and one Run model:

- Every workflow is an exported
  `defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
  value; IO lives in `"use step"` functions called from boundary run bodies.
- `defineBoundary` is one atomic retry scope; all callback operations retry
  together after failure.
- `defineBatch` is a finite paged per-item processing scope with an optional sink.
- Package-level `defineBatchStep` may physically coalesce compatible calls only
  inside `defineBatch.process`.

Workflow and Run capabilities determine available controls. Do not add a public
stage concept or separate API, SDK, hook, or UI families for these mechanics.

A member-owned workflow can call
`context.host["catamorphic.sessions"].wake({ key, agentSlug, content, title?,
notification? })`. Core reuses one active session per member, workflow, and
stable key, queues the normal agent turn, and requests durable attention when
it settles. Clients poll the ordinary session list, render
`attentionRequired`, and acknowledge it through the generated API. Web Push
is optional transport to the same session, not a separate notification inbox.
Service-owned enablements cannot infer a human recipient and fail closed.

Delegated work is represented by ordinary durable child sessions. Keep
`parentSessionId` (hierarchy), `forkedFromSessionId` (transcript lineage), and
delegation records distinct. Archive is recursive durable state: it can stop
live turns, queued work, Watchers, and processes, and therefore returns a typed
confirmation impact before destructive interruption. Use the generated
subsession, archive, and unarchive routes or the corresponding React hooks;
do not recreate child work as harness-private UI state or store archive only
in browser preferences.

## Backend Path B — HTTP via the Fastify plugin

Register `catamorphicPlugin` on the host's own Fastify server with the exact same `CatamorphicCore`:

```ts
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";

app.register(catamorphicPlugin, {
  core: catamorphic.core,
  prefix: "/api", // the generated api-client expects /api
  identity: async (request) => identityFromVerifiedSession(request),
});
```

The plugin is encapsulated (its Zod compilers + error handler don't leak) and registers no CORS; the host owns cross-origin policy. For a sidecar process, `createApp({ core, identity })` returns a complete Fastify app (CORS + Swagger UI at `/docs`, plugin at `/api`):

```ts
import { createApp } from "@catamorphic/fastify-plugin";

const app = createApp({
  core: catamorphic.core,
  identity: async (request) => {
    const session = await verifySession(request);
    if (!session) return null; // 401
    const base = { tenantId: session.orgId, externalUserId: session.userId };
    return session.isEmployee
      ? { ...base, scope: [{ kind: "project", projectId: BRAIN_PROJECT_ID }] }
      : { ...base, scope: await entitlementsFor(session.userId) };
  },
});
await app.listen({ port: 8500, host: "0.0.0.0" });
```

Every route runs the `identity` resolver first — there is no default. Behind your own gateway that already sets `X-Catamorphic-Tenant-Id` / `X-External-User-Id`, pass `identity: identityFromHeaders()` instead (never browser-reachable).

The host consumes the server via the generated client, from the same origin so the session rides along:

```ts
import { createApiClient } from "@catamorphic/api-client";

export const apiClient = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_CATAMORPHIC_URL!,
  fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
});
```

**Important**: if you wrap `fetch` to add headers, seed the `Headers` from `input.headers` when `input` is a `Request` (as produced by openapi-fetch) — otherwise `Content-Type: application/json` is dropped and Fastify returns 415.

Type-safe calls go through `apiClient.GET("/api/projects", …)` etc. For paths openapi-fetch can't template (Fastify wildcards), use `apiClient.fetch(apiClient.baseUrl + "/…")`.

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
  // Same origin as the plugin: the session cookie is the credential and the
  // plugin's `identity` resolver maps it to a catamorphic identity.
  fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
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
  useUpdateProject,
  useWorkflow,
  useWorkflows,
  useWriteProjectFile,
  // Runs
  useRuns,
  useRun,
  useTriggerRun,
  useCancelRun,
  usePauseRunProcessing,
  useResumeRunProcessing,
  useSubmitRunInput,
  useRunItems,
  useRunItemSteps,
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
  useAcknowledgeAgentSessionAttention,
  useArchiveAgentSession,
  useUnarchiveAgentSession,
  // Per-member unattended workflow consent
  useWorkflowEnablements,
  usePreviewWorkflowEnablement,
  useCreateWorkflowEnablement,
  useUpdateWorkflowEnablement,
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
  panelVisibilityAtom,
  rightPanelOpenAtom,
  showRunDialogAtom,
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
      renderCodeEditor={({ code, onChange, readOnly }) => (
        // from the `monaco-editor` registry item
        <MonacoCodeEditor code={code} onChange={onChange} readOnly={readOnly} />
      )}
    />
  );
}
```

`onParse` is required: without it, `<WorkflowEditor>` has nothing to turn `code` into a graph and the canvas stays empty. Always mount `useOnParse` (or a hand-rolled equivalent); it wraps `useParseWorkflow` + `@catamorphic/parser/layout` into a stable callback that's safe to pass to the editor even as the host's `files` map churns on every keystroke.

Key props (see `WorkflowEditorProps` in `@catamorphic/ui`):

- `code` / `onCodeChange` — controlled source string (required)
- `onParse` — `OnParseCallback` that turns the current source into `{ graph, layoutedNodes, layoutedEdges }`. Use `useOnParse` unless you need custom parsing (different endpoint, project-git draft files, etc.) — in that case import `layoutGraph` from `@catamorphic/parser/layout`, **never** from the `@catamorphic/parser` barrel (it pulls `ts-morph` → `node:fs` into the client bundle).
- `renderCodeEditor` — slot for the Code tab's editor. Install the `monaco-editor` registry item for a ready-made TypeScript Monaco editor with line numbers, TS diagnostics/completion, and bidirectional code ↔ canvas linking, or plug in your own (Monaco, CodeMirror, …) and wire linking through `useCodeEditorLink` from `@catamorphic/react`. Without this prop the Code tab falls back to a plain `<textarea>`.
- `nodeRenderers` — partial map of `WorkflowNodeType` → component, overrides node visuals
- `executionState` — `Record<nodeId, "running" | "completed" | "failed">` overlay
- `onRun(triggerData) => Promise<Run>`: wires the Run dialog and active Run state
- `triggerParameters` — `ParameterInfo[]` from `@catamorphic/parser` for the Run dialog form
- `renderRunsPanel`, `renderBanner`, `renderToolbarCenter`: slots for host-owned chrome
- `readOnly` — disables the code editor

Atoms (`codeAtom`, `graphAtom`, `selectedNodeIdAtom`, `selectedNodeAtom`, `panelVisibilityAtom`, `rightPanelOpenAtom`, `showRunDialogAtom`, and others) live in `@catamorphic/react`. The editor's store is scoped by `<WorkflowEditorScope>`. To read or write atoms from host chrome, wrap the editor and your chrome in a shared scope:

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

Lower-level pieces such as `WorkflowCanvas`, `DetailPanel`, `RunsPanel`, `Toolbar`,
`AIBar`, plus `WorkflowEditorChrome` (the inner editor without the scope
wrapper), are exported too if you want to assemble a custom layout.

### 6) Component registry — `@catamorphic/registry` (copy-paste UI)

Pre-wired React components (file explorer, git panel, runs panel, plugins/secrets settings, project editor, chat timeline, sessions list, todo progress, tool-permission card, diff drawer, plus a `CatamorphicAppProvider` wrapper) ship as a shadcn-compatible registry. Items are JSON manifests that inline a single `.tsx` file; the component lands in `components/catamorphic/` once installed, and from there imports from `@catamorphic/react` and `@catamorphic/ui` only. There is no runtime dependency on `@catamorphic/registry` itself.

The registry is **served by the host**, not by catamorphic. The built JSON manifests live at `packages/registry/dist/r/<item>.json` after `bun run --filter @catamorphic/registry build`. Install options:

- **Direct file path** (simplest for local dev): `npx shadcn add /abs/path/to/catamorphic/packages/registry/dist/r/project-editor.json`.
- **From `node_modules`** (once the host has `@catamorphic/registry` installed via `file:` or npm): `npx shadcn add ./node_modules/@catamorphic/registry/dist/r/project-editor.json`, or wire the directory as a named registry in the host's `components.json`.
- **Host-served URL** (production): the host serves `packages/registry/dist/r/` from its own static-asset pipeline and points shadcn at that URL.

Items currently shipped:

- `catamorphic-provider` — `<CatamorphicAppProvider baseUrl getTenantId getExternalUserId>` that wires `CatamorphicProvider` + `QueryClientProvider`. Always install this first.
- `project-editor` — three-pane scaffold with `renderEditor` (plug in monaco/codemirror), `renderSidebar`, and `renderGitPanel` slots.
- `file-explorer` — pure file tree.
- `git-panel` — branch / dirty / commits / deploy panel (`useProjectGit` + `useProjectCommits` + `useDeployProject`).
- `diff-drawer` — side drawer with a `renderDiff` slot for monaco-diff or codemirror-merge.
- `runs-panel` — the single Runs surface for all Workflows, including capability-driven controls and item inspection (`useRuns` + `useTriggerRun`).
- `plugins-settings` — attach/detach plugins + edit secrets.
- `monaco-editor` — `MonacoCodeEditor` for `WorkflowEditor`'s `renderCodeEditor` slot: TypeScript highlighting/diagnostics/completion, line numbers, and code ↔ canvas linking via `useCodeEditorLink` (ADR 0011). Pulls `@monaco-editor/react` into the host, not into catamorphic packages.
- `agent-chat` — bottom-docked coding-agent conversation with optimistic activity and changed-file state.
- `chat-timeline`: message timeline shared by agent chat surfaces.
- `sessions-list`: project session navigation with durable attention state.
- `todo-progress`: compact rendering for an agent-owned session todo list.
- `tool-permission-card`: answer parked tool-consent requests.

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
| `@catamorphic/server-sdk` | Node/Bun backend | `createCatamorphic`, `Catamorphic` (`migrate()`, `startExecutionWorker()`, `close()`, `forTenant`), `ScopedClient` with `scoped.runs`, re-exports of db/git/sandbox/plugins building blocks |
| `@catamorphic/core` | Advanced backend | `CatamorphicCore`, `createCatamorphicCore`, service classes + identity helpers |
| `@catamorphic/db` | Backend + migrations | `createDatabase` (pool or connection string), `migrateToLatest`, `DB` (Kysely types), `catamorphic-db` CLI (`migrate`, `status`, `reset`) |
| `@catamorphic/git` | Backend | `ProjectManager`, `FsBackend`, `FsRemoteBackend`, `FsOriginRepo` |
| `@catamorphic/sandbox` | Backend (optional) | `SandboxProvider` + `CodingAgentProvider` contracts, `instrumentSandboxProvider`, `SandboxManagerImpl`, `RunExecutorImpl` |
| `@catamorphic/cloudflare` | Backend (plugin) | `CloudflareSandboxProvider`, `ArtifactsClient`, `ArtifactsRemoteBackend` |
| `@catamorphic/s3` | Backend (plugin) | `S3RemoteBackend`, `S3ObjectStore` for R2, S3, MinIO, and compatible stores |
| `@catamorphic/daytona` | Backend (plugin) | `DaytonaSandboxProvider`, `DaytonaBackend`, `DaytonaProjectRepo` |
| `@catamorphic/ai-sdk` | Backend (plugin) | `AiSdkCodingAgent` (flagship coding agent, in-process AI SDK `ToolLoopAgent` with remote sandbox tools) |
| `@catamorphic/claude-code` | Backend (plugin) | `ClaudeCodeAgent` with Claude Code settings-source fidelity and per-session MCP servers |
| `@catamorphic/codex` | Backend (plugin) | `CodexAgent` (Codex SDK coding agent) |
| `@catamorphic/plugins` | Backend (optional) | `LocalPluginResolver`, `PluginManifestSchema`, `PluginResolver` |
| `@catamorphic/fastify-plugin` | Backend (HTTP path) | `catamorphicPlugin` (mountable, encapsulated), `createApp({ core, identity })` app factory |
| `@catamorphic/otel` | Backend libraries | `getTracer`, `withSpan` — `@opentelemetry/api` helpers; host owns the OTel SDK |
| `@catamorphic/workflow` | Workflow projects | `defineWorkflow`, builder-scoped `defineBoundary`/`defineBatch`, `defineBatchStep`, pause and child-workflow types |
| `@catamorphic/runtime` | Sandbox runtime | Workflow harness and deployment supervisor protocol; not an author dependency |
| `@catamorphic/api-client` | Frontend or non-Node backend | `createApiClient`, `CatamorphicApiClient`, `paths` (OpenAPI) |
| `@catamorphic/react` | Frontend | `CatamorphicProvider`, project/run/git/agent/workflow-enablement hooks, archive and attention mutations, atoms, `useWorkflowGraph`, `useProjectGitState`, `CatamorphicError` |
| `@catamorphic/react/types` | Frontend | OpenAPI-derived domain types (`Project`, `Run`, `RepoStatus`, `BranchInfo`, `ConflictEntry`, `PluginInfo`, `Secret`, `AgentSession`, …) |
| `@catamorphic/react/workflow-helpers` | Frontend (server-safe) | Pure authoring helpers, no React |
| `@catamorphic/ui` | Frontend | `WorkflowEditor`, `WorkflowEditorChrome`, `WorkflowEditorScope`, `WorkflowCanvas`, `DetailPanel`, `RunsPanel`, `Toolbar`, `AIBar`, `AppMount`, plus `@catamorphic/ui/styles.css` |
| `@catamorphic/registry` | Frontend (copy-paste) | shadcn-style registry of pre-wired project, run, git, agent-chat, timeline, session-list, and tool-permission components |
| `@catamorphic/parser` | Either | `parseWorkflow`, `parseProject`, `layoutGraph`, `WorkflowGraph` types |

## Environment Variables

Backend (SDK):

- `DATABASE_URL` — Postgres connection string
- `CATAMORPHIC_DB_SCHEMA` — schema name (default `catamorphic`)
- `CATAMORPHIC_PROJECTS_PATH` — fs path for per-user git working trees
- `CATAMORPHIC_REMOTES_PATH` — fs path for bare git remotes
- `CLOUDFLARE_SANDBOX_API_URL` + `CLOUDFLARE_SANDBOX_API_KEY` — default sandbox provider (Bridge Worker; see `CLOUDFLARE.md`)
- `DAYTONA_API_KEY` — credential for hosts that explicitly construct the alternate Daytona provider
- `CATAMORPHIC_LOCAL_PLUGINS_DIR` — optional, enables local plugin resolution

Frontend (HTTP path):

- `NEXT_PUBLIC_CATAMORPHIC_URL` (or equivalent) — base URL where the host mounts `@catamorphic/fastify-plugin`

## Common Pitfalls

- **401 on every route.** The plugin's `identity` resolver returned `null` — it did not find your session on the request. Check the cookie/JWT reaches the plugin's origin (`credentials: "include"`, same origin or CORS with credentials). A 400 means `identityFromHeaders()` got a missing/malformed header.
- **`Content-Type: application/json` stripped by `fetch` wrapper.** openapi-fetch passes a built `Request` as `input`; always seed `new Headers(input instanceof Request ? input.headers : init?.headers)` before overriding.
- **Using `@catamorphic/ui` without the stylesheet.** Import `@catamorphic/ui/styles.css` once at the root — class names use the `.catamorphic-*` prefix so host CSS doesn't clash.
- **Double `QueryClientProvider`.** `CatamorphicProvider` mounts its own if you don't pass `queryClient`. In hosts that already have one, pass it explicitly so queries share a cache.
- **Migrations.** `catamorphic.migrate()` / `catamorphic-db migrate` are idempotent and schema-scoped; prefer running them in CI/deploy.
- **No execution worker.** Production triggers enqueue Runs; a host process must explicitly start `catamorphic.startExecutionWorker(...)` and stop its handle during shutdown.
- **Triggering before deploying.** Every run executes a deployed commit; there is no mutable-source test mode. Deploy the project, then trigger.
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
