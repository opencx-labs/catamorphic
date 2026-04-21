---
name: ""
overview: ""
todos: []
isProject: false
---

# Catamorphic React bindings + UI — phase 2 (registry + remaining hooks)

## Context: what phase 1 actually shipped

Phase 1 landed `@catamorphic/react` and migrated the playground onto it.
Concretely, the following are live on `main` today (commits `5c08cce`,
`af45d70`, and the follow-up `d61da4c`):

- **`@catamorphic/react`** — provider, jotai atoms, TanStack Query data hooks
  for projects, files, workflows, templates, plus the canvas/graph state
  hooks moved out of `@catamorphic/ui`. Peer-deps `react ^18.2 || ^19`,
  `react-dom ^18.2 || ^19`, `@tanstack/react-query ^5`.
- **`@catamorphic/ui`** — slimmed down to heavy wrappers; imports atoms and
  hooks from `@catamorphic/react`. No internal state. A later refactor
  (`d61da4c`) split the editor further: `WorkflowEditorScope` is now the
  explicit jotai + React Flow boundary, `WorkflowEditorChrome` is the
  inner editor without the scope wrapper, and the run lifecycle moved
  into `useWorkflowRunController` / Escape-key handling into
  `useEditorKeyboard` (both exported from `@catamorphic/react`). The
  duplicate atom / type re-exports that used to shadow `@catamorphic/react`
  from `@catamorphic/ui` have been removed — atoms and types have one
  canonical import path now.
