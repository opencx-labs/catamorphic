---
name: ""
overview: ""
todos: []
isProject: false
---

# Catamorphic React bindings + UI — phase 1 + registry foundation

## Ideology

Three layers, one mental model:

```
@catamorphic/sdk     data + services          (already shipped — library-direct + HTTP)
@catamorphic/react   headless React bindings  (new — hooks, atoms, state, no markup)
@catamorphic/ui      heavy smart components   (existing — WorkflowCanvas, CodeEditor, DetailPanel)

registry.catamorphic.dev
                     shadcn-compatible copy-paste chrome
                     (project-editor, file-explorer, git-panel, runs-panel, diff-drawer,
                      plugins-settings, projects-list, ...)
                     consumed via `npx shadcn add <url>`
```

Hosts pick their depth:

- **Backend / Node only** → `@catamorphic/sdk`.
- **Custom UI with full visual control** → `@catamorphic/sdk` + `@catamorphic/react` + `@catamorphic/ui` for heavy wrappers. Host brings its own chrome.
- **Drop-in screens** → all three + shadcn `add` for the chrome they want.

The playground becomes the canonical shell: imports `@catamorphic/react` + `@catamorphic/ui` + consumes its own registry. Also doubles as the registry host (serves `/r/*.json`).

## React version policy

- **Floor: React 18.2.** — gives us `useId`, `useSyncExternalStore`, `useTransition`, concurrent Suspense.
- **Target: React 19.** — tested and recommended.
- **No React 17 support.** OpenCX and all Next 14+ hosts are already on 18/19. Dropping 17 unlocks TanStack Query v5, Radix v2, modern shadcn patterns.

Every package gets:

```json
"peerDependencies": {
  "react": "^18.2 || ^19",
  "react-dom": "^18.2 || ^19"
}
```

## Phase 1 scope (this plan)

- Create `@catamorphic/react`.
- Move state + hooks out of `@catamorphic/ui` into `@catamorphic/react`.
- Add `CatamorphicProvider` + TanStack Query peer dep.
- Add data hooks over `@catamorphic/api-client` (browser transport).
- Port `apps/playground` to consume hooks; delete Next `"use server"` data actions that duplicate hook logic.
- Set React 18.2 peer range across packages.

## Phase 2 scope (follow-up plan, not this one)

- Scaffold `packages/registry/` + shadcn `build` tooling.
- Move `apps/playground/src/components/*` into registry source files.
- Playground gains `/r/*` static route serving the built registry JSON.
- Ship initial registry items: `catamorphic-provider`, `projects-list`, `project-editor`, `file-explorer`, `git-panel`, `diff-drawer`, `runs-panel`, `plugins-settings`.
- Document `npx shadcn add https://playground.catamorphic.dev/r/<name>.json`.

## Package topology after phase 1

```
@catamorphic/sdk           server-side library-direct (today) + forthcoming /browser subpath
@catamorphic/api-client    OpenAPI types + openapi-fetch client (unchanged)
@catamorphic/react         NEW — hooks, atoms, provider
@catamorphic/ui            heavy wrappers; imports from @catamorphic/react (no internal atoms)
@catamorphic/parser        unchanged
```

Nothing forks. Nothing duplicates. `@catamorphic/ui` and registry items both read from the same `@catamorphic/react` hooks, so mixing npm and registry chrome is seamless.

## `@catamorphic/react` surface

### Provider

```tsx
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";

<CatamorphicProvider
  apiClient={createApiClient({ baseUrl: "/api/catamorphic", fetch })}
  queryClient={new QueryClient()}   // optional; creates one if omitted
>
  {children}
</CatamorphicProvider>
```

- `apiClient`: the `@catamorphic/api-client` instance. Host owns base URL + auth headers via its `fetch`.
- `queryClient`: TanStack Query client. Hosts that already have one pass it; otherwise we create an internal one.
- Identity is **not** passed here — the host's backend injects `X-Catamorphic-Tenant-Id` / `X-External-User-Id` in its own middleware (already the contract from the library-direct plan).

### Hooks (phase 1 minimum)

```ts
// Projects
const { data: projects, isLoading } = useProjects({ limit?, offset? });
const { data: project } = useProject(projectId);
const createProject = useCreateProject();
const updateProject = useUpdateProject(projectId);
const deleteProject = useDeleteProject();

// Files
const { data: files } = useProjectFiles(projectId);
const { data: content } = useProjectFile(projectId, path);
const writeFile = useWriteProjectFile(projectId);

// Workflows
const { data: workflows } = useWorkflows(projectId);
const { data: workflow } = useWorkflow(projectId, name);

// Canvas state (jotai atoms moved from @catamorphic/ui)
const [selectedNode, selectNode] = useSelectedNode();
const { nodes, edges } = useWorkflowGraphState(workflow);
```

### Deferred to phase 2 hooks

- `useProjectGit(projectId)` — branch, dirty, commits, deploy.
- `useWorkflowRuns(projectId, name)` — list + trigger + poll.
- `useProjectPlugins(projectId)` — attach, detach, list.
- `useProjectSecrets(projectId)` — CRUD.
- `useAgentSession()` — coding agent.

