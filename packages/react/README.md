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

### Canvas + panel state (jotai)

All atoms are re-exported so `@catamorphic/ui` and host UIs share one store:

```tsx
import { useAtom } from "jotai";
import {
  codeAtom,
  graphAtom,
  selectedNodeIdAtom,
  panelVisibilityAtom,
  useSelectedNode,
  useWorkflowGraph,
} from "@catamorphic/react";
```

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

## Embedding with `@catamorphic/ui`

`@catamorphic/ui` re-exports every atom and type from this package and renders against the shared store. Mount `CatamorphicProvider` once at the root, then drop `<WorkflowEditor />` / `<WorkflowCanvas />` anywhere inside it.

See the monorepo root [`INTEGRATION.md`](../../INTEGRATION.md) for the full host integration story.
