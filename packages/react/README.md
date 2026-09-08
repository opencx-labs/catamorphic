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
  // Your own API origin: the session cookie rides along and the
  // fastify-plugin's `identity` resolver turns it into a catamorphic identity.
  baseUrl: "https://app.example.com",
  fetch: (input, init) => fetch(input, { ...init, credentials: "include" }),
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

### Projects

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
- `useOnParse({ files, workflowName, preferredFilePath? })` — ready-made `OnParseCallback` for `<WorkflowEditor onParse={…} />`. Wraps `useParseWorkflow` + `layoutGraph` and splices the live editor source into `files` on every call. Prefer this over inlining the parse+layout glue.

### Runs

This is one hook family for the canonical Run model. Workflow/Run capabilities
control which mutations and item views apply; there are no separate hook
families for boundaries or batch processing.

- `useRuns({ projectId, workflowName?, limit?, offset?, pollInterval? })`
- `useRun({ runId, pollInterval? })`
- `useTriggerRun({ projectId, workflowName })` — `mutateAsync({ input? })`
- `useCancelRun({ runId })` — `mutateAsync({ reason? })`
- `usePauseRunProcessing({ runId })`
- `useResumeRunProcessing({ runId })`
- `useSubmitRunInput({ runId, pauseId })` — `mutateAsync({ idempotencyKey, value })`
- `useRunItems({ run, workflowStepAttemptId, status?, limit?, offset?, pollInterval? })`
- `useRunItemSteps({ run, workflowStepAttemptId, itemId, pollInterval? })`
- `useEditorKeyboard()` — Escape-key handling for the editor's panels.

`workflowName` is optional so selection-driven screens can mount `useRuns`
before a workflow is selected; the query remains disabled until both IDs are
available.

`useTriggerRun` always executes an immutable production deployment. There is no
mutable-source test mode or separate Run family.

All server-backed run data uses one cache hierarchy rooted at
`["cat", "run"]`. Detail and list queries poll `pending`, `running`, and
`canceling` runs. A `waiting` run polls only while its phase is `child`; input
pauses and operator-paused runs rely on mutation updates or normal query
refetches instead of aggressive polling. Item and item-step queries derive
polling from their parent `Run` and selected batch scope, including waiting
scopes, instead of accepting a separate activity flag.

Workflow list and detail queries share the exported `workflowKeys` hierarchy.
File writes, deploys, commits, and branch checkouts invalidate the project
workflow prefix so both list summaries and singular workflow graphs refresh.

### Git

- `useProjectGit(projectId, { pollMs? })` — repo status (branch + dirty + ahead/behind)
- `useProjectBranches(projectId)`
- `useProjectCommits(projectId, { ref?, limit?, before? })`
- `useProjectConflicts(projectId)`
- `useCreateBranch(projectId)`
- `useCheckoutBranch(projectId)`
- `useCommitChanges(projectId)` — commit + deploy
- `useDeployProject(projectId)`
- `useProjectGitState({ projectId, baselineFiles })` — composite hook for multi-branch draft persistence (now reads `apiClient` from the provider; no host adapter required)

### Plugins

- `usePluginCatalog()`
- `useProjectPlugins(projectId)`
- `useAttachPlugin(projectId)`
- `useDetachPlugin(projectId)`

### Secrets

- `useProjectSecrets(projectId)`
- `useUpsertProjectSecret(projectId)` — `mutateAsync({ key, value })`
- `useDeleteProjectSecret(projectId)`

### Agent (coding sessions)

- `useAgentSessions(projectId)`
- `useAgentSession(projectId, sessionId)`
- `useCreateAgentSession(projectId)`
- `useSendAgentMessage(projectId, sessionId)`
- `useAgentChat(projectId, options)`
- `useAcknowledgeAgentSessionAttention(projectId)`
- `useArchiveAgentSession(projectId)`
- `useUnarchiveAgentSession(projectId)`

Session source, hierarchy, fork lineage, visibility, archive, attention,
activity, and todos come from the generated server contract. Archive is a
recursive server lifecycle operation and may return a typed confirmation
impact; it is not a client-local hidden flag. Latent delegated children should
remain attached to their parent until promoted.

### Workflow enablement

- `useWorkflowEnablements(projectId, workflowName?)`
- `usePreviewWorkflowEnablement(projectId)`
- `useCreateWorkflowEnablement(projectId)`
- `useUpdateWorkflowEnablement(projectId)`

Always preview and display the exact deployment, trigger, Environment, agent,
and connection requirements before binding a member's unattended-run consent
digest.

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
`activePanelTabAtom`, `showRunDialogAtom`, `lastTriggerDataAtom`,
`executionStateAtom`, `reactFlowNodesAtom`,
`reactFlowEdgesAtom`, `codeEditorReadOnlyAtom`, `aiLoadingAtom`,
and `collapsedNodeIdsAtom`.

## Error envelope

Every hook rejects with a typed `CatamorphicError` instead of a bare `Error`. Branch on `error.code`, never on `error.message`:

```tsx
import {
  CatamorphicError,
  isCatamorphicError,
  useDeployProject,
} from "@catamorphic/react";

const deploy = useDeployProject(projectId);

try {
  await deploy.mutateAsync();
} catch (err) {
  if (isCatamorphicError(err)) {
    switch (err.code) {
      case "conflict":
        return showConflictResolver(err.details);
      case "unauthorized":
        return redirectToLogin();
      case "validation":
      case "not_found":
      case "server_error":
      case "network":
      case "unknown":
        return toast(err.message);
    }
  }
  throw err;
}
```

`code` is the contract; `message` is the human-readable summary; `details` carries a typed payload (e.g. conflict files for `code: "conflict"`, validation issues for `code: "validation"`).

## Shared types — `@catamorphic/react/types`

OpenAPI-derived domain types live behind a single barrel so a copy-pasted registry component still typechecks against the canonical shape:

```ts
import type {
  Project,
  ProjectSummary,
  ProjectFilesList,
  Run,
  RunDetail,
  RunCapabilities,
  RunPause,
  BatchProgress,
  RunItem,
  RunItemStep,
  WorkflowStepAttempt,
  WorkflowCapabilities,
  RepoStatus,
  BranchInfo,
  CommitInfo,
  ConflictEntry,
  PluginInfo,
  Secret,
  AgentSession,
  AgentSessionDetail,
} from "@catamorphic/react/types";
```

Add new aliases here whenever a hook surfaces a new server shape — never re-declare an interface in the consuming file.

`WorkflowGraph` is the public HTTP/rendering graph and includes workflow
capabilities but not the parser-only execution descriptor. Local parser graphs
still include `execution`; `useOnParse` deliberately adapts the HTTP response
to the public graph rather than asserting the two shapes are identical.

## Run lifecycle

`<WorkflowEditor>` keeps only local run-dialog state. Its `onRun` callback
returns the canonical production `Run`, which is handed to the host's
`renderRunsPanel` slot and selected while the query cache refreshes.

`useEditorKeyboard()` wires the Escape-key behaviour (close the Runs pane,
then the detail panel). Mount it at most once per scope.

## Embedding with `@catamorphic/ui`

`@catamorphic/ui` consumes the atoms and hooks from this package. For the
simplest integration, mount `<CatamorphicProvider>` once at the root and
drop `<WorkflowEditor />` anywhere inside it — the editor sets up its own
`<WorkflowEditorScope>` implicitly. If you want to render host chrome that
reads the same atoms as the editor, wrap them together in an explicit
`<WorkflowEditorScope>` as shown in the example above.

See the monorepo root [`INTEGRATION.md`](../../INTEGRATION.md) for the full host integration story.