- **`@catamorphic/api-client`** — `createApiClient({ baseUrl, fetch })` now
  accepts a custom `fetch` (so embedders can layer auth headers) and
  exposes `baseUrl` + `fetch` on the returned client (so callers can hit
  Fastify wildcard routes that openapi-fetch can't template).
- **`@catamorphic/parser`** — split into two entrypoints: the existing
  Node-only `.` (uses `ts-morph`, requires `node:fs`) and a new
  browser-safe `./layout` subpath that exports just `layoutGraph` + the
  shared `WorkflowGraph` / `WorkflowNode` types. Browsers MUST import from
  `@catamorphic/parser/layout`.
- **`@catamorphic/server`** — new `POST /api/playground/parse` route. Body
  is `{ files, workflowName, preferredFilePath? }`; response is
  `WorkflowGraph | null`. Server runs `parseWorkflowFromProject` +
  `layoutGraph` so the client never has to load `ts-morph`.
- **Schema realignment** — `WorkflowGraphSchema`, `WorkflowNodeSchema`,
  `ParameterInfoSchema`, etc. are now byte-for-byte aligned with the
  internal `@catamorphic/parser` types (enums for node/edge `type`,
  `optional` instead of `null`/`required`, `sourceRange` required,
  `metadata` is `Record<string,string>`). Server route handlers send the
  parser graph straight through with no manual mapping.
- **Playground** — wrapped in `<CatamorphicProvider>` +
  `<QueryClientProvider>`; all `"use server"` data actions
  (`parse-action.ts`, `run-action.ts`, `project-actions.ts`) deleted;
  pages use hooks (`useProject`, `useProjectFiles`, `useWorkflow`,
  `useParseWorkflow`, etc.); the authed `fetch` wrapper preserves the
  `Content-Type` header from `Request` inputs (fixes the 415 we hit
  because the wrapper was clobbering openapi-fetch's headers).

What's still ad-hoc in the playground (and is the natural target for
phase 2):

- `apps/playground/src/lib/api.ts` — bespoke `fetch()` calls for runs,
  git status/branches/commits/conflicts, plugins, secrets, deploy.
- `apps/playground/src/lib/use-project-git-state.ts` — host-injected
  `ProjectGitApi` adapter. The hook itself lives in `@catamorphic/react`
  but the playground still has to wire the adapter from `api.ts`.
- `apps/playground/src/components/*` — `git-panel.tsx`,
  `diff-drawer.tsx`, `file-explorer.tsx`, `playground-versions-panel.tsx`,
  `plugins-settings.tsx`, `project-editor.tsx`, `update-banner.tsx`,
  `monaco-*.tsx`, `multi-tab-monaco.tsx`. Phase 2 turns these into
  registry items.

## Phase 2 goals

Five tracks. Tracks 0a–0c are **prerequisites** that must land before the
first hook from Track A — they set the contract every later hook will
follow. Tracks A and B are the bulk of the work and run in parallel once
the prereqs are in.

0a. **Error envelope.** Define a single typed error shape
    (`CatamorphicError` with a discriminated `code`) and have every
    existing and new hook surface failures as that shape, instead of the
    current pattern where callers do `error.message.includes("…")`.
    Without this, every new hook in Track A will bake the bad pattern in
    deeper.

0b. **React testing harness.** Stand up the `vitest` + React Testing
    Library + MSW setup in `@catamorphic/react` so Track A hooks can
    ship with tests on day one. We currently have **zero** React tests;
    adding ~10 untested hooks would compound the gap.

0c. **Shared types entrypoint.** Move the OpenAPI-derived "domain"
    types (`Run`, `BranchInfo`, `CommitInfo`, `ConflictEntry`,
    `RepoStatus`, `PluginAttachment`, `Secret`, `AgentSession`, etc.)
    into a single `@catamorphic/react/types` (or a new
    `@catamorphic/types`) entrypoint so the SDK, the hooks, and the
    registry components all import the same names. Cheap one-time move,
    avoids divergence later.

1. **Hook coverage parity (Track A).** Add the data hooks the original
   plan deferred — runs, git, plugins, secrets, agent — so the
   playground (and any embedder) can stop hand-rolling fetches against
   `apps/playground/src/lib/api.ts`. Once these land, `api.ts` can be
   deleted and `use-project-git-state.ts` no longer needs an injected
   adapter.
2. **Registry foundation (Track B).** Stand up `packages/registry/` and
   start shipping shadcn-style "copy into your repo" components from
   the playground's `components/*`. Hosts that want drop-in chrome run
   `npx shadcn add https://playground.catamorphic.dev/r/<name>.json`.

## Track 0a — error envelope

Today every hook bubbles whatever `openapi-fetch` returns, so the
playground and the using-catamorphic skill both string-match on
`error.message`. The fix is a small typed envelope used by every hook.

### Shape

```ts
export type CatamorphicErrorCode =
  | "unauthorized"          // 401
  | "forbidden"              // 403
  | "not_found"              // 404
  | "conflict"               // 409, including merge conflicts
  | "validation"             // 400 with zod issues
  | "rate_limited"           // 429
  | "sandbox_unavailable"    // sandbox provider down / not configured
  | "network"                // fetch threw
  | "unknown";

export class CatamorphicError extends Error {
  readonly code: CatamorphicErrorCode;
  readonly status?: number;
  readonly details?: unknown;       // zod issues, server payload, etc.
  readonly cause?: unknown;
}
```

### Where it lives

- Class + type in `packages/react/src/lib/errors.ts`, re-exported from
  `@catamorphic/react`.
- A single `toCatamorphicError(response, body)` helper that every hook
  in `packages/react/src/hooks/*` runs through. New hooks call it; the
  phase-1 hooks (`use-project.ts`, `use-project-files.ts`,
  `use-workflow.ts`, etc.) get a one-time migration in the same PR
  that introduces the envelope.

### Acceptance

- Every `useQuery`/`useMutation` hook in `@catamorphic/react` has
  `error: CatamorphicError | null` (typed via the TanStack Query
  generic, not asserted).
- Zero `.message.includes(` matches in `apps/playground/src/**` after
  Track A.
- `using-catamorphic` skill documents the codes.

## Track 0b — React testing harness

`packages/react` ships ~10 hooks today and 0 tests. Track A roughly
doubles the hook count. We need the harness in before, not after.

### Setup

- Add `vitest`, `@testing-library/react`, `@testing-library/jest-dom`,
  `jsdom`, `msw` as devDependencies in `packages/react`.
- `packages/react/vitest.config.ts` with `environment: "jsdom"` and a
  `setupFiles` entry that registers `@testing-library/jest-dom` and the
  MSW server.
- `packages/react/src/test/setup.ts` — MSW `setupServer()` instance,
  `beforeAll(server.listen)`, `afterEach(server.resetHandlers)`,
  `afterAll(server.close)`.
- `packages/react/src/test/render.tsx` — `renderHook`/`render` helpers
  that wrap children in `<CatamorphicProvider>` +
  `<QueryClientProvider>` with a fresh `QueryClient` per test
  (`retry: false`, `gcTime: 0`).
- `packages/react/src/test/handlers.ts` — typed MSW handlers built off
  the `@catamorphic/api-client` `paths` map so refactors to the OpenAPI
  spec break tests at typecheck time, not at runtime.

### First tests (land with the harness)

- `use-project.test.ts` — happy path + 404 mapping to
  `CatamorphicError { code: "not_found" }`.
- `use-workflow-run-controller.test.ts` — optimistic insertion,
  successful reconcile, failure rollback, dialog open/close.
- `use-editor-keyboard.test.ts` — Escape closes history first, then
  panel, then no-ops.

### Acceptance

- `bun run test --filter @catamorphic/react` is green and runs in CI.
- Every Track A hook ships with at least one happy-path test and one
  error-mapping test in the same PR.

## Track 0c — shared types entrypoint

The runs/git/plugins/secrets types are about to be defined three times:
once in the OpenAPI-generated client, once in `@catamorphic/react`
hooks, once in the registry components (which will be copy-pasted into
host repos and lose the workspace symlink). Define them once.

### Shape

- New file `packages/react/src/types.ts` (or new package
  `@catamorphic/types` if we want to keep `react` truly headless — TBD
  in the implementing PR; default to `packages/react/src/types.ts`
  with a subpath export `@catamorphic/react/types` for now).
- Each type is a one-line alias over `paths[…]["get"]["responses"]…`
  from `@catamorphic/api-client`, the same pattern already used in
  `packages/react/src/lib/api-types.ts`.

```ts
export type Run        = paths["/api/projects/{projectId}/workflows/{name}/runs"]["get"]["responses"]["200"]["content"]["application/json"]["runs"][number];
export type BranchInfo = paths["/api/projects/{projectId}/git/branches"]["get"]["responses"]["200"]["content"]["application/json"]["branches"][number];
// …etc
```

### Acceptance

- `@catamorphic/react` re-exports every domain type used by Track A
  hooks from a single barrel.
- The registry items in Track B import these types via
  `@catamorphic/react` (or `@catamorphic/types`), not from the
  generated client directly, so a copy-pasted registry component still
  compiles in a host repo that only depends on `@catamorphic/react`.
- The legacy hand-rolled `Run`, `BranchInfo`, etc. interfaces in
  `apps/playground/src/lib/api.ts` are deleted (already in Track A's
  scope, but the canonical replacement is now defined here).

## Track A — remaining hooks in `@catamorphic/react`

Pattern is the same as phase 1: thin `useQuery` / `useMutation` over
`apiClient`, keys namespaced under `["cat", ...]`, mutations invalidate
their parent query. **Every hook below must additionally:**

- Surface failures as `CatamorphicError` (Track 0a). The TanStack Query
  generic gets `error: CatamorphicError | null`; raw `openapi-fetch`
  errors are mapped via `toCatamorphicError` before they leave the
  hook.
- Import its return / argument types from the shared types barrel
  (Track 0c). No re-declaring `Run`, `BranchInfo`, etc. inside the
  hook file.
- Ship with a happy-path test and an error-mapping test in the same PR
  using the harness from Track 0b.

### Hooks to add

```ts
// Runs
useWorkflowRuns(projectId, name, { limit?, offset? })
useWorkflowRun(projectId, name, runId)
useTriggerWorkflowRun(projectId, name)        // mutation; invalidates the list
useCancelWorkflowRun(projectId, name, runId)  // mutation

// Project git
useProjectGit(projectId)                       // status + branch + dirty
useProjectBranches(projectId)
useProjectCommits(projectId, branch)
useProjectConflicts(projectId)
useCreateBranch(projectId)                     // mutation
useCheckoutBranch(projectId)                   // mutation
useCommitChanges(projectId)                    // mutation
useDeployProject(projectId)                    // mutation

// Plugins
useProjectPlugins(projectId)
useAttachPlugin(projectId)                     // mutation
useDetachPlugin(projectId)                     // mutation

// Secrets
useProjectSecrets(projectId)
useUpsertProjectSecret(projectId)              // mutation
useDeleteProjectSecret(projectId)              // mutation

// Coding agent
useAgentSession(projectId)                     // start/poll/stream
useSendAgentMessage()                          // mutation
```

Each hook gets the same shape used in phase 1 (see
`packages/react/src/hooks/use-project.ts` for the canonical example).

### Refactor `useProjectGitState` to drop the adapter

`packages/react/src/hooks/use-project-git-state.ts` currently takes a
host-injected `ProjectGitApi` because git endpoints weren't covered by
hooks in phase 1. With the new git hooks above, this hook can call
`apiClient` directly via `useCatamorphic()` and the
`UseProjectGitStateOptions.api` parameter becomes optional (kept for
backwards compatibility for one minor version, then removed).

### Delete `apps/playground/src/lib/api.ts`

Once every call site uses a hook:

- Replace the legacy fetches in `apps/playground/src/components/git-panel.tsx`,
  `diff-drawer.tsx`, `playground-versions-panel.tsx`, `plugins-settings.tsx`,
  `update-banner.tsx`, and `workflow-page-client.tsx` (runs panel) with
  the new hooks.
- Drop `api.ts`. Drop the legacy `Run`, `BranchInfo`, `CommitInfo`,
  `ConflictEntry`, `RepoStatus` interfaces — consumers import the
  canonical equivalents from the Track 0c shared types barrel
  (`@catamorphic/react/types`), same pattern as `WorkflowGraph` in
  phase 1.
- Drop the `api` prop on `useProjectGitState` calls in the playground.

## Track B — registry foundation

### Package skeleton

```
packages/registry/
  package.json
  tsconfig.json
  registry.json              ← shadcn registry index (auto-generated)
  src/
    catamorphic-provider/
      registry-item.json
      catamorphic-provider.tsx
    projects-list/
      registry-item.json
      projects-list.tsx
    project-editor/
      registry-item.json
      project-editor.tsx
    file-explorer/
      registry-item.json
      file-explorer.tsx
    git-panel/
      registry-item.json
      git-panel.tsx
    diff-drawer/
      registry-item.json
      diff-drawer.tsx
    runs-panel/
      registry-item.json
      runs-panel.tsx
    plugins-settings/
      registry-item.json
      plugins-settings.tsx
  scripts/
    build.ts                 ← compiles src/**/registry-item.json into /r/*.json
```

Build output lives at `packages/registry/dist/r/*.json` and is what
`apps/playground` serves over HTTP.

### `registry-item.json` shape (per shadcn spec)

```json
{
  "name": "git-panel",
  "type": "registry:component",
  "dependencies": ["lucide-react"],
  "registryDependencies": ["@catamorphic/react"],
  "files": [
    {
      "path": "components/catamorphic/git-panel.tsx",
      "type": "registry:component"
    }
  ]
}
```

Components reference `@catamorphic/react` and `@catamorphic/ui` as
runtime peer deps the host already has installed; the registry only
copies the chrome (markup, lucide icons, tailwind classes), not the
hooks.

### Playground hosts the registry

- New static route `apps/playground/src/app/r/[name]/route.ts` that
  reads from `packages/registry/dist/r/<name>.json` and returns the
  payload with `Content-Type: application/json` + permissive CORS.
- `turbo.json` adds `@catamorphic/registry#build` as a dependency of
  `@catamorphic/playground#build` so deploys ship a fresh registry.
- The playground itself is migrated to import from
  `apps/playground/src/components/catamorphic/*` (the post-shadcn-add
  layout) so we eat our own dog food.

### Initial items to ship (priority order)

1. `catamorphic-provider` — minimal example wiring `CatamorphicProvider`
   + `QueryClientProvider`, parameterised on `baseUrl` + `fetch`.
2. `projects-list` — table of projects + create dialog.
3. `project-editor` — split-pane editor (canvas + monaco) using
   `WorkflowEditor` from `@catamorphic/ui`.
4. `file-explorer` — tree view with create/rename/delete.
5. `git-panel` — branch + dirty + commits + deploy buttons.
6. `diff-drawer` — monaco diff viewer.
7. `runs-panel` — list, trigger, follow.
8. `plugins-settings` — attach/detach + secrets editor.

## Files touched / created (phase 2)

**New**

- `packages/react/src/lib/errors.ts` — `CatamorphicError` +
  `toCatamorphicError` (Track 0a)
- `packages/react/src/types.ts` — shared OpenAPI-derived domain types
  (Track 0c); subpath export `@catamorphic/react/types` added to
  `packages/react/package.json`
- `packages/react/vitest.config.ts` — vitest + jsdom config (Track 0b)
- `packages/react/src/test/setup.ts` — MSW server, RTL matchers
  (Track 0b)
- `packages/react/src/test/render.tsx` — `renderHook`/`render`
  helpers wrapping `CatamorphicProvider` + `QueryClientProvider`
  (Track 0b)
- `packages/react/src/test/handlers.ts` — typed MSW handlers off the
  api-client `paths` map (Track 0b)
- `packages/react/src/hooks/__tests__/use-project.test.ts`
- `packages/react/src/hooks/__tests__/use-workflow-run-controller.test.ts`
- `packages/react/src/hooks/__tests__/use-editor-keyboard.test.ts`
- One `*.test.ts` co-located per Track A hook below
- `packages/registry/` — full package
- `apps/playground/src/app/r/[name]/route.ts`
- `packages/react/src/hooks/use-workflow-runs.ts`
- `packages/react/src/hooks/use-workflow-run.ts`
- `packages/react/src/hooks/use-trigger-workflow-run.ts`
- `packages/react/src/hooks/use-cancel-workflow-run.ts`
- `packages/react/src/hooks/use-project-git.ts`
- `packages/react/src/hooks/use-project-branches.ts`
- `packages/react/src/hooks/use-project-commits.ts`
- `packages/react/src/hooks/use-project-conflicts.ts`
- `packages/react/src/hooks/use-create-branch.ts`
- `packages/react/src/hooks/use-checkout-branch.ts`
- `packages/react/src/hooks/use-commit-changes.ts`
- `packages/react/src/hooks/use-deploy-project.ts`
- `packages/react/src/hooks/use-project-plugins.ts`
- `packages/react/src/hooks/use-attach-plugin.ts`
- `packages/react/src/hooks/use-detach-plugin.ts`
- `packages/react/src/hooks/use-project-secrets.ts`
- `packages/react/src/hooks/use-upsert-project-secret.ts`
- `packages/react/src/hooks/use-delete-project-secret.ts`
- `packages/react/src/hooks/use-agent-session.ts`
- `packages/react/src/hooks/use-send-agent-message.ts`

**Modified**

- `packages/react/src/index.ts` — re-export new hooks, new types,
  `CatamorphicError`, and the shared types barrel
- `packages/react/src/lib/api-types.ts` — add aliases for runs / git /
  plugins / secrets / agent OpenAPI paths (consumed by the Track 0c
  shared types barrel)
- `packages/react/src/hooks/use-project.ts` and the rest of the
  phase-1 hooks — migrate to surface `CatamorphicError` (Track 0a)
- `packages/react/package.json` — add `vitest`,
  `@testing-library/react`, `@testing-library/jest-dom`, `jsdom`,
  `msw` dev deps; add `test` script; add `./types` subpath export
- `packages/react/src/hooks/use-project-git-state.ts` — call `apiClient`
  directly; mark `options.api` deprecated/optional
- `apps/playground/src/components/git-panel.tsx` — use git hooks
- `apps/playground/src/components/diff-drawer.tsx` — use git hooks
- `apps/playground/src/components/playground-versions-panel.tsx` — use
  git hooks
- `apps/playground/src/components/plugins-settings.tsx` — use plugin +
  secret hooks
- `apps/playground/src/components/update-banner.tsx` — use deploy hook
- `apps/playground/src/app/projects/[projectId]/workflows/[name]/workflow-page-client.tsx`
  — use runs hooks
- `apps/playground/src/lib/use-project-git-state.ts` — drop file (the
  hook moves entirely into `@catamorphic/react`); thin re-export only
  if any other consumer survives
- `apps/playground/package.json` — add `@catamorphic/registry` as a
  workspace dep
- `turbo.json` — wire `@catamorphic/registry#build`

**Deleted**

- `apps/playground/src/lib/api.ts`

**Docs**

- `INTEGRATION.md` — append "Registry" section with the
  `npx shadcn add` flow and a list of items
- `packages/react/README.md` — document the new hooks, the
  `CatamorphicError` envelope (with the code table), and the
  `@catamorphic/react/types` barrel
- `packages/registry/README.md` — new file: how to build, how to add
  items, registry-item conventions
- `.cursor/skills/using-catamorphic/SKILL.md` — add an "Error
  handling" section keyed off `CatamorphicError.code`; remove every
  `error.message.includes(...)` example

## Things explicitly NOT in phase 2

- **No theming system.** Components ship with plain Tailwind classes
  using OpenCX-style tokens. CSS variables / dark-mode story is phase 3.
- **No AI hook abstraction.** `apps/playground/src/lib/ai-action.ts`
  stays. Hosts bring their own LLM; an `AIAdapter` is phase 3.
- **No `@catamorphic/sdk/browser` subpath.** Browser hooks keep
  consuming `@catamorphic/api-client` directly. Will revisit if
  registry items grow non-React (e.g. Solid) bindings.
- **No registry CDN / non-playground host.** The playground is the
  registry host for now. A dedicated `registry.catamorphic.dev` is a
  deploy concern, not a code concern.
- **No backend changes for the runs/git/plugins/secrets endpoints.** All
  routes already exist in `@catamorphic/server`. Phase 2 only consumes
  them.
- **No SDK feature parity work.** The error envelope and shared types
  are designed so the SDK can adopt them later, but actually wiring
  `forTenant().runs / .git / .plugins / .secrets` into
  `@catamorphic/sdk` is phase 3.
- **No promotion of the shared types into a standalone
  `@catamorphic/types` package.** The Track 0c barrel ships from
  `@catamorphic/react/types` for now; extracting it is a future move
  if/when a non-React consumer (Solid bindings, the SDK) needs it.

## Verification checklist (phase 2)

After all tracks:

1. `bunx turbo typecheck` — all packages pass. `@catamorphic/react`
   exports `CatamorphicError` and `@catamorphic/react/types` resolves.
2. `bunx turbo build` — all packages including `@catamorphic/registry`
   pass.
3. `bunx turbo test` — existing tests pass; new hook tests cover
   happy + error paths; `bun run test --filter @catamorphic/react`
   runs in CI under jsdom + MSW.
4. `rg "error\.message\.includes\(" apps packages` returns zero matches
   (Track 0a contract upheld).
5. `rg "interface (Run|BranchInfo|CommitInfo|ConflictEntry|RepoStatus)\b" apps packages`
   returns only the `@catamorphic/react/types` definitions (Track 0c
   contract upheld).
6. Playground runs locally, every flow now driven by hooks (no
   imports from `apps/playground/src/lib/api.ts` — the file no longer
   exists).
7. `curl http://localhost:8501/r/git-panel.json` returns the registry
   payload.
8. In a scratch Next 15 app: `npx shadcn add http://localhost:8501/r/git-panel.json`
   copies the file into `components/catamorphic/`, the file references
   `@catamorphic/react` + `@catamorphic/ui` only, and renders with no
   modifications.
9. OpenCX dashboard wires `<CatamorphicProvider>` once and consumes at
   least one registry item end-to-end.

## Suggested PR ordering

1. **PR 1 (Track 0a + 0c).** `CatamorphicError` + `toCatamorphicError`,
   shared types barrel, migrate the existing phase-1 hooks. No new
   hooks yet. Small, isolated, sets the contract.
2. **PR 2 (Track 0b).** Vitest + RTL + MSW harness, plus tests for the
   phase-1 hooks and the two hooks that landed in `d61da4c`
   (`useWorkflowRunController`, `useEditorKeyboard`). No new product
   code.
3. **PRs 3–6 (Track A).** Runs hooks, then git hooks (+
   `useProjectGitState` refactor), then plugins, then secrets / agent.
   Each PR ships its hooks, its tests, and migrates the playground
   call sites it covers. The `apps/playground/src/lib/api.ts` file
   shrinks each PR; the last PR deletes it.
4. **PRs 7–N (Track B).** Registry skeleton first (just
   `catamorphic-provider` to validate the build + serve flow), then
   one PR per registry item in the priority order above.
