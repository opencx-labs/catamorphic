# Catamorphic Integration Guide

Catamorphic is **embed-first**. A host application (for example OpenCX) runs catamorphic services in-process against its own Postgres instance — all catamorphic tables live in one schema (default: `catamorphic`). Three integration surfaces are available, in increasing order of coupling:

1. **`@catamorphic/db` only** — run the migrations, let the host join against `catamorphic.projects` / `catamorphic.workflow_runs`. Read-only relationship. Useful for reporting / BI.
2. **`@catamorphic/sdk` (library-direct, recommended)** — host imports `createCatamorphic(...)` and calls resources in-process. Identity is bound per request via `cat.forTenant(orgId).forUser(userId)`. No sidecar process.
3. **`@catamorphic/server` + `@catamorphic/api-client`** — host mounts the Fastify app via `createApp({ core })` (in-process or as a sidecar) and talks to it over HTTP. Same backing services; useful when the host is non-Node or wants a network boundary.

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

## HTTP path — `@catamorphic/server` mounted by the host

When library-direct isn't possible (non-Node host, strict network boundary, or you want to reuse the generated `@catamorphic/api-client`), mount `@catamorphic/server` as an in-process or sidecar Fastify app. It accepts the same `CatamorphicCore` — wire it exactly like the SDK path and hand it to `createApp({ core })`. The server requires two headers on every request (there are no defaults — catamorphic is embed-only):

- `X-Catamorphic-Tenant-Id` — host org id
- `X-External-User-Id` — host user id

The generated HTTP client lives in `@catamorphic/api-client`; construct it with `createCatamorphicClient({ baseUrl, fetch })` and set the headers on each call (or wrap `fetch` to inject them from your auth context).

## React bindings — `@catamorphic/react`

`@catamorphic/react` is the headless UI layer: a `CatamorphicProvider`, jotai atoms, and TanStack Query data hooks over `@catamorphic/api-client`. It has zero smart components — wire it up once and call the hooks from your own screens (or from `@catamorphic/ui`).

Peer deps: `react ^18.2 || ^19`, `react-dom ^18.2 || ^19`, `@tanstack/react-query ^5`.

```tsx
import { createApiClient } from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";

const queryClient = new QueryClient();
const apiClient = createApiClient({
  baseUrl: process.env.NEXT_PUBLIC_CATAMORPHIC_URL!,
  fetch: async (input, init) => {
    // Inject X-Catamorphic-Tenant-Id + X-External-User-Id here.
    const headers = new Headers(init?.headers);
    headers.set("X-Catamorphic-Tenant-Id", orgId);
    headers.set("X-External-User-Id", userId);
    return fetch(input, { ...init, headers });
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

Hooks shipped (phase 1 + phase 2):

- **Projects + workflows + files** — `useTemplates`, `useProjects`, `useProject`, `useCreateProject`, `useUpdateProject`, `useDeleteProject`, `useProjectFiles`, `useProjectFile`, `useWriteProjectFile`, `useWorkflows`, `useWorkflow`.
- **Runs** — `useWorkflowRuns`, `useWorkflowRun`, `useTriggerWorkflowRun`, `useCancelWorkflowRun`.
- **Git** — `useProjectGit`, `useProjectBranches`, `useProjectCommits`, `useProjectConflicts`, `useCreateBranch`, `useCheckoutBranch`, `useCommitChanges`, `useDeployProject`, plus the composite `useProjectGitState({ projectId, baselineFiles })` for multi-branch draft persistence (no longer requires a host-supplied adapter — it reads `apiClient` from the provider).
- **Plugins + secrets** — `usePluginCatalog`, `useProjectPlugins`, `useAttachPlugin`, `useDetachPlugin`, `useProjectSecrets`, `useUpsertProjectSecret`, `useDeleteProjectSecret`.
- **Agent (coding sessions)** — `useAgentSessions`, `useAgentSession`, `useCreateAgentSession`, `useSendAgentMessage`.

All hooks reject with the typed `CatamorphicError` envelope (discriminated by `code`: `unauthorized`, `not_found`, `validation`, `conflict`, `server_error`, `network`, `unknown`). Use `isCatamorphicError(err)` and switch on `err.code`; never branch on `err.message`. Shared OpenAPI-derived domain types (`Project`, `Run`, `RepoStatus`, `BranchInfo`, `ConflictEntry`, `PluginInfo`, `Secret`, `AgentSession`, …) live behind a single `@catamorphic/react/types` barrel.

## Component registry — `@catamorphic/registry`

`@catamorphic/registry` is a shadcn-style copy-paste registry. Items are JSON manifests that inline a single React component file; consumers run `npx shadcn add <host>/r/<item>.json` and the component drops into `components/catamorphic/`. The component then imports hooks from `@catamorphic/react` and primitives from `@catamorphic/ui` only — there's no runtime dependency on the registry itself.

Items shipped in phase 2:

- `catamorphic-provider` — a `<CatamorphicAppProvider>` that wraps `CatamorphicProvider` + `QueryClientProvider` and configures the api client.
- `projects-list` — table of projects + create-project dialog.
- `project-editor` — three-pane editor scaffold (file tree slot, editor slot, optional git-panel slot). Plug in monaco/codemirror via `renderEditor`.
- `file-explorer` — pure file tree.
- `git-panel` — branch/dirty/commits/deploy panel powered by `useProjectGit` + `useProjectCommits` + `useDeployProject`.
- `diff-drawer` — side drawer with a `renderDiff` slot so the host can plug in monaco-diff or codemirror-merge.
- `runs-panel` — list runs and trigger new ones (`useWorkflowRuns` + `useTriggerWorkflowRun`).
- `plugins-settings` — attach/detach plugins + edit secrets.

Catamorphic doesn't host the registry itself (it's embed-only). After `bun run build`, the built manifests live at `packages/registry/dist/r/<name>.json`. Hosts install them by pointing the shadcn CLI at the file directly, at `./node_modules/@catamorphic/registry/dist/r/<name>.json` once the host installs the package, or at a URL the host serves the directory from. To add a new item: drop a `src/<name>/<name>.tsx` + `registry-item.json` under `packages/registry/src/`, run `bun run build`, and re-install it in the host.

## Plugin packages (workflow SDKs)

Catamorphic can attach external packages (for example workflow SDKs) to a project so workflows can `import` plugin exports.

In v1, plugins are resolved from a local directory configured in root `.env`:

```bash
CATAMORPHIC_LOCAL_PLUGINS_DIR=/Users/you/Workspace/opencx/dashboard/packages
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