Same pattern (thin `useQuery` / `useMutation` over api-client), just more routes to cover. Adding them is mechanical once phase 1 lands.

## What moves in phase 1

| From | → | To |
|---|---|---|
| `packages/ui/src/atoms.ts` | → | `packages/react/src/atoms.ts` |
| `packages/ui/src/hooks/*` | → | `packages/react/src/hooks/*` |
| `apps/playground/src/lib/workflow-helpers.ts` | → | `packages/react/src/lib/workflow-helpers.ts` |
| `apps/playground/src/lib/find-workflow-definitions.ts` | → | `packages/react/src/lib/find-workflow-definitions.ts` |
| `apps/playground/src/lib/use-project-git-state.ts` | → | `packages/react/src/hooks/use-project-git-state.ts` (marked phase-2 hook, stays but re-homed) |

What stays where:

- `@catamorphic/ui` keeps `WorkflowCanvas`, `DetailPanel`, `CodeEditor`, `WorkflowEditor`, `Toolbar`, `AIBar`, `HistorySidebar`, `RunsPanel` (the in-ui one, not the registry one coming in phase 2), `RunTriggerDialog`, `styles.css`. All continue to work; they just import atoms/hooks from `@catamorphic/react` instead of local files.
- `apps/playground/src/components/*` stays put in phase 1. Phase 2 moves them into the registry.
- `apps/playground/src/lib/parse-action.ts`, `run-action.ts`, `ai-action.ts`, `project-actions.ts` — Next `"use server"` actions. Phase 1 deletes `parse-action.ts`, `run-action.ts`, `project-actions.ts` (replaced by hooks). `ai-action.ts` stays (AI is playground-only, out of scope for the library).

## Identity + transport (reuse existing)

Already decided in the library-direct plan:

- Browser `fetch` hits host's `/api/catamorphic/*` routes.
- Host's middleware injects `X-Catamorphic-Tenant-Id` + `X-External-User-Id`.
- Host's routes call the server-side `@catamorphic/sdk` with those identities.

`@catamorphic/react` never sees identity. It just talks to `apiClient` with whatever base URL the host configured.

## Data-fetching conventions

- **TanStack Query as peer dep.** OpenCX already uses it; it's the de facto standard. Every host that embeds us already has it.
- Every data hook is a thin wrapper:

  ```ts
  export function useProject(projectId: string) {
    const { apiClient } = useCatamorphic();
    return useQuery({
      queryKey: ["cat", "project", projectId],
      queryFn: async () => {
        const { data, error } = await apiClient.GET("/api/projects/{projectId}", {
          params: { path: { projectId } },
        });
        if (error) throw error;
        return data;
      },
      enabled: Boolean(projectId),
    });
  }
  ```

- Mutations invalidate `["cat", ...]` prefixes. Host's own query cache is untouched.
- All keys namespaced under `["cat", ...]` so coexistence with the host cache is clean.

## `@catamorphic/react` package skeleton

```
packages/react/
  package.json
  tsconfig.json
  tsup.config.ts
  src/
    index.ts              ← re-exports
    provider.tsx          ← <CatamorphicProvider>, useCatamorphic()
    atoms.ts              ← moved from @catamorphic/ui
    hooks/
      use-projects.ts
      use-project.ts
      use-project-files.ts
      use-project-file.ts
      use-workflows.ts
      use-workflow.ts
      use-write-project-file.ts
      use-create-project.ts
      use-update-project.ts
      use-delete-project.ts
      use-workflow-graph.ts   ← moved from @catamorphic/ui/src/hooks
      use-selected-node.ts    ← tiny atom hook, moved
    lib/
      workflow-helpers.ts
      find-workflow-definitions.ts
    types.ts
```

### package.json essentials

```json
{
  "name": "@catamorphic/react",
  "peerDependencies": {
    "@tanstack/react-query": "^5",
    "react": "^18.2 || ^19",
    "react-dom": "^18.2 || ^19"
  },
  "dependencies": {
    "@catamorphic/api-client": "workspace:*",
    "@catamorphic/parser": "workspace:*",
    "jotai": "^2"
  }
}
```

## `@catamorphic/ui` after phase 1

```json
{
  "peerDependencies": {
    "@catamorphic/react": "workspace:*",
    "@tanstack/react-query": "^5",
    "@xyflow/react": "^12",
    "@monaco-editor/react": "^4",
    "react": "^18.2 || ^19",
    "react-dom": "^18.2 || ^19"
  }
}
```

All React-Flow/Monaco deps stay here. Atoms import from `@catamorphic/react`.

## Playground port

- Replace `"use server"` `parse-action.ts` / `run-action.ts` / `project-actions.ts` with direct hook usage in client components.
- Wrap `app/layout.tsx` in `<CatamorphicProvider apiClient={...} queryClient={...}>`.
- Use `useProjects`, `useProject`, `useProjectFiles`, `useWorkflow` on the existing pages.
- `ai-action.ts` (OpenAI prompt) stays; AI remains playground-only for phase 1.

