# @catamorphic/react

Headless React bindings for Catamorphic: a provider, jotai atoms for canvas/panel state, and TanStack Query hooks over `@catamorphic/api-client`. Zero smart components — pair with `@catamorphic/ui` when you want the drop-in editor, or build your own UI on top.

## Install

```bash
pnpm add @catamorphic/react @catamorphic/api-client @tanstack/react-query react react-dom
```

Peer versions: React `^18.2 || ^19`, TanStack Query `^5`.

## Provider

```tsx
import { createApiClient } from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";

const queryClient = new QueryClient();

const apiClient = createApiClient({
  baseUrl: "https://catamorphic.example.com",
  fetch: async (input, init) => {
    const headers = new Headers(init?.headers);
    headers.set("X-Catamorphic-Tenant-Id", currentOrgId);
    headers.set("X-External-User-Id", currentUserId);
    return fetch(input, { ...init, headers });
  },
});

export function Providers({ children }: { children: React.ReactNode }) {
  return (
    <CatamorphicProvider apiClient={apiClient} queryClient={queryClient}>
      {children}
    </CatamorphicProvider>
  );
}
```

If you omit `queryClient`, the provider creates one internally so standalone apps still work.

## Hooks

### Projects + templates

- `useTemplates()`
- `useProjects({ limit?, offset? })`
- `useProject(projectId)`
- `useCreateProject()`
- `useUpdateProject(projectId)`
- `useDeleteProject()`

### Files

- `useProjectFiles(projectId)`
- `useProjectFile(projectId, path)`
- `useWriteProjectFile(projectId)`

### Workflows

- `useWorkflows(projectId, { ref? })`
- `useWorkflow(projectId, name, { ref? })`
- `useParseWorkflow()` — mutation that round-trips draft source through the server-side parser (browsers can't load ts-morph directly)

### Run lifecycle

- `useWorkflowRunController({ onTriggerRun })` — optimistic run list + canvas execution-state machine. Used internally by `<WorkflowEditor>`; host chrome can use it directly.
- `useEditorKeyboard()` — Escape-key handling for the editor's panels.

### Canvas + panel state (jotai)

The editor's canvas, selection, and panel state live in jotai atoms. Atoms
are *scoped* — they live inside a `<WorkflowEditorScope>` from
`@catamorphic/ui` so multiple editors can render independently without
bleeding state into each other.

Host chrome (custom toolbars, inspectors, sibling panels) that wants to
read the same atoms must live inside the *same* scope as the editor:

```tsx
import {
  WorkflowEditor,
  WorkflowEditorScope,
} from "@catamorphic/ui";
import {
  graphAtom,
  selectedNodeAtom,
} from "@catamorphic/react";
import { useAtomValue } from "jotai";

function Inspector() {
  const selected = useAtomValue(selectedNodeAtom);
  return selected ? <pre>{selected.label}</pre> : null;
}

export function Editor() {
  return (
    <WorkflowEditorScope>
      <WorkflowEditor ... />
      <Inspector />
    </WorkflowEditorScope>
  );
}
```

`<WorkflowEditor>` mounts its own scope if none is present above it, so the
simple "just drop in an editor" case keeps working with no extra wrapping.
The scope is idempotent — nesting one inside another reuses the ambient
store unless you pass `isolate` to force a fresh one (useful for
side-by-side editors that must not share selection).

Atoms exposed for host chrome: `codeAtom`, `graphAtom`, `selectedNodeIdAtom`,
`selectedNodeAtom`, `panelVisibilityAtom`, `rightPanelOpenAtom`,
`activePanelTabAtom`, `historySidebarOpenAtom`, `activeHistoryTabAtom`,
`runsAtom`, `activeRunIdAtom`, `isRunningAtom`, `showRunDialogAtom`,
`lastTriggerDataAtom`, `executionStateAtom`, `reactFlowNodesAtom`,
`reactFlowEdgesAtom`, `codeEditorReadOnlyAtom`, `aiLoadingAtom`,
`loadMoreRunsAtom`.

### Git / deploy (phase-1 adapter)

`useProjectGitState(...)` is headless and takes a `ProjectGitApi` adapter. In phase 2 it will collapse to use the typed api-client directly once the git routes land in the OpenAPI schema.

```tsx
import { type ProjectGitApi, useProjectGitState } from "@catamorphic/react";

const gitApi: ProjectGitApi = {
  getStatus: (projectId) => myApi.getStatus(projectId),
  // …
};

const state = useProjectGitState({
  projectId,
  baselineFiles,
  api: gitApi,
});
```

## Run lifecycle

`useWorkflowRunController({ onTriggerRun })` owns the optimistic run list,
canvas execution-state painting, history sidebar toggle, and failure
cleanup. Mount it anywhere inside a `<WorkflowEditorScope>` (the editor
mounts it internally; you can also use it from custom chrome that wants the
same UX as the drop-in editor):

```tsx
const { submit, openDialog, isRunning } = useWorkflowRunController({
  onTriggerRun: async (triggerData) => {
    const res = await apiClient.POST(
      "/api/projects/{projectId}/workflows/{name}/runs",
      { params: { path: { projectId, name } }, body: { triggerData } },
    );
    return { /* …TriggerRunResult shape… */ };
  },
});
```

`useEditorKeyboard()` wires the Escape-key behaviour (close history
sidebar, then detail panel). Mount it at most once per scope.

## Embedding with `@catamorphic/ui`

`@catamorphic/ui` consumes the atoms and hooks from this package. For the
simplest integration, mount `<CatamorphicProvider>` once at the root and
drop `<WorkflowEditor />` anywhere inside it — the editor sets up its own
`<WorkflowEditorScope>` implicitly. If you want to render host chrome that
reads the same atoms as the editor, wrap them together in an explicit
`<WorkflowEditorScope>` as shown in the example above.

See the monorepo root [`INTEGRATION.md`](../../INTEGRATION.md) for the full host integration story.