Net effect: playground becomes the reference integration — everything a host would do, minus the routing.

## Host integration after phase 1 (OpenCX)

```tsx
// dashboard/app/providers.tsx
import { CatamorphicProvider } from "@catamorphic/react";
import { createApiClient } from "@catamorphic/api-client";

const apiClient = createApiClient({
  baseUrl: "/api/catamorphic",      // OpenCX route that forwards to its embedded Fastify
  fetch: authedFetch,
});

export function Providers({ children }) {
  return (
    <QueryClientProvider client={queryClient}>
      <CatamorphicProvider apiClient={apiClient}>{children}</CatamorphicProvider>
    </QueryClientProvider>
  );
}
```

```tsx
// dashboard/app/workflows/[projectId]/page.tsx
"use client";
import { useProject, useProjectFiles } from "@catamorphic/react";
import { WorkflowEditor } from "@catamorphic/ui";

export default function Page({ params }: { params: { projectId: string } }) {
  const { data: project } = useProject(params.projectId);
  const { data: files }   = useProjectFiles(params.projectId);
  return project && files ? <WorkflowEditor project={project} files={files} /> : null;
}
```

No separate Catamorphic deployment. No iframe.

## Flow (mermaid)

```mermaid
flowchart LR
  host[Host React app] -->|renders| ui[Registry chrome<br/>& @catamorphic/ui]
  ui -->|hooks| react[@catamorphic/react]
  react -->|fetch| apiclient[@catamorphic/api-client]
  apiclient -->|HTTP| hostapi[Host /api/catamorphic/*]
  hostapi -->|in-process| sdk[@catamorphic/sdk]
  sdk --> core[@catamorphic/core]
  core --> db[(catamorphic schema)]
  core --> pm[ProjectManager]
```

## Files touched / created (phase 1)

**New**
- `packages/react/` (new package) — package.json, tsconfig, tsup, provider, atoms, hooks, lib
- `packages/react/README.md`

**Moved**
- `packages/ui/src/atoms.ts` → `packages/react/src/atoms.ts`
- `packages/ui/src/hooks/*` → `packages/react/src/hooks/*`
- `apps/playground/src/lib/workflow-helpers.ts` → `packages/react/src/lib/workflow-helpers.ts`
- `apps/playground/src/lib/find-workflow-definitions.ts` → `packages/react/src/lib/find-workflow-definitions.ts`
- `apps/playground/src/lib/use-project-git-state.ts` → `packages/react/src/hooks/use-project-git-state.ts`

**Refactored**
- `packages/ui/package.json` — add `@catamorphic/react` + `@tanstack/react-query` peer deps, tighten react peer range to `^18.2 || ^19`.
- `packages/ui/src/*` — update imports from local atoms/hooks to `@catamorphic/react`.
- `apps/playground/src/app/layout.tsx` — wrap in `<CatamorphicProvider>` + `<QueryClientProvider>`.
- `apps/playground/src/app/projects/*` — swap server-action calls for hooks.
- `apps/playground/package.json` — add `@catamorphic/react` + `@tanstack/react-query`.

**Deleted**
- `apps/playground/src/lib/parse-action.ts`
- `apps/playground/src/lib/run-action.ts`
- `apps/playground/src/lib/project-actions.ts`

**Docs**
- Update `INTEGRATION.md` — add "React bindings" section above the SDK section.
- Update `README.md` — package list with the three layers.
- New `packages/react/README.md` — hooks reference.

## Verification checklist

After the move:

1. `bunx turbo typecheck` — all packages pass.
2. `bunx turbo build` — all packages pass.
3. `bunx turbo test` — existing tests pass unchanged (move doesn't alter semantics).
4. Playground runs locally (`apps/playground dev`), all existing flows work: project list, create, open, edit file, parse graph, deploy, runs panel.
5. No new Next `"use server"` actions in the playground for project/file/workflow operations — hooks only.
6. `@catamorphic/react` has zero dependency on `@catamorphic/ui`, `@catamorphic/server`, `@catamorphic/core`, Fastify, or Kysely.

## What we explicitly are NOT doing in this plan

- **No registry yet.** Phase 2.
- **No `@catamorphic/sdk/browser` subpath.** Browser hooks consume `@catamorphic/api-client` directly. A `sdk/browser` scoped-client wrapper is a nice-to-have for non-React browser use; deferred.
- **No theming system.** `@catamorphic/ui` styles stay as-is. CSS variables + dark mode are phase 3.
- **No AI abstraction.** `ai-action.ts` stays in the playground. Hosts bring their own LLM; an `AIAdapter` interface is out of scope.
- **No new runs / plugins / git hooks.** Only project + file + workflow hooks in phase 1. The rest are mechanical additions once the pattern is in place.
- **No breaking changes to `@catamorphic/ui`'s public API.** Consumers of the existing exports see identical behavior; only internal imports change.
- **No React 17 shims.** 18.2 is the floor.
